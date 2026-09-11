import { afterEach, describe, expect, it } from 'vitest'
import { EmulatorBlockchainClient } from '../../blockchain/EmulatorBlockchainClient'
import { PROTOCOL_ESCROW_ADDRESS } from '../../blockchain/emulatorState'
import { parseEnv } from '../../config/env'
import { buildDefaultLobbyConfig } from '../../config/gameConfig'
import { joinCostOf } from '../../game/economics'
import {
  claimReward,
  createLobby,
  getAttack,
  getGameStats,
  getGlobalDefenseDraw,
  getLobby,
  joinLobby,
  revealAttack,
  settleCreator,
  submitDefenseAttempt,
} from '../../game/gameService'
import { timedDefensePlacement } from '../helpers/defense'
import { drawPrizePool, globalDefenseSchedule, isProtocolOwnedLobby } from '../../game/globalDefense'
import { foldLobbySummaries } from '../../hooks/emulatorFold'
import type { Address, AttackTrajectory, DefensePoint, Hash, Lobby, LobbyConfig } from '../../game/types'
import { unseal } from '../../game/sealing'
import { buildWorld, closestApproach, defensePointToWorld, worldToDefensePoint } from '../../game/world'

/**
 * The Global Defense Pool (ТЗ §18) — miss → pool → interval draw → miss
 * again → the same pool waits for the next interval, with no special case.
 */

const CREATOR = '0xc0ffee0000000000000000000000000000c0de' as Address
const ALICE = '0x1111111111111111111111111111111111111a' as Address
const BOB = '0x2222222222222222222222222222222222222b' as Address

const GRID = { columns: 10, rows: 5 }
const EPOCH_BLOCKS = 20
const DRAW_INTERVAL = 2

function buildEnv(overrides: Partial<Record<string, string>> = {}): ImportMetaEnv {
  return {
    VITE_BLOCKCHAIN_MODE: 'emulator',
    VITE_ATTACK_EPOCH_BLOCKS: String(EPOCH_BLOCKS),
    VITE_SECTOR_SPAN_KM: '1000',
    VITE_DEFENSE_INTERCEPTION_RADIUS: '0.14',
    VITE_EMULATOR_INITIAL_BLOCK: '1',
    VITE_EMULATOR_BLOCK_TIME_MS: '2000',
    VITE_MAP_GRID_COLUMNS: String(GRID.columns),
    VITE_MAP_GRID_ROWS: String(GRID.rows),
    VITE_RECON_PROBE_FREE_COUNT: '3',
    VITE_MIN_START_PRIZE_POOL: '1',
    VITE_PROTOCOL_JOIN_FEE: '0',
    VITE_GLOBAL_DEFENSE_EPOCH_INTERVAL: String(DRAW_INTERVAL),
    ...overrides,
  } as unknown as ImportMetaEnv
}

function buildClientAndConfig(overrides: Partial<Record<string, string>> = {}) {
  const appConfig = parseEnv(buildEnv(overrides))
  const client = new EmulatorBlockchainClient({
    initialBlock: 1,
    blockTimeMs: 10_000_000,
    mapGrid: GRID,
    epochBlocks: appConfig.protocol.epochBlocks,
    protocolLimits: appConfig.protocol,
  })
  return { client, config: { ...buildDefaultLobbyConfig(appConfig, Date.now()), name: 'Jackpot feeder' } }
}

async function advanceTo(client: EmulatorBlockchainClient, block: number) {
  const current = await client.getBlockNumber()
  if (block > current) client.advanceBlocks(block - current)
}

async function advanceToDrawWindow(client: EmulatorBlockchainClient, blockTimeMs = 10_000_000) {
  const stats = await getGameStats(client)
  const draw = await getGlobalDefenseDraw(client)
  const schedule = globalDefenseSchedule({
    currentEpoch: stats.currentEpoch,
    intervalEpochs: draw.interval,
    epochBlocks: EPOCH_BLOCKS,
    genesisBlock: 1,
    blockTimeMs,
  })
  if (schedule) await advanceTo(client, schedule.openFromBlock)
}

async function openAndFill(client: EmulatorBlockchainClient, config: LobbyConfig, players: Address[]) {
  config.participation.deadline = Date.now() + 300 * (players.length + 2)
  const { lobby } = await createLobby(client, CREATOR, config)
  const cost = joinCostOf(config)
  for (const player of players) await joinLobby(client, player, lobby.id, cost)
  const remaining = config.participation.deadline - Date.now()
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining + 30))
  return { lobby: (await getLobby(client, lobby.id))!, cost }
}

async function launch(client: EmulatorBlockchainClient, lobby: Lobby) {
  const attack = await getAttack(client, lobby.id, lobby.activeAttackId!)
  await advanceTo(client, attack!.launchBlock + 1)
  return attack!
}

function sealedTrajectory(client: EmulatorBlockchainClient, lobbyId: Hash, attackId: string): AttackTrajectory {
  const internals = client as unknown as {
    state: { sealedTrajectories: Map<string, Parameters<typeof unseal>[0]> }
    sealingKey: Parameters<typeof unseal>[1]
  }
  return unseal<AttackTrajectory>(internals.state.sealedTrajectories.get(`${lobbyId}:${attackId}`)!, internals.sealingKey)
}

function offPath(client: EmulatorBlockchainClient, lobby: Lobby, config: LobbyConfig): DefensePoint {
  const { pointA, pointB } = sealedTrajectory(client, lobby.id, lobby.activeAttackId!)
  const world = buildWorld(GRID, config.attack.sectorSpanKm)
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

function onPath(client: EmulatorBlockchainClient, lobby: Lobby, config: LobbyConfig, progress: number): DefensePoint {
  const { pointA, pointB } = sealedTrajectory(client, lobby.id, lobby.activeAttackId!)
  return worldToDefensePoint(
    { x: pointA.x + (pointB.x - pointA.x) * progress, y: pointA.y + (pointB.y - pointA.y) * progress },
    buildWorld(GRID, config.attack.sectorSpanKm),
  )
}

async function playToMiss(client: EmulatorBlockchainClient, config: LobbyConfig) {
  const { lobby } = await openAndFill(client, config, [ALICE, BOB])
  const attack = await launch(client, lobby)
  const attackId = lobby.activeAttackId!
  await submitDefenseAttempt(client, ALICE, {
    lobbyId: lobby.id,
    attackId,
    defensePoint: offPath(client, lobby, config),
  })
  await advanceTo(client, attack.impactBlock + 1)
  const resolved = await getLobby(client, lobby.id)
  expect(resolved!.ending).toBe('COMPLETED')
  expect(resolved!.outcome?.intercepted).toBe(false)
  return resolved!
}

describe('simulation: Global Defense Pool rollover (ТЗ §18)', () => {
  let client: EmulatorBlockchainClient
  afterEach(() => client.dispose())

  it('refuses to open a draw while the pool is empty', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const tx = await client.writeContract('openGlobalDefense', {}, ALICE)
    expect(tx.status).toBe('failed')
    expect(tx.errorMessage).toMatch(/empty/i)
  })

  it('refuses to open a draw before the join window, so the interval can still accumulate', async () => {
    const built = buildClientAndConfig({ VITE_GLOBAL_DEFENSE_EPOCH_INTERVAL: '1000' })
    client = built.client
    await playToMiss(client, built.config)
    expect((await getGameStats(client)).globalDefensePool).toBeGreaterThan(0)

    const tx = await client.writeContract('openGlobalDefense', {}, ALICE)
    expect(tx.status).toBe('failed')
    expect(tx.errorMessage).toMatch(/not open yet/i)
    expect((await getGameStats(client)).globalDefensePool).toBeGreaterThan(0)
    expect((await getGameStats(client)).globalDefenseLobbyId).toBeNull()
  })

  it('folds a miss during the join window into the advertised bounty, not the next interval', async () => {
    // Real 2s blocks: a day-long window. The default emulator tick is 10s, which
    // shrinks the window to ~9 blocks — shorter than one miss, so the unjoined
    // draw would cancel before the second pool could fold in.
    const appConfig = parseEnv(buildEnv({ VITE_GLOBAL_DEFENSE_EPOCH_INTERVAL: '1000' }))
    client = new EmulatorBlockchainClient({
      initialBlock: 1,
      blockTimeMs: 2000,
      mapGrid: GRID,
      epochBlocks: appConfig.protocol.epochBlocks,
      protocolLimits: appConfig.protocol,
    })
    const config = { ...buildDefaultLobbyConfig(appConfig, Date.now()), name: 'Jackpot feeder' }

    await playToMiss(client, config)
    const first = (await getGameStats(client)).globalDefensePool
    expect(first).toBeGreaterThan(0)

    await advanceToDrawWindow(client, 2000)
    const { lobbyId } = await getGlobalDefenseDraw(client)
    expect(lobbyId).not.toBeNull()
    expect((await getGameStats(client)).globalDefensePool).toBeCloseTo(first)
    expect((await getLobby(client, lobbyId!))!.config.economics.prizePool).toBe(0)

    await playToMiss(client, config)
    const grown = (await getGameStats(client)).globalDefensePool
    expect(grown).toBeGreaterThan(first)
    expect((await getLobby(client, lobbyId!))!.config.economics.prizePool).toBe(0)
  })

  it('feeds the pool from a miss, opens a free draw, and rolls the jackpot forward when that draw also misses', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config

    await playToMiss(client, config)
    const stats = await getGameStats(client)
    expect(stats.globalDefensePool).toBeGreaterThan(0)
    const pooled = stats.globalDefensePool

    const beforeOpen = await getGlobalDefenseDraw(client)
    expect(beforeOpen.interval).toBe(DRAW_INTERVAL)
    expect(beforeOpen.pool).toBeCloseTo(pooled)
    expect(beforeOpen.lobbyId).toBeNull()
    expect(beforeOpen.nextEpoch % DRAW_INTERVAL).toBe(0)

    await advanceToDrawWindow(client)
    const opened = await getGlobalDefenseDraw(client)
    expect(opened.lobbyId).not.toBeNull()
    expect(opened.nextEpoch).toBe(beforeOpen.nextEpoch)

    const draw = await getLobby(client, opened.lobbyId!)
    expect(draw!.creator).toBe(PROTOCOL_ESCROW_ADDRESS)
    expect(draw!.config.name).toBe('Global Defense')
    expect(draw!.config.participation.entryPrice).toBe(0)
    expect(draw!.config.economics.creatorFeePercent).toBe(0)
    expect(draw!.config.economics.prizePool).toBe(0)
    expect(draw!.currentEpochId).toBe(beforeOpen.nextEpoch)
    expect((await getGameStats(client)).globalDefensePool).toBeCloseTo(pooled)
    expect((await getGameStats(client)).globalDefenseLobbyId).toBe(opened.lobbyId)

    const again = await client.writeContract('openGlobalDefense', {}, BOB)
    expect(again.status).toBe('failed')

    const seat = joinCostOf(draw!.config, true)
    expect(seat).toBe(0)
    await joinLobby(client, ALICE, draw!.id, seat)
    await joinLobby(client, BOB, draw!.id, seat)

    await advanceTo(client, draw!.config.participation.deadlineBlock)
    const running = await getLobby(client, draw!.id)
    expect(running!.status).toBe('ACTIVE')

    const attack = await launch(client, running!)
    await submitDefenseAttempt(client, ALICE, {
      lobbyId: running!.id,
      attackId: running!.activeAttackId!,
      defensePoint: offPath(client, running!, running!.config),
    })
    await advanceTo(client, attack.impactBlock + 1)

    const ended = await getLobby(client, draw!.id)
    expect(ended!.ending).toBe('COMPLETED')
    expect(ended!.outcome?.intercepted).toBe(false)
    // The same rule that filled the pool puts the jackpot back. No special
    // "draw failed" branch — a miss is a miss.
    expect((await getGameStats(client)).globalDefensePool).toBeCloseTo(pooled)

    const next = await getGlobalDefenseDraw(client)
    expect(next.nextEpoch).toBeGreaterThan(beforeOpen.nextEpoch)
    expect(next.pool).toBeCloseTo(pooled)
    expect(next.lobbyId).toBeNull()

    await advanceToDrawWindow(client)
    const rolled = await getGlobalDefenseDraw(client)
    expect(rolled.lobbyId).not.toBeNull()
    expect(rolled.lobbyId).not.toBe(opened.lobbyId)
    expect((await getLobby(client, rolled.lobbyId!))!.config.economics.prizePool).toBe(0)
    expect((await getGameStats(client)).globalDefensePool).toBeCloseTo(pooled)
  })

  /*
   * The screens, not the escrow.
   *
   * Every rule above is about where the wei actually are, and the answer —
   * "not in the lobby until the round starts" — is what made every pool a
   * draw printed read 0: on the card in the directory, on the operation's
   * own Prize pool tile, and in its terms. `Lobby.drawBounty` is what the
   * emulator hands those screens instead of the empty room.
   */
  it('reports the jackpot a draw is playing for, on the room and in the directory', async () => {
    const built = buildClientAndConfig()
    client = built.client
    await playToMiss(client, built.config)
    const pooled = (await getGameStats(client)).globalDefensePool

    await advanceToDrawWindow(client)
    const { lobbyId } = await getGlobalDefenseDraw(client)
    const draw = (await getLobby(client, lobbyId!))!

    // The lobby is still empty — that is the whole problem this carries.
    expect(draw.config.economics.prizePool).toBe(0)
    expect(draw.drawBounty).toBeCloseTo(pooled)
    expect(
      drawPrizePool({
        lobbyPool: draw.config.economics.prizePool,
        startPrizePool: draw.config.economics.prizePool,
        protocolOwned: isProtocolOwnedLobby(draw.creator),
        drawBounty: draw.drawBounty,
      }),
    ).toBeCloseTo(pooled)

    const row = foldLobbySummaries(client.inspect().lobbies).find((entry) => entry.id === draw.id)
    expect(Number(row!.rewardPoolWei) / 1e18).toBeCloseTo(pooled)
  })

  it('still says what an unfilled draw was playing for after it is cancelled', async () => {
    const built = buildClientAndConfig()
    client = built.client
    await playToMiss(client, built.config)
    const pooled = (await getGameStats(client)).globalDefensePool

    await advanceToDrawWindow(client)
    const { lobbyId } = await getGlobalDefenseDraw(client)
    const draw = (await getLobby(client, lobbyId!))!
    await advanceTo(client, draw.config.participation.deadlineBlock + 1)

    const cancelled = (await getLobby(client, lobbyId!))!
    expect(cancelled.ending).toBe('UNPLAYED')
    // The bounty went straight back to the pool it never left, which is
    // exactly why the round's own state cannot say what it was worth.
    expect(cancelled.config.economics.prizePool).toBe(0)
    expect(cancelled.drawBounty).toBeCloseTo(pooled)

    const row = foldLobbySummaries(client.inspect().lobbies).find((entry) => entry.id === draw.id)
    expect(row!.status).toBe('cancelled')
    expect(Number(row!.rewardPoolWei) / 1e18).toBeCloseTo(pooled)
  })

  it('returns an unjoined draw to the pool on settle, without paying a wallet', async () => {
    const built = buildClientAndConfig()
    client = built.client
    await playToMiss(client, built.config)
    const pooled = (await getGameStats(client)).globalDefensePool

    await advanceToDrawWindow(client)
    const { lobbyId } = await getGlobalDefenseDraw(client)
    const draw = await getLobby(client, lobbyId!)
    await advanceTo(client, draw!.config.participation.deadlineBlock + 1)

    const cancelled = await getLobby(client, lobbyId!)
    expect(cancelled!.ending).toBe('UNPLAYED')
    expect(cancelled!.creatorSettled).toBe(true)
    expect((await getGameStats(client)).globalDefensePool).toBeCloseTo(pooled)

    const bobBefore = await client.getBalance(BOB)
    await expect(settleCreator(client, BOB, lobbyId!)).rejects.toThrow(/already been settled/)
    expect(await client.getBalance(BOB)).toBeCloseTo(bobBefore)
  })

  it('pays a split jackpot when two defenders intercept at the same point', async () => {
    const built = buildClientAndConfig()
    client = built.client
    await playToMiss(client, built.config)
    const pooled = (await getGameStats(client)).globalDefensePool

    await advanceToDrawWindow(client)
    const { lobbyId } = await getGlobalDefenseDraw(client)
    const draw = (await getLobby(client, lobbyId!))!
    await joinLobby(client, ALICE, draw.id, 0)
    await joinLobby(client, BOB, draw.id, 0)
    await advanceTo(client, draw.config.participation.deadlineBlock)
    const running = (await getLobby(client, draw.id))!
    const attack = await launch(client, running)

    const traj = sealedTrajectory(client, running.id, running.activeAttackId!)
    const world = buildWorld(GRID, running.config.attack.sectorSpanKm)
    const { point, submitBlock } = timedDefensePlacement({
      point: onPath(client, running, running.config, 0.9),
      world,
      launchBlock: attack.launchBlock,
      flightBlocks: attack.flightDurationBlocks,
      trajectory: traj,
      defenseSpeedKmPerBlock: running.config.attack.defenseSpeedKmPerBlock,
    })
    const now = await client.getBlockNumber()
    if (submitBlock > now) client.advanceBlocks(submitBlock - now)
    await submitDefenseAttempt(client, ALICE, { lobbyId: running.id, attackId: running.activeAttackId!, defensePoint: point })
    await submitDefenseAttempt(client, BOB, { lobbyId: running.id, attackId: running.activeAttackId!, defensePoint: point })
    await advanceTo(client, attack.impactBlock + 1)

    const resolved = await getLobby(client, running.id)
    expect(resolved!.outcome?.intercepted).toBe(true)
    expect(resolved!.outcome?.winners).toEqual(expect.arrayContaining([ALICE, BOB]))
    expect(resolved!.outcome?.winners).toHaveLength(2)
    const share = resolved!.outcome!.rewardPerWinner
    expect(share * 2).toBeCloseTo(pooled)

    await revealAttack(client, ALICE, { lobbyId: running.id, attackId: running.activeAttackId! })
    const alice = await claimReward(client, ALICE, { lobbyId: running.id, attackId: running.activeAttackId! })
    const bob = await claimReward(client, BOB, { lobbyId: running.id, attackId: running.activeAttackId! })
    expect(alice.amount).toBeCloseTo(share)
    expect(bob.amount).toBeCloseTo(share)
    expect((await getGameStats(client)).globalDefensePool).toBe(0)
  })
})
