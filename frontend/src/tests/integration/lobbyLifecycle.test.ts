import { afterEach, describe, expect, it } from 'vitest'
import { EmulatorBlockchainClient } from '../../blockchain/EmulatorBlockchainClient'
import { parseEnv } from '../../config/env'
import { buildDefaultLobbyConfig } from '../../config/gameConfig'
import { joinCostOf } from '../../game/economics'
import {
  buyDrone,
  claimReward,
  createLobby,
  getActivityMap,
  getAttack,
  getAttackReveal,
  getDefenseAttempts,
  getLobby,
  getLobbyParticipants,
  getParticipant,
  joinLobby,
  leaveLobby,
  revealAttack,
  sendReconProbe,
  settleCreator,
  submitDefenseAttempt,
} from '../../game/gameService'
import { sendAndCollectProbe, waitOutProbeFlight } from '../helpers/recon'
import { submitTimedDefenseAttempt } from '../helpers/defense'
import { openOwnDefensePoint, type PrivateActionRequest } from '../../game/privateActions'
import { mergeReconProbes, MIN_CONE_DEGREES } from '../../game/recon'
import { derivePlayerSealingKey, seal, unseal } from '../../game/sealing'
import type { Address, AttackTrajectory, DefensePoint, Hash, Lobby, LobbyConfig } from '../../game/types'
import { buildWorld, closestApproach, defensePointToWorld, worldToDefensePoint } from '../../game/world'

const CREATOR = '0xc0ffee0000000000000000000000000000c0de' as Address
const PLAYER_ONE = '0x1111111111111111111111111111111111111a' as Address
const PLAYER_TWO = '0x2222222222222222222222222222222222222b' as Address

const GRID = { columns: 10, rows: 5 }
const EPOCH_BLOCKS = 20
const SECTOR_SPAN_KM = 1000

function buildEnv(overrides: Partial<Record<string, string>> = {}): ImportMetaEnv {
  return {
    VITE_BLOCKCHAIN_MODE: 'emulator',
    VITE_ATTACK_EPOCH_BLOCKS: String(EPOCH_BLOCKS),
    VITE_SECTOR_SPAN_KM: String(SECTOR_SPAN_KM),
    VITE_DEFENSE_INTERCEPTION_RADIUS: '0.14',
    VITE_EMULATOR_INITIAL_BLOCK: '1',
    VITE_EMULATOR_BLOCK_TIME_MS: '2000',
    VITE_MAP_GRID_COLUMNS: String(GRID.columns),
    VITE_MAP_GRID_ROWS: String(GRID.rows),
    VITE_RECON_PROBE_FREE_COUNT: '3',
    VITE_MIN_START_PRIZE_POOL: '1',
    ...overrides,
  } as unknown as ImportMetaEnv
}

/**
 * Client and lobby config always come from the same protocol config — the
 * emulator re-validates every `createLobby` against the limits it was
 * built with, exactly as a deployed contract would.
 */
function buildClientAndConfig(overrides: Partial<Record<string, string>> = {}) {
  const appConfig = parseEnv(buildEnv(overrides))
  const client = new EmulatorBlockchainClient({
    initialBlock: 1,
    // Long enough that no block is ever mined on a timer: every test drives
    // the chain forward explicitly with `advanceBlocks`, so nothing here
    // depends on how long a test happens to take.
    blockTimeMs: 10_000_000,
    mapGrid: GRID,
    epochBlocks: appConfig.protocol.epochBlocks,
    protocolLimits: appConfig.protocol,
  })
  return { client, config: { ...buildDefaultLobbyConfig(appConfig, Date.now()), name: 'Test Operation' } }
}

/**
 * Sends one raw private action, bypassing `gameService` (ТЗ §4, §5).
 *
 * The tests that use this are the ones checking what the *protocol* refuses
 * rather than what the UI offers, so they have to be able to seal a request
 * the app would never construct — a Defense before launch, a second Defense,
 * a point outside its own sector. Sealing it here is the only way in:
 * `submitPrivateAction` is the sole in-round write, and it takes ciphertext.
 */
async function sendPrivateAction(
  client: EmulatorBlockchainClient,
  from: Address,
  lobbyId: Hash,
  request: PrivateActionRequest,
) {
  const key = await client.readContract('getSealingKey', {})
  return client.writeContract('submitPrivateAction', { lobbyId, envelope: seal(request, key) }, from)
}

/**
 * Opens the sealed trajectory out of the emulator's own state.
 *
 * This is the one thing no client may do — which is exactly why a test has
 * to reach past the read surface *and* past the encryption to do it, and
 * why that surface is what every other test asserts against.
 */
function openSealedTrajectory(
  client: EmulatorBlockchainClient,
  lobbyId: Hash,
  attackId: string,
): AttackTrajectory {
  const internals = client as unknown as {
    state: { sealedTrajectories: Map<string, Parameters<typeof unseal>[0]> }
    sealingKey: Parameters<typeof unseal>[1]
  }
  return unseal<AttackTrajectory>(internals.state.sealedTrajectories.get(`${lobbyId}:${attackId}`)!, internals.sealingKey)
}

/** Creates an operation, fills it, and lets the application deadline pass. */
async function openAndFill(client: EmulatorBlockchainClient, config: LobbyConfig, players = [PLAYER_ONE, PLAYER_TWO]) {
  config.participation.deadline = Date.now() + 300 * (players.length + 2)
  const { lobby } = await createLobby(client, CREATOR, config)
  const cost = joinCostOf(config)
  for (const player of players) await joinLobby(client, player, lobby.id, cost)

  // The deadline is a Unix ms timestamp per spec §18 — the one place wall
  // time is authoritative by design, unlike epoch/attack math, which is
  // strictly block-based.
  const remaining = config.participation.deadline - Date.now()
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining + 30))

  const active = await getLobby(client, lobby.id)
  return { lobby: active!, cost }
}

/**
 * What the winner of an operation with `participantCount` defenders takes
 * (ТЗ §14.4): the creator's bounty, plus the entry fees left over once the
 * Creator Fee has been taken off them.
 */
function rewardPoolOf(config: LobbyConfig, participantCount: number): number {
  const entryFees = config.participation.entryPrice * participantCount
  return config.economics.prizePool + entryFees - entryFees * (config.economics.creatorFeePercent / 100)
}

/** Advances the chain to just past `block`. */
async function advanceTo(client: EmulatorBlockchainClient, block: number) {
  const current = await client.getBlockNumber()
  if (block > current) client.advanceBlocks(block - current)
}

/**
 * Advances to just past the launch block — ТЗ §4 makes this the moment
 * everything a player can do becomes possible, so most of the tests below
 * have to get here first.
 */
async function launch(client: EmulatorBlockchainClient, lobby: Lobby) {
  const attack = await getAttack(client, lobby.id, lobby.activeAttackId!)
  await advanceTo(client, attack!.launchBlock + 1)
  return attack!
}

describe('integration: joining an operation', () => {
  let client: EmulatorBlockchainClient
  afterEach(() => client.dispose())

  it('records the joining participant with their free Recon Probe allotment', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config
    const { lobby } = await createLobby(client, CREATOR, config)

    const cost = joinCostOf(config)
    await joinLobby(client, PLAYER_ONE, lobby.id, cost)

    expect(await getLobbyParticipants(client, lobby.id, PLAYER_ONE)).toHaveLength(1)
    expect((await getParticipant(client, lobby.id, PLAYER_ONE, PLAYER_ONE))?.freeDronesRemaining).toBe(config.drones.freeCount)
    expect((await getLobby(client, lobby.id))?.participantCount).toBe(1)
  })
})

describe('integration: leaving an operation before it starts (ТЗ §5)', () => {
  let client: EmulatorBlockchainClient
  afterEach(() => client.dispose())

  it('gives the seat and the money back while applications are still open', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config
    const { lobby } = await createLobby(client, CREATOR, config)
    const cost = joinCostOf(config)

    const before = await client.getBalance(PLAYER_ONE)
    await joinLobby(client, PLAYER_ONE, lobby.id, cost)
    await leaveLobby(client, PLAYER_ONE, lobby.id)

    expect(await client.getBalance(PLAYER_ONE)).toBeCloseTo(before)
    expect(await getParticipant(client, lobby.id, PLAYER_ONE, PLAYER_ONE)).toBeNull()
    const after = await getLobby(client, lobby.id)
    expect(after?.participantCount).toBe(0)
    expect(after?.participantAddresses).not.toContain(PLAYER_ONE)
  })

  it('refunds Recon Probes bought before the withdrawal too', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config
    const { lobby } = await createLobby(client, CREATOR, config)
    const cost = joinCostOf(config)

    const before = await client.getBalance(PLAYER_ONE)
    await joinLobby(client, PLAYER_ONE, lobby.id, cost)
    await buyDrone(client, PLAYER_ONE, lobby.id, config.drones.price)
    const { refunded } = await leaveLobby(client, PLAYER_ONE, lobby.id)

    expect(refunded).toBeCloseTo(cost + config.drones.price)
    expect(await client.getBalance(PLAYER_ONE)).toBeCloseTo(before)
  })

  it('refuses once the operation has gone ACTIVE (ТЗ §5)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    expect(lobby.status).toBe('ACTIVE')

    const tx = await client.writeContract('leaveLobby', { lobbyId: lobby.id }, PLAYER_ONE)
    expect(tx.status).toBe('failed')
    expect(await getParticipant(client, lobby.id, PLAYER_ONE, PLAYER_ONE)).not.toBeNull()
  })
})

describe('integration: scheduling the attack (ТЗ §3, §5)', () => {
  let client: EmulatorBlockchainClient
  afterEach(() => client.dispose())

  it('schedules exactly one attack at a future epoch boundary once applications close', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)

    expect(lobby.status).toBe('ACTIVE')
    expect(lobby.activeAttackId).not.toBeNull()

    const attack = await getAttack(client, lobby.id, lobby.activeAttackId!)
    expect(attack).not.toBeNull()
    expect(attack!.status).toBe('PENDING')
    // The launch is ahead of us, not behind.
    expect(attack!.launchBlock).toBeGreaterThan(await client.getBlockNumber())
    // §5.3: the flight is exactly one epoch.
    expect(attack!.flightDurationBlocks).toBe(EPOCH_BLOCKS)
    expect(attack!.impactBlock).toBe(attack!.launchBlock + EPOCH_BLOCKS)
  })

  it('never returns the trajectory from a public read, at any point in the flight (ТЗ §3.4-3.5)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    const attackId = lobby.activeAttackId!

    const pending = await getAttack(client, lobby.id, attackId)
    expect(pending).not.toHaveProperty('trajectory')

    await advanceTo(client, pending!.launchBlock + 1)
    expect((await getAttack(client, lobby.id, attackId))!.status).toBe('LAUNCHED')
    expect(await getAttackReveal(client, lobby.id, attackId)).toBeNull()

    await advanceTo(client, pending!.impactBlock + 1)
    const resolved = await getAttack(client, lobby.id, attackId)
    expect(resolved!.status).toBe('RESOLVED')
    // Even resolved, the public attack carries only its schedule — the
    // geometry comes back from the reveal and from nowhere else.
    expect(resolved).not.toHaveProperty('trajectory')
  })

  it('stops accepting new participants once applications have closed', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby, cost } = await openAndFill(client, built.config)

    const tx = await client.writeContract('joinLobby', { lobbyId: lobby.id, value: cost }, CREATOR)
    expect(tx.status).toBe('failed')
  })
})

describe('integration: reconnaissance and Defense (ТЗ §4, §6, §8, §9)', () => {
  let client: EmulatorBlockchainClient
  afterEach(() => client.dispose())

  it('answers a probe with a direction and a cone, never a coordinate (ТЗ §1.1-1.2)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    await launch(client, lobby)

    const { probe } = await sendAndCollectProbe(client, PLAYER_ONE, {
      lobbyId: lobby.id,
      attackId: lobby.activeAttackId!,
      probeId: 'probe-1',
    })

    expect(probe).not.toBeNull()
    // The whole answer, and nothing that could be turned into a place: a
    // bearing, how wrong it might be, how much it trusts itself, and the
    // sectors that bearing implicates.
    expect(probe!.bearingDegrees).toBeGreaterThanOrEqual(0)
    expect(probe!.bearingDegrees).toBeLessThan(360)
    expect(probe!.uncertaintyDegrees).toBeGreaterThan(0)
    expect(probe!.confidencePercent).toBeGreaterThan(0)
    expect(probe!.confidencePercent).toBeLessThan(100)
    expect(probe!.sectorIds.length).toBeGreaterThan(0)
    expect(probe).not.toHaveProperty('sector')
  })

  it('takes no target in the transaction at all (ТЗ §1.1)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    await launch(client, lobby)

    const tx = await sendPrivateAction(client, PLAYER_ONE, lobby.id, {
      op: 'RECON_PROBE',
      attackId: lobby.activeAttackId!,
      probeId: 'probe-1',
      aimDegrees: null,
    })

    expect(tx.status).toBe('confirmed')
    // Nothing an observer could read a target out of: the call itself
    // discloses only that a probe went out.
    expect(JSON.stringify(tx.args)).not.toContain('sector')
  })

  it('narrows the cone as further probes come in, and never closes it (ТЗ §1.3)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    await launch(client, lobby)

    const results = []
    for (let index = 1; index <= 3; index++) {
      const { probe } = await sendAndCollectProbe(client, PLAYER_ONE, {
        lobbyId: lobby.id,
        attackId: lobby.activeAttackId!,
        probeId: `probe-${index}`,
      })
      results.push(probe!)
    }

    const one = mergeReconProbes(results.slice(0, 1))!
    const two = mergeReconProbes(results.slice(0, 2))!
    const three = mergeReconProbes(results)!

    expect(two.uncertaintyDegrees).toBeLessThan(one.uncertaintyDegrees)
    // A well-aimed second probe already hits `MIN_CONE_DEGREES`, so the
    // third cannot go lower — the floor is the whole of "never closes".
    expect(three.uncertaintyDegrees).toBeLessThanOrEqual(two.uncertaintyDegrees)
    expect(three.confidencePercent).toBeGreaterThan(one.confidencePercent)
    // ТЗ §1.3 — it stays a search area. The exact target waits for Reveal.
    expect(three.uncertaintyDegrees).toBeGreaterThanOrEqual(MIN_CONE_DEGREES)
  })

  it('refuses reconnaissance before the attack launches (ТЗ §4.4, §6.1)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    expect((await getAttack(client, lobby.id, lobby.activeAttackId!))!.status).toBe('PENDING')

    const tx = await sendPrivateAction(client, PLAYER_ONE, lobby.id, {
      op: 'RECON_PROBE',
      attackId: lobby.activeAttackId!,
      probeId: 'probe-1',
      aimDegrees: null,
    })
    expect(tx.status).toBe('failed')
  })

  it('refuses a Defense before the attack launches (ТЗ §4.5, §8.1)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)

    const tx = await sendPrivateAction(client, PLAYER_ONE, lobby.id, {
      op: 'DEFENSE_SUBMIT',
      attackId: lobby.activeAttackId!,
      defensePoint: { sector: { column: 2, row: 2 }, offsetX: 0.5, offsetY: 0.5 },
    })
    expect(tx.status).toBe('failed')
  })

  it('closes reconnaissance the moment Defense is submitted (ТЗ §9.4)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    const attackId = lobby.activeAttackId!
    await launch(client, lobby)

    await submitDefenseAttempt(client, PLAYER_ONE, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: { sector: { column: 2, row: 2 }, offsetX: 0.5, offsetY: 0.5 },
    })

    const tx = await sendPrivateAction(client, PLAYER_ONE, lobby.id, {
      op: 'RECON_PROBE',
      attackId,
      probeId: 'probe-2',
      aimDegrees: null,
    })
    expect(tx.status).toBe('failed')
  })

  it('refuses a second Defense from the same participant (ТЗ §9.5)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    const attackId = lobby.activeAttackId!
    await launch(client, lobby)

    const { attempt, defensePoint } = await submitDefenseAttempt(client, PLAYER_ONE, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: { sector: { column: 2, row: 2 }, offsetX: 0.25, offsetY: 0.75 },
    })
    // The receipt is private: the point comes back to the wallet that sent
    // it, and the protocol's own record of the attempt carries none (ТЗ §11).
    expect(defensePoint).toEqual({ sector: { column: 2, row: 2 }, offsetX: 0.25, offsetY: 0.75 })
    expect(attempt?.defensePoint).toBeNull()

    const second = await sendPrivateAction(client, PLAYER_ONE, lobby.id, {
      op: 'DEFENSE_SUBMIT',
      attackId,
      defensePoint: { sector: { column: 4, row: 1 }, offsetX: 0.5, offsetY: 0.5 },
    })
    expect(second.status).toBe('failed')
  })

  it('rejects a Defense Point that is not inside its own sector (ТЗ §8.2)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    await launch(client, lobby)

    const tx = await sendPrivateAction(client, PLAYER_ONE, lobby.id, {
      op: 'DEFENSE_SUBMIT',
      attackId: lobby.activeAttackId!,
      defensePoint: { sector: { column: 2, row: 2 }, offsetX: 4.5, offsetY: 0.5 },
    })
    expect(tx.status).toBe('failed')
  })

  it('gives nobody a plaintext Defense Point before the reveal (ТЗ §7, §11)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    const attackId = lobby.activeAttackId!
    const attack = await launch(client, lobby)

    await submitDefenseAttempt(client, PLAYER_ONE, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: { sector: { column: 2, row: 2 }, offsetX: 0.5, offsetY: 0.5 },
    })

    const asOwner = await getDefenseAttempts(client, lobby.id, attackId, PLAYER_ONE)
    const asOther = await getDefenseAttempts(client, lobby.id, attackId, PLAYER_TWO)

    // Not even to the defender who placed it: what they get back is an
    // envelope sealed to their own key, which their own client opens.
    expect(asOwner[0].defensePoint).toBeNull()
    expect(asOwner[0].sealedPoint).not.toBeNull()
    expect(openOwnDefensePoint(asOwner[0], PLAYER_ONE)).toEqual({
      sector: { column: 2, row: 2 },
      offsetX: 0.5,
      offsetY: 0.5,
    })

    // And to anybody else, nothing at all — no plaintext and no envelope
    // they could take away and work on.
    expect(asOther[0].defensePoint).toBeNull()
    expect(asOther[0].sealedPoint).toBeNull()
    expect(openOwnDefensePoint(asOther[0], PLAYER_TWO)).toBeNull()

    // And still closed after resolution: it is the reveal that opens them,
    // not the passage of time.
    await advanceTo(client, attack.impactBlock + 1)
    expect((await getDefenseAttempts(client, lobby.id, attackId, PLAYER_TWO))[0].defensePoint).toBeNull()
  })
})

describe('integration: resolution, reveal and rewards (ТЗ §11-§17)', () => {
  let client: EmulatorBlockchainClient
  afterEach(() => client.dispose())

  /**
   * Reads the sealed trajectory out of the emulator's own state. This is
   * the one thing no client may do — which is exactly why the test has to
   * reach past the read surface to do it, and why that surface is what the
   * other tests assert against.
   */
  function sealedTrajectory(lobbyId: Hash, attackId: string): AttackTrajectory {
    return openSealedTrajectory(client, lobbyId, attackId)
  }

  function worldFor(config: LobbyConfig) {
    return buildWorld(GRID, config.attack.sectorSpanKm)
  }

  /** A Defense Point sitting exactly on the attack's path. */
  function onPath(lobby: Lobby, config: LobbyConfig, progress: number): DefensePoint {
    const { pointA, pointB } = sealedTrajectory(lobby.id, lobby.activeAttackId!)
    const world = worldFor(config)
    return worldToDefensePoint(
      {
        x: pointA.x + (pointB.x - pointA.x) * progress,
        y: pointA.y + (pointB.y - pointA.y) * progress,
      },
      world,
    )
  }

  async function defendOnTime(lobby: Lobby, config: LobbyConfig, from: Address, progress: number) {
    const attack = await getAttack(client, lobby.id, lobby.activeAttackId!)
    await submitTimedDefenseAttempt(client, from, {
      lobbyId: lobby.id,
      attackId: lobby.activeAttackId!,
      defensePoint: onPath(lobby, config, progress),
      trajectory: sealedTrajectory(lobby.id, lobby.activeAttackId!),
      world: worldFor(config),
      launchBlock: attack!.launchBlock,
      flightBlocks: attack!.flightDurationBlocks,
      defenseSpeedKmPerBlock: config.attack.defenseSpeedKmPerBlock,
    })
  }

  /**
   * A Defense Point as far from the attack's path as the board allows.
   *
   * The obvious way to write "a defender who lost" is to drop a point in a
   * corner, and it is wrong: each test draws a fresh trajectory, and a
   * trajectory entering from the left edge near the top passes straight
   * through the top-left corner. That made the losing defender an occasional
   * winner and the test an occasional failure, at a rate low enough to look
   * like noise.
   *
   * Searching the grid for the farthest cell instead makes the fixture mean
   * what it says under every geometry the emulator can draw.
   */
  function offPath(lobby: Lobby, config: LobbyConfig): DefensePoint {
    const { pointA, pointB } = sealedTrajectory(lobby.id, lobby.activeAttackId!)
    const world = worldFor(config)

    let best: DefensePoint | null = null
    let bestDistance = -1
    for (let row = 0; row < GRID.rows; row++) {
      for (let column = 0; column < GRID.columns; column++) {
        const point: DefensePoint = { sector: { column, row }, offsetX: 0.5, offsetY: 0.5 }
        const { distanceKm } = closestApproach(defensePointToWorld(point, world), pointA, pointB)
        if (distanceKm > bestDistance) {
          bestDistance = distanceKm
          best = point
        }
      }
    }
    return best!
  }

  it('intercepts a Defense Point on the trajectory (ТЗ §11.1-11.2)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config
    const { lobby } = await openAndFill(client, config)
    const attack = await launch(client, lobby)

    // 0.9 of the way in: inside the field and well clear of Earth's disc.
    await defendOnTime(lobby, config, PLAYER_ONE, 0.9)

    await advanceTo(client, attack.impactBlock + 1)

    const resolved = await getLobby(client, lobby.id)
    expect(resolved!.status).toBe('RESOLVED')
    expect(resolved!.outcome?.intercepted).toBe(true)
    expect(resolved!.outcome?.winners).toEqual([PLAYER_ONE])
    // ТЗ §14.4 — the reward pool is the bounty *plus* what the entry fees
    // left after the Creator Fee. Entry money never leaves the operation and
    // is never paid to the creator twice, so the only place left for it is
    // the pool the winner takes.
    expect(resolved!.outcome?.rewardPerWinner).toBeCloseTo(rewardPoolOf(config, resolved!.participantCount))
  })

  it('pays the highest snapshot hit and not the one below it (ТЗ §11.6-11.7)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config
    const { lobby } = await openAndFill(client, config)
    const attackId = lobby.activeAttackId!
    const attack = await launch(client, lobby)

    await defendOnTime(lobby, config, PLAYER_TWO, 0.8)
    await defendOnTime(lobby, config, PLAYER_ONE, 0.95)

    await advanceTo(client, attack.impactBlock + 1)

    const resolved = await getLobby(client, lobby.id)
    expect(resolved!.outcome?.intercepted).toBe(true)
    expect(resolved!.outcome?.winners).toEqual([PLAYER_TWO])

    await revealAttack(client, PLAYER_ONE, { lobbyId: lobby.id, attackId })
    const reveal = await getAttackReveal(client, lobby.id, attackId)
    const later = reveal!.results.find((result) => result.participant === PLAYER_ONE)
    // Its own snapshot was good — the threat was inside the radius at its
    // submit block. It was simply shot down higher up, first.
    expect(later?.status).toBe('intercepted')
    expect(later?.isWinner).toBe(false)
    expect(later!.interceptionProgress!).toBeGreaterThan(
      reveal!.results.find((result) => result.participant === PLAYER_TWO)!.interceptionProgress!,
    )
  })

  it('lets the attack reach Earth when every Defense Point misses (ТЗ §16)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config
    const { lobby } = await openAndFill(client, config)
    const attackId = lobby.activeAttackId!
    const attack = await launch(client, lobby)

    // The far corner from wherever the attack is coming in.
    const { pointA } = sealedTrajectory(lobby.id, attackId)
    const world = worldFor(config)
    const awayColumn = pointA.x > world.widthKm / 2 ? 0 : GRID.columns - 1
    const awayRow = pointA.y > world.heightKm / 2 ? 0 : GRID.rows - 1

    await submitDefenseAttempt(client, PLAYER_ONE, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: { sector: { column: awayColumn, row: awayRow }, offsetX: 0.5, offsetY: 0.5 },
    })

    const balanceBefore = await client.getBalance(PLAYER_ONE)
    await advanceTo(client, attack.impactBlock + 1)

    const resolved = await getLobby(client, lobby.id)
    expect(resolved!.outcome?.intercepted).toBe(false)
    expect(resolved!.outcome?.winners).toEqual([])
    expect(resolved!.outcome?.rewardPerWinner).toBe(0)
    // ТЗ §17.1 — a miss earns nothing at all.
    expect(await client.getBalance(PLAYER_ONE)).toBeCloseTo(balanceBefore)
  })

  it('hands over the whole sealed record when the reveal is asked for (ТЗ §4)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config
    const { lobby } = await openAndFill(client, config)
    const attackId = lobby.activeAttackId!
    const attack = await launch(client, lobby)

    await submitDefenseAttempt(client, PLAYER_ONE, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: { sector: { column: 0, row: 0 }, offsetX: 0.5, offsetY: 0.5 },
    })
    await advanceTo(client, attack.impactBlock + 1)

    // Resolution alone opens nothing — somebody has to ask (ТЗ §4).
    expect(await getAttackReveal(client, lobby.id, attackId)).toBeNull()
    await revealAttack(client, PLAYER_ONE, { lobbyId: lobby.id, attackId })

    const reveal = await getAttackReveal(client, lobby.id, attackId)
    const world = worldFor(config)
    expect(reveal).not.toBeNull()

    // §13.3 — the targetPoint, on Earth's surface.
    expect(
      Math.hypot(
        reveal!.trajectory.pointB.x - world.earth.center.x,
        reveal!.trajectory.pointB.y - world.earth.center.y,
      ),
    ).toBeCloseTo(world.earth.radiusKm, 3)
    // §13.2, §5.4 — the startPoint and the speed it implied.
    expect(reveal!.trajectory.speedKmPerBlock).toBeCloseTo(reveal!.trajectory.lengthKm / EPOCH_BLOCKS)

    // §14.2-14.4 — everyone's Defense Points with their verdicts, to anyone.
    expect(reveal!.attempts[0].defensePoint).not.toBeNull()
    expect(reveal!.results).toHaveLength(1)
    expect(reveal!.results[0].participant).toBe(PLAYER_ONE)
  })

  it('takes the first reveal and needs no other (ТЗ §4)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    const attackId = lobby.activeAttackId!
    const attack = await launch(client, lobby)

    await submitDefenseAttempt(client, PLAYER_ONE, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: { sector: { column: 0, row: 0 }, offsetX: 0.5, offsetY: 0.5 },
    })
    await advanceTo(client, attack.impactBlock + 1)

    await revealAttack(client, PLAYER_TWO, { lobbyId: lobby.id, attackId })

    // Written into the operation's own state, not into the caller's
    // session — which is what makes it true for everybody at once.
    const revealed = await getLobby(client, lobby.id)
    expect(revealed?.reveal?.attackId).toBe(attackId)
    expect(revealed?.reveal?.revealedBy).toBe(PLAYER_TWO)

    // Another player's Defense Point, redacted before the reveal, is now
    // public to a viewer who never asked for anything.
    const asOther = await getDefenseAttempts(client, lobby.id, attackId, PLAYER_TWO)
    expect(asOther[0].defensePoint).not.toBeNull()

    // And a second reveal has nothing to do.
    const second = await client.writeContract('revealAttack', { lobbyId: lobby.id, attackId }, CREATOR)
    expect(second.status).toBe('failed')
  })

  it('refuses to reveal a round that has not finished (ТЗ §4)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    const attackId = lobby.activeAttackId!

    const pending = await client.writeContract('revealAttack', { lobbyId: lobby.id, attackId }, PLAYER_ONE)
    expect(pending.status).toBe('failed')

    await launch(client, lobby)
    const inFlight = await client.writeContract('revealAttack', { lobbyId: lobby.id, attackId }, PLAYER_ONE)
    expect(inFlight.status).toBe('failed')
    expect(await getAttackReveal(client, lobby.id, attackId)).toBeNull()
  })

  /**
   * ТЗ §6 — the planet's permanent orientation is `f(blockTimestamp)`, so
   * the timestamp has to be *chain state* recorded at the impact. A client
   * reading it back a month later recomputes the identical position.
   */
  it('records the impact against a block timestamp, not the reader’s clock (ТЗ §6)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    const attack = await launch(client, lobby)
    await advanceTo(client, attack.impactBlock + 1)

    const resolved = await getLobby(client, lobby.id)
    const outcome = resolved!.outcome!
    const impactBlock = await client.getBlock(outcome.resolvedAtBlock)

    expect(outcome.resolvedAtTimestamp).toBe(impactBlock.timestamp)
    // Reading again does not move it — resolution happened once.
    expect((await getLobby(client, lobby.id))!.outcome!.resolvedAtTimestamp).toBe(outcome.resolvedAtTimestamp)
  })

  it('pays no reward until the winner claims it, and then only once (ТЗ §15, §17)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config
    const { lobby } = await openAndFill(client, config)
    const attackId = lobby.activeAttackId!
    const attack = await launch(client, lobby)

    await defendOnTime(lobby, config, PLAYER_ONE, 0.9)

    const before = await client.getBalance(PLAYER_ONE)
    await advanceTo(client, attack.impactBlock + 1)

    // Resolution alone moves nothing: the entitlement is recorded, the
    // money is not.
    expect(await client.getBalance(PLAYER_ONE)).toBeCloseTo(before)
    expect((await getParticipant(client, lobby.id, PLAYER_ONE, PLAYER_ONE))?.payoutState).toBe('PENDING')

    const pool = rewardPoolOf(config, 2)
    const { amount } = await claimReward(client, PLAYER_ONE, { lobbyId: lobby.id, attackId })
    expect(amount).toBeCloseTo(pool)
    expect(await client.getBalance(PLAYER_ONE)).toBeCloseTo(before + pool)
    expect((await getParticipant(client, lobby.id, PLAYER_ONE, PLAYER_ONE))?.payoutState).toBe('PAID')

    // §17.4 — a second claim is rejected by the protocol, not by the UI.
    const second = await client.writeContract('claimReward', { lobbyId: lobby.id, attackId }, PLAYER_ONE)
    expect(second.status).toBe('failed')
    expect(await client.getBalance(PLAYER_ONE)).toBeCloseTo(before + pool)
  })

  it('refuses a claim from a defender who did not win (ТЗ §15)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config
    const { lobby } = await openAndFill(client, config)
    const attackId = lobby.activeAttackId!
    const attack = await launch(client, lobby)

    await defendOnTime(lobby, config, PLAYER_ONE, 0.9)
    await submitDefenseAttempt(client, PLAYER_TWO, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: offPath(lobby, config),
    })
    await advanceTo(client, attack.impactBlock + 1)

    const before = await client.getBalance(PLAYER_TWO)
    const tx = await client.writeContract('claimReward', { lobbyId: lobby.id, attackId }, PLAYER_TWO)
    expect(tx.status).toBe('failed')
    expect(await client.getBalance(PLAYER_TWO)).toBeCloseTo(before)
  })

  it('refuses a claim naming the wrong attack, even from the winner (ТЗ §15)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config
    const { lobby } = await openAndFill(client, config)
    const attackId = lobby.activeAttackId!
    const attack = await launch(client, lobby)

    await defendOnTime(lobby, config, PLAYER_ONE, 0.9)
    await advanceTo(client, attack.impactBlock + 1)

    const tx = await client.writeContract(
      'claimReward',
      { lobbyId: lobby.id, attackId: `${attackId}-not-this-one` },
      PLAYER_ONE,
    )
    expect(tx.status).toBe('failed')
  })

  it('refuses a claim before the operation has resolved (ТЗ §15)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    await launch(client, lobby)

    const tx = await client.writeContract(
      'claimReward',
      { lobbyId: lobby.id, attackId: lobby.activeAttackId! },
      PLAYER_ONE,
    )
    expect(tx.status).toBe('failed')
  })

  it('gives everything back when nobody played the round, and only when asked (ТЗ §17.2, §18)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config
    const { lobby } = await openAndFill(client, config)

    const before = await client.getBalance(CREATOR)
    const attack = await getAttack(client, lobby.id, lobby.activeAttackId!)
    await advanceTo(client, attack!.impactBlock + 1)

    const resolved = await getLobby(client, lobby.id)
    expect(resolved!.outcome?.intercepted).toBe(false)
    /*
     * ТЗ §18 — nobody sent a probe and nobody submitted a defense, so this is
     * not a round that was lost. It is a room the attack flew over, and the
     * protocol says so: UNPLAYED, not COMPLETED.
     *
     * The distinction is what decides the money. A COMPLETED round is
     * delivered whatever its result — the pool goes to the winner or to the
     * Global Defense Pool, and nothing is refunded. An UNPLAYED one delivered
     * nothing, so there is no Creator Fee to earn and every wei goes home.
     */
    expect(resolved!.ending).toBe('UNPLAYED')

    // Resolution is a verdict, not a payment: an impact block must not move
    // anybody's money, however certainly it is owed.
    expect(await client.getBalance(CREATOR)).toBeCloseTo(before)

    const { amount } = await settleCreator(client, CREATOR, lobby.id)
    // The bounty back, plus the creator's own per-seat protocol fee.
    expect(amount).toBeCloseTo(config.economics.prizePool)
    expect(await client.getBalance(CREATOR)).toBeCloseTo(before + amount!)

    // And only once.
    const second = await client.writeContract('settleCreator', { lobbyId: lobby.id }, CREATOR)
    expect(second.status).toBe('failed')
  })

  it('locks a submitted Defense for the rest of the flight (ТЗ §9.2-9.3)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    const attackId = lobby.activeAttackId!
    await launch(client, lobby)

    await submitDefenseAttempt(client, PLAYER_ONE, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: { sector: { column: 2, row: 2 }, offsetX: 0.5, offsetY: 0.5 },
    })

    const tx = await sendPrivateAction(client, PLAYER_ONE, lobby.id, {
      op: 'DEFENSE_SUBMIT',
      attackId,
      defensePoint: { sector: { column: 3, row: 3 }, offsetX: 0.5, offsetY: 0.5 },
    })
    expect(tx.status).toBe('failed')
  })

  it('refuses a Defense once the attack has resolved', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    const attackId = lobby.activeAttackId!

    const attack = await getAttack(client, lobby.id, attackId)
    await advanceTo(client, attack!.impactBlock + 1)

    const tx = await sendPrivateAction(client, PLAYER_TWO, lobby.id, {
      op: 'DEFENSE_SUBMIT',
      attackId,
      defensePoint: { sector: { column: 3, row: 3 }, offsetX: 0.5, offsetY: 0.5 },
    })
    expect(tx.status).toBe('failed')
  })
})

describe('integration: privacy of in-round actions (ТЗ §4, §5, §11)', () => {
  let client: EmulatorBlockchainClient
  afterEach(() => client.dispose())

  it('makes a probe and a Defense indistinguishable on the public surface (ТЗ §4)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    const attackId = lobby.activeAttackId!
    await launch(client, lobby)

    const probeTx = (await sendReconProbe(client, PLAYER_ONE, { lobbyId: lobby.id, attackId, probeId: 'probe-1' })).tx
    const defenseTx = (
      await submitDefenseAttempt(client, PLAYER_TWO, {
        lobbyId: lobby.id,
        attackId,
        defensePoint: { sector: { column: 8, row: 3 }, offsetX: 0.45, offsetY: 0.35 },
      })
    ).tx

    // One entry point, so the function name names nothing.
    expect(probeTx.functionName).toBe('submitPrivateAction')
    expect(defenseTx.functionName).toBe(probeTx.functionName)

    // One payload size, so the length names nothing either.
    const bodyOf = (tx: typeof probeTx) => (tx.args as { envelope: { body: string } }).envelope.body
    expect(bodyOf(defenseTx)).toHaveLength(bodyOf(probeTx).length)

    // And nothing readable in either of them.
    for (const tx of [probeTx, defenseTx]) {
      const serialized = JSON.stringify(tx.args)
      expect(serialized).not.toContain('sector')
      expect(serialized).not.toContain('RECON_PROBE')
      expect(serialized).not.toContain('DEFENSE_SUBMIT')
      expect(serialized).not.toContain('0.45')
    }
  })

  it('emits one event name for both, carrying only a sealed result (ТЗ §4, §11)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    const attackId = lobby.activeAttackId!
    await launch(client, lobby)

    await sendReconProbe(client, PLAYER_ONE, { lobbyId: lobby.id, attackId, probeId: 'probe-1' })
    await submitDefenseAttempt(client, PLAYER_TWO, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: { sector: { column: 8, row: 3 }, offsetX: 0.45, offsetY: 0.35 },
    })

    const logs = await client.getLogs({ lobbyId: lobby.id })
    const actions = logs.filter((log) => log.name === 'PrivateActionSubmitted')
    expect(actions).toHaveLength(2)

    // Separate `ReconProbeSent` / `DefenseSubmitted` events would announce
    // the operation type in the log however well the arguments were sealed.
    expect(logs.some((log) => /Recon|Defense/.test(log.name))).toBe(false)
    expect(JSON.stringify(actions)).not.toContain('sector')

    // And the answer is readable by exactly one wallet.
    const probeLog = actions[0].payload as { participant: Address; sealedResult: Parameters<typeof unseal>[0] }
    expect(probeLog.participant).toBe(PLAYER_ONE)
    expect(() => unseal(probeLog.sealedResult, derivePlayerSealingKey(PLAYER_TWO))).toThrow()
    expect(unseal<{ op: string }>(probeLog.sealedResult, derivePlayerSealingKey(PLAYER_ONE)).op).toBe('RECON_PROBE')
  })

  it('keeps every action its own transaction rather than batching them (ТЗ §5)', async () => {
    // A longer flight than the rest of the file: `PROBE_DELAY_BLOCKS` now
    // stands between the last probe and the Defense too, so three probes
    // and a defense need more than a 20-block epoch to fit inside.
    const built = buildClientAndConfig({ VITE_ATTACK_EPOCH_BLOCKS: '40' })
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    const attackId = lobby.activeAttackId!
    await launch(client, lobby)

    const hashes = new Set<Hash>()
    for (const index of [1, 2, 3]) {
      const { tx } = await sendReconProbe(client, PLAYER_ONE, { lobbyId: lobby.id, attackId, probeId: `probe-${index}` })
      hashes.add(tx.hash)
      // Between sends, and after the last one: the delay gates the next
      // probe *and* the Defense that follows it.
      waitOutProbeFlight(client)
    }
    const { tx: defense } = await submitDefenseAttempt(client, PLAYER_ONE, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: { sector: { column: 8, row: 3 }, offsetX: 0.45, offsetY: 0.35 },
    })
    hashes.add(defense.hash)

    // ТЗ §5 — probe, probe, probe, defense: four signatures, sent as the
    // player decides to send them, not one bundle at the end.
    expect(hashes.size).toBe(4)
  })

  it('publishes no per-sector activity until the reveal (ТЗ §4, §11)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    const attackId = lobby.activeAttackId!
    const attack = await launch(client, lobby)

    await submitDefenseAttempt(client, PLAYER_ONE, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: { sector: { column: 8, row: 3 }, offsetX: 0.45, offsetY: 0.35 },
    })

    // A defender count on a sector is a coarse coordinate, and publishing
    // one mid-flight would leak where the good reconnaissance was pointing.
    const duringFlight = await getActivityMap(client, lobby.id, attackId)
    expect(duringFlight.every((cell) => cell.defenseAttemptCount === 0)).toBe(true)

    await advanceTo(client, attack.impactBlock + 1)
    expect((await getActivityMap(client, lobby.id, attackId)).every((cell) => cell.defenseAttemptCount === 0)).toBe(true)

    await revealAttack(client, PLAYER_ONE, { lobbyId: lobby.id, attackId })
    const afterReveal = await getActivityMap(client, lobby.id, attackId)
    expect(afterReveal.find((cell) => cell.sector.column === 8 && cell.sector.row === 3)?.defenseAttemptCount).toBe(1)
  })

  it('redacts another defender’s action breakdown until the reveal (ТЗ §4)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    const attackId = lobby.activeAttackId!
    const attack = await launch(client, lobby)

    await sendReconProbe(client, PLAYER_ONE, { lobbyId: lobby.id, attackId, probeId: 'probe-1' })
    // A reading cannot be spent on a Defense Point until the probe lands.
    waitOutProbeFlight(client)
    await submitDefenseAttempt(client, PLAYER_ONE, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: { sector: { column: 8, row: 3 }, offsetX: 0.45, offsetY: 0.35 },
    })

    const asSelf = (await getParticipant(client, lobby.id, PLAYER_ONE, PLAYER_ONE))!
    const asOther = (await getParticipant(client, lobby.id, PLAYER_ONE, PLAYER_TWO))!

    // Two actions happened, and a chain cannot hide that they did. What it
    // can hide is which was which — one probe and one Defense look exactly
    // like two probes from outside.
    expect(asOther.actionCount).toBe(2)
    expect(asOther.probeIds).toHaveLength(0)
    expect(asOther.defenseAttemptIds).toHaveLength(0)
    expect(asSelf.probeIds).toHaveLength(1)
    expect(asSelf.defenseAttemptIds).toHaveLength(1)

    // The reveal opens the round completely, breakdown included.
    await advanceTo(client, attack.impactBlock + 1)
    await revealAttack(client, PLAYER_TWO, { lobbyId: lobby.id, attackId })
    const revealed = (await getParticipant(client, lobby.id, PLAYER_ONE, PLAYER_TWO))!
    expect(revealed.probeIds).toHaveLength(1)
    expect(revealed.defenseAttemptIds).toHaveLength(1)
  })

  it('keeps no plaintext geometry in the state a browser could read (ТЗ §11)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const { lobby } = await openAndFill(client, built.config)
    const attackId = lobby.activeAttackId!
    await launch(client, lobby)

    await submitDefenseAttempt(client, PLAYER_ONE, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: { sector: { column: 8, row: 3 }, offsetX: 0.45, offsetY: 0.35 },
    })

    // Everything the emulator persists, exactly as it would be serialized
    // into `localStorage` between reloads. The trajectory the attack was
    // generated with is genuinely not in it.
    const internals = client as unknown as { state: Record<string, Map<string, unknown>> }
    const persisted = JSON.stringify([
      [...internals.state.sealedTrajectories.entries()],
      [...internals.state.sealedDefensePoints.entries()],
      [...internals.state.defenseAttempts.entries()],
      [...internals.state.attacks.entries()],
    ])
    // Asserted structurally rather than by hunting for numbers: a
    // coordinate can legitimately be a value like `0`, which occurs inside
    // any hex string by chance. What cannot occur by chance is the *field*
    // that would carry one.
    for (const field of ['pointA', 'pointB', 'impactAngleRadians', 'speedKmPerBlock', 'offsetX', 'sector']) {
      expect(persisted).not.toContain(field)
    }

    // And the geometry it would have carried is genuinely recoverable only
    // from inside the protocol, with the protocol's key.
    const truth = openSealedTrajectory(client, lobby.id, attackId)
    expect(persisted).not.toContain(String(truth.lengthKm))
    expect(persisted).not.toContain(String(truth.pointB.y))
  })
})
