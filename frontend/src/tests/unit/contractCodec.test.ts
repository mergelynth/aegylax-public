import { encodeAbiParameters } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  decodeChainParticipant,
  ethToWei,
  packDefensePoint,
  toActivityMap,
  toAttackStatus,
  toDefenseResult,
  toLobbyConfig,
  toLobbyStatus,
  toOutcome,
  toTrajectory,
  unpackDefensePoint,
  weiToEth,
  wuToKm,
  type ChainDefenseAttempt,
  type ChainGameParams,
  type ChainLobbyConfig,
  type ChainOutcome,
  type ChainTrajectory,
} from '../../blockchain/contract/codec'
import { decodeProbeHint, MAX_IMPACT_DELTA_MICRO_RAD, MAX_LAUNCH_OFFSET_MICRO_RAD, packProbeHint } from '../../blockchain/contract/recon'
import { ATTACK_BIAS_MICRO_RAD, BASE_CONE_DEGREES } from '../../game/recon'
import type { Address, DefenseAttempt, Hash } from '../../game/types'
import { buildWorld } from '../../game/world'

const params: ChainGameParams = {
  gridColumns: 10,
  gridRows: 5,
  sectorSpanKm: 1000,
  interceptRadiusMilliSectors: 140,
  epochBlocks: 150,
  defenseSpeedKmPerBlock: 250,
  probeConeMicroRad: 802_851,
  revealGraceBlocks: 5000,
  minPlayers: 2,
  maxPlayers: 20,
  maxProbesPerPlayer: 6,
  freeProbes: 3,
  maxCreatorFeeBps: 500,
  minRegistrationSeconds: 0,
  maxRegistrationSeconds: 2_592_000,
  minEntryFee: 10n ** 15n,
  maxEntryFee: 10n ** 17n,
  minStartPrizePool: 10n ** 16n,
  probePrice: 2n * 10n ** 15n,
  protocolJoinFee: 5n * 10n ** 14n,
}

const config: ChainLobbyConfig = {
  name: 'Operation Codec',
  minPlayers: 2,
  maxPlayers: 10,
  entryPrice: 10n ** 16n,
  registrationDeadline: 1_700_000_000n,
  registrationDeadlineBlock: 45_000_000n,
  startPrizePool: 5n * 10n ** 16n,
  creatorFeeBps: 500,
}

const world = buildWorld({ columns: 10, rows: 5 }, 1000)

/**
 * The chain speaks in integers and the game speaks in ETH, kilometres and
 * radians. These are the conversions in between — the place a rounding
 * mistake would turn into a wrong payment or a wrong interception.
 */
describe('contract codec', () => {
  /**
   * The domain model carries money as an ordinary number of ETH, so a wei
   * amount with more significant digits than a double can hold does not
   * survive the round trip. Every price a creator can actually set does,
   * and the client never *pays* from a round-tripped figure anyway — join
   * and probe payments are taken from the chain's own integers, because the
   * contract checks them to the wei.
   */
  it('round-trips the prices an operation can actually be configured with', () => {
    expect(ethToWei(0.002)).toBe(2n * 10n ** 15n)
    expect(weiToEth(2n * 10n ** 15n)).toBe(0.002)

    for (const wei of [10n ** 15n, 10n ** 16n, 5n * 10n ** 14n, 123_456_000_000_000_000n]) {
      expect(ethToWei(weiToEth(wei))).toBe(wei)
    }
  })

  it('round-trips a Defense Point through the single word the contract stores', () => {
    const point = { sector: { column: 3, row: 2 }, offsetX: 0.25, offsetY: 0.75 }
    const packed = packDefensePoint(point, world)
    const restored = unpackDefensePoint(packed, world)

    expect(restored.sector).toEqual(point.sector)
    expect(restored.offsetX).toBeCloseTo(point.offsetX, 5)
    expect(restored.offsetY).toBeCloseTo(point.offsetY, 5)
  })

  it('packs coordinates into the low and high halves the contract unpacks', () => {
    const packed = packDefensePoint({ sector: { column: 0, row: 0 }, offsetX: 0, offsetY: 0 }, world)
    expect(packed).toBe(0n)

    const corner = packDefensePoint({ sector: { column: 9, row: 4 }, offsetX: 1, offsetY: 1 }, world)
    expect(wuToKm(corner & ((1n << 64n) - 1n))).toBe(10_000)
    expect(wuToKm(corner >> 64n)).toBe(5000)
  })

  it('maps the protocol-owned half of a lobby config from the frozen snapshot', () => {
    const mapped = toLobbyConfig(config, params)

    expect(mapped.participation.entryPrice).toBe(0.01)
    expect(mapped.participation.deadline).toBe(1_700_000_000_000)
    expect(mapped.economics.creatorFeePercent).toBe(5)
    expect(mapped.economics.protocolJoinFee).toBe(0.0005)
    expect(mapped.attack.epochBlocks).toBe(150)
    expect(mapped.attack.interceptionRadiusSectors).toBe(0.14)
    expect(mapped.attack.sectorSpanKm).toBe(1000)
  })

  /**
   * Recon terms come off the params and never off the lobby (ТЗ §3).
   *
   * Worth its own test because getting it wrong is silent: viem keys a
   * decoded struct by the ABI's parameter names, so reading `probePrice`
   * from a config that stopped carrying it yields `undefined` rather than a
   * type error — and `undefined` wei is what the Recon panel was pricing
   * probes at and what `buyProbes` was being sent.
   */
  it('reads the recon allowance and price from the protocol, not the lobby', () => {
    const mapped = toLobbyConfig(config, params)

    expect(mapped.drones.freeCount).toBe(3)
    expect(mapped.drones.maxCount).toBe(6)
    expect(mapped.drones.price).toBe(0.002)
    expect(Number.isFinite(mapped.drones.price)).toBe(true)
  })

  it('prices recon off the live params, not the frozen snapshot buyProbes ignores', () => {
    const live = { ...params, probePrice: 2n * 10n ** 14n, freeProbes: 1, maxProbesPerPlayer: 4 }
    const mapped = toLobbyConfig(config, params, live)

    expect(mapped.drones.price).toBe(0.0002)
    expect(mapped.drones.freeCount).toBe(1)
    expect(mapped.drones.maxCount).toBe(4)
    // Geometry and fees stay on the snapshot this operation was created under.
    expect(mapped.attack.epochBlocks).toBe(150)
    expect(mapped.economics.protocolJoinFee).toBe(0.0005)
  })

  it('collapses the contract\'s COMPLETED state into the domain\'s RESOLVED', () => {
    expect(toAttackStatus(1)).toBe('PENDING')
    expect(toAttackStatus(2)).toBe('LAUNCHED')
    // Completed (flight over, not yet revealed) and resolved both read as
    // "over" to a player; whether the geometry is public is a separate fact.
    expect(toAttackStatus(3)).toBe('RESOLVED')
    expect(toAttackStatus(4)).toBe('RESOLVED')
    expect(toLobbyStatus(1)).toBe('OPEN')
    expect(toLobbyStatus(5)).toBe('CANCELLED')
  })

  it('converts a trajectory into kilometres and radians', () => {
    const traj: ChainTrajectory = {
      startX: 1_000_000_000n,
      startY: 0n,
      targetX: 5_000_000_000n,
      targetY: 4_000_000_000n,
      impactAngleMicroRad: -1_570_796n,
      launchBearingMicroRad: -1_047_198n,
      lengthWu: 5_656_854_249n,
      speedWuPerBlock: 37_712_361n,
    }
    const mapped = toTrajectory(traj)

    expect(mapped.pointA).toEqual({ x: 1000, y: 0 })
    expect(mapped.pointB).toEqual({ x: 5000, y: 4000 })
    expect(mapped.impactAngleRadians).toBeCloseTo(-Math.PI / 2, 5)
    expect(mapped.launchBearingRadians).toBeCloseTo(-1.047198, 5)
    expect(mapped.lengthKm).toBeCloseTo(5656.85, 2)
  })

  it('derives interception progress from the block the threat entered the radius', () => {
    const outcome: ChainOutcome = {
      intercepted: true,
      interceptX: 3_000_000_000n,
      interceptY: 2_000_000_000n,
      // Half way through a 150-block flight that launched at block 1000.
      interceptionBlockScaled: 1_075_000_000n,
      winningArrivalBlockScaled: 1_010_000_000n,
      interceptRadiusWu: 320_000_000n,
      winners: ['0x1111111111111111111111111111111111111111' as Address],
      rewardPerWinner: 5n * 10n ** 16n,
      resolvedAtBlock: 1160n,
      resolvedAtTimestamp: 1_700_000_500n,
      revealedBy: '0x2222222222222222222222222222222222222222' as Address,
    }

    const mapped = toOutcome('0xattack', outcome, 150, 1000)
    expect(mapped.intercepted).toBe(true)
    expect(mapped.interceptionBlock).toBe(1075)
    expect(mapped.interceptionProgress).toBeCloseTo(0.5, 6)
    expect(mapped.rewardPerWinner).toBe(0.05)
    expect(mapped.interceptionRadiusKm).toBe(320)
    expect(mapped.resolvedAtTimestamp).toBe(1_700_000_500_000)
  })

  /**
   * ТЗ §5 draws a distinction the result screen has to reflect: a defense
   * can be in exactly the right place and still fail, because it arrived
   * after the threat went by. The two failures read differently.
   */
  it('distinguishes a miss in space from a miss in time', () => {
    const base: ChainDefenseAttempt = {
      participant: '0x1111111111111111111111111111111111111111' as Address,
      pointHandle: '0x00' as Hash,
      submittedAtBlock: 1000n,
      submittedAtTimestamp: 1_700_000_000n,
      revealed: true,
      x: 0n,
      y: 0n,
      arrivalBlockScaled: 1_120_000_000n,
      intercepted: false,
      interceptionBlockScaled: 0n,
      interceptX: 0n,
      interceptY: 0n,
      missDistanceWu: 10_000_000n, // 10 km — well inside a 320 km radius
      isWinner: false,
      maskedHandle: '0x00' as Hash,
    }

    const tooLate = toDefenseResult(
      'a',
      {
        ...base,
        interceptionBlockScaled: 1_075_000_000n,
        arrivalBlockScaled: 1_120_000_000n,
        interceptX: 1_000_000n,
        interceptY: 2_000_000n,
      },
      1000,
      150,
      320,
    )
    expect(tooLate.status).toBe('missed')
    expect(tooLate.interceptionBlock).toBeCloseTo(1075)
    expect(tooLate.arrivalBlock).toBeCloseTo(1120)
    expect(tooLate.reason).toMatch(/after the threat had already passed/i)
    expect(tooLate.reason).toMatch(/1075/)

    const tooFar = toDefenseResult('b', { ...base, missDistanceWu: 900_000_000n }, 1000, 150, 320)
    expect(tooFar.reason).toMatch(/outside the 320 km interception radius/i)

    const hit = toDefenseResult(
      'c',
      { ...base, intercepted: true, interceptionBlockScaled: 1_075_000_000n, isWinner: true },
      1000,
      150,
      320,
    )
    expect(hit.status).toBe('intercepted')
    expect(hit.isWinner).toBe(true)
    expect(hit.reason).toMatch(/inside the 320 km radius at submit/i)
  })

  it('recovers TOO EARLY when a chord miss stored the pass as launch', () => {
    const launch = 46159985
    const flight = 120
    const km = (value: number) => BigInt(Math.round(value * 1_000_000))
    const recovered = toDefenseResult(
      'a',
      {
        participant: '0x1111111111111111111111111111111111111111' as Address,
        pointHandle: '0x00' as Hash,
        submittedAtBlock: 46160032n,
        submittedAtTimestamp: 0n,
        revealed: true,
        x: km(4402.628435),
        y: km(1708.482676),
        arrivalBlockScaled: 46160032n * 1_000_000n,
        intercepted: false,
        interceptionBlockScaled: 46159985n * 1_000_000n + 52n,
        interceptX: km(4414.444535),
        interceptY: km(1568.979358),
        missDistanceWu: km(318.69),
        isWinner: false,
        maskedHandle: '0x00' as Hash,
      },
      launch,
      flight,
      140,
      {
        pointA: { x: 3760.174558, y: 0.000001 },
        pointB: { x: 5246.040757, y: 3563.197878 },
        impactAngleRadians: 0,
        launchBearingRadians: 0,
        lengthKm: 3860,
        speedKmPerBlock: 32,
      },
    )
    expect(recovered.status).toBe('missed')
    expect(recovered.arrivalBlock).toBeLessThan(recovered.interceptionBlock ?? 0)
    expect(recovered.reason).toMatch(/before the threat reached this altitude/i)
  })

  it('reports a pending result while the attack is still sealed', () => {
    const pending = toDefenseResult(
      'a',
      {
        participant: '0x1111111111111111111111111111111111111111' as Address,
        pointHandle: '0x00' as Hash,
        submittedAtBlock: 1000n,
        submittedAtTimestamp: 0n,
        revealed: false,
        x: 0n,
        y: 0n,
        arrivalBlockScaled: 0n,
        intercepted: false,
        interceptionBlockScaled: 0n,
        interceptX: 0n,
        interceptY: 0n,
        missDistanceWu: 0n,
        isWinner: false,
        maskedHandle: '0x00' as Hash,
      },
      1000,
      150,
      320,
    )
    expect(pending.status).toBe('pending')
    expect(pending.missDistanceKm).toBeNull()
  })

  it('counts defense activity per sector only once points are public', () => {
    const attempts: DefenseAttempt[] = [
      {
        id: 'a',
        lobbyId: '0x1' as Hash,
        attackId: 'x',
        participant: '0x1111111111111111111111111111111111111111' as Address,
        defensePoint: { sector: { column: 2, row: 1 }, offsetX: 0.5, offsetY: 0.5 },
        sealedPoint: null,
        submittedAtBlock: 1,
        submittedAtTimestamp: 0,
        txHash: '0x0' as Hash,
      },
      {
        id: 'b',
        lobbyId: '0x1' as Hash,
        attackId: 'x',
        participant: '0x2222222222222222222222222222222222222222' as Address,
        // Still sealed: contributes nothing, which is what keeps the map
        // silent about where defenders are mid-round.
        defensePoint: null,
        sealedPoint: null,
        submittedAtBlock: 1,
        submittedAtTimestamp: 0,
        txHash: '0x0' as Hash,
      },
    ]

    const cells = toActivityMap(attempts, 10, 5)
    expect(cells).toHaveLength(50)
    expect(cells.find((cell) => cell.sector.column === 2 && cell.sector.row === 1)?.defenseAttemptCount).toBe(1)
    expect(cells.reduce((sum, cell) => sum + cell.defenseAttemptCount, 0)).toBe(1)
  })
})

/**
 * A probe's answer arrives as one integer from the confidential network.
 * These pin down that the client recentres it and nothing more — in
 * particular that it never gets closer to the truth than the protocol let
 * it (ТЗ §3).
 */
describe('probe hint decoding', () => {
  const cone = 174_533 // 10°
  const address = '0x1111111111111111111111111111111111111111' as Address

  function packed(thetaLimb: number, deltaLimb = MAX_IMPACT_DELTA_MICRO_RAD + cone) {
    return packProbeHint(thetaLimb, deltaLimb)
  }

  function decode(hint: bigint) {
    return decodeProbeHint({
      hint,
      coneMicroRad: cone,
      flightProgress: 0.45,
      probeIndex: 0,
      lobbyId: '0xlobby' as Hash,
      attackId: 'attack-1',
      probeId: 'probe-1',
      requestedBy: address,
      txHash: '0xtx' as Hash,
      generatedAtBlock: 42,
      world,
      grid: { columns: 10, rows: 5 },
    })
  }

  it('opens the first probe as the search sweep, not the 10° shutter', () => {
    const probe = decode(packed(MAX_LAUNCH_OFFSET_MICRO_RAD + cone))
    expect(probe.uncertaintyDegrees).toBe(BASE_CONE_DEGREES)
  })

  it('recentres the noise window so an unbiased hint reads as its true bearing', () => {
    // A hint of exactly (θ_raw + cone + bias) is both noises landing dead centre.
    const straightUp = decode(packed(MAX_LAUNCH_OFFSET_MICRO_RAD + cone + ATTACK_BIAS_MICRO_RAD))
    // θ = 0 means "straight up out of the planet", which is -90° in the
    // scene's own convention.
    expect(straightUp.bearingDegrees).toBeCloseTo(270, 1)
    expect(straightUp.direction).toBe('N')
  })

  it('reports the protocol\'s own cone as its uncertainty on a later probe, never a tighter one', () => {
    const probe = decodeProbeHint({
      hint: packed(MAX_LAUNCH_OFFSET_MICRO_RAD + cone),
      coneMicroRad: cone,
      flightProgress: 0.45,
      probeIndex: 2,
      lobbyId: '0xlobby' as Hash,
      attackId: 'attack-1',
      probeId: 'probe-1',
      requestedBy: address,
      txHash: '0xtx' as Hash,
      generatedAtBlock: 42,
      world,
      grid: { columns: 10, rows: 5 },
    })
    expect(probe.uncertaintyDegrees).toBeCloseTo(10, 1)
    expect(probe.sectorIds.length).toBeGreaterThan(0)
  })

  it('shifts the reported bearing with the noise, so a wrong reading stays wrong', () => {
    const left = decode(packed(MAX_LAUNCH_OFFSET_MICRO_RAD + cone + ATTACK_BIAS_MICRO_RAD - 50_000))
    const right = decode(packed(MAX_LAUNCH_OFFSET_MICRO_RAD + cone + ATTACK_BIAS_MICRO_RAD + 50_000))
    expect(left.bearingDegrees).toBeLessThan(270)
    expect(right.bearingDegrees).toBeGreaterThan(270)
  })

  it('places a snapshot on the reconstructed noisy chord, not a live crawler', () => {
    const probe = decode(packed(MAX_LAUNCH_OFFSET_MICRO_RAD + cone + ATTACK_BIAS_MICRO_RAD))
    expect(probe.mark).toBeDefined()
    expect(Number.isFinite(probe.mark!.x)).toBe(true)
    expect(Number.isFinite(probe.mark!.y)).toBe(true)
    expect(probe.requestedBy).toBe(address)
    expect(probe.generatedAtBlock).toBe(42)
  })

  /*
   * Operations that started under the engine before the packed hint answer
   * with θ alone. Recentring the empty δ limb produced a confident −55°, so
   * their corridor sat one fixed angle off the truth and the revealed
   * trajectory ran outside the scan that was supposed to contain it.
   */
  it('reports no impact at all for a hint from before δ was packed', () => {
    const legacy = decode(packProbeHint(MAX_LAUNCH_OFFSET_MICRO_RAD + cone + ATTACK_BIAS_MICRO_RAD, 0))
    expect(legacy.bearingDegrees).toBeCloseTo(270, 1)
    expect(legacy.impactBearingDegrees).toBeUndefined()
    expect(legacy.mark).toBeUndefined()
  })

  it('reads δ back as the offset the confidential layer packed', () => {
    const straight = decode(packed(MAX_LAUNCH_OFFSET_MICRO_RAD + cone + ATTACK_BIAS_MICRO_RAD))
    expect(straight.impactBearingDegrees).toBeCloseTo(270, 1)

    const offset = decode(
      packed(MAX_LAUNCH_OFFSET_MICRO_RAD + cone + ATTACK_BIAS_MICRO_RAD, MAX_IMPACT_DELTA_MICRO_RAD + cone + 349_066),
    )
    expect(offset.impactBearingDegrees! - straight.impactBearingDegrees!).toBeCloseTo(20, 1)
  })
})

describe('decodeChainParticipant', () => {
  const fields = [
    { name: 'joined', type: 'bool' },
    { name: 'joinedAtBlock', type: 'uint64' },
    { name: 'probesUsed', type: 'uint16' },
    { name: 'probesPurchased', type: 'uint16' },
    { name: 'defenseIndex', type: 'uint32' },
    { name: 'claimed', type: 'bool' },
    { name: 'refunded', type: 'bool' },
    { name: 'paidIn', type: 'uint128' },
    { name: 'probesPaid', type: 'uint128' },
    { name: 'lastProbeBlock', type: 'uint64' },
  ] as const

  const body = {
    joined: true,
    joinedAtBlock: 45_000_001n,
    probesUsed: 2,
    probesPurchased: 1,
    defenseIndex: 0,
    claimed: false,
    refunded: false,
    paidIn: 10n ** 16n,
    probesPaid: 2n * 10n ** 14n,
  }

  it('reads lastProbeBlock from a current-layout return', () => {
    const encoded = encodeAbiParameters(
      [{ type: 'tuple', components: [...fields] }],
      [{ ...body, lastProbeBlock: 45_000_080n }],
    )
    const decoded = decodeChainParticipant(encoded)
    expect(decoded.lastProbeBlock).toBe(45_000_080n)
    expect(decoded.probesUsed).toBe(2)
    expect(decoded.paidIn).toBe(10n ** 16n)
  })

  it('treats a pre-upgrade nine-field return as lastProbeBlock 0', () => {
    const encoded = encodeAbiParameters(
      [{ type: 'tuple', components: [...fields.slice(0, -1)] }],
      [body as never],
    )
    const decoded = decodeChainParticipant(encoded)
    expect(decoded.lastProbeBlock).toBe(0n)
    expect(decoded.joined).toBe(true)
    expect(decoded.joinedAtBlock).toBe(45_000_001n)
  })
})
