import { afterEach, describe, expect, it } from 'vitest'
import { EmulatorBlockchainClient } from '../../blockchain/EmulatorBlockchainClient'
import { PROTOCOL_ESCROW_ADDRESS } from '../../blockchain/emulatorState'
import { parseEnv } from '../../config/env'
import { buildDefaultLobbyConfig } from '../../config/gameConfig'
import { joinCostOf } from '../../game/economics'
import {
  buyDrone,
  claimReward,
  createLobby,
  getAttack,
  getLobby,
  getParticipant,
  joinLobby,
  revealAttack,
  sendReconProbe,
  settleCreator,
  submitDefenseAttempt,
} from '../../game/gameService'
import { submitTimedDefenseAttempt } from '../helpers/defense'
import type { Address, AttackTrajectory, DefensePoint, Hash, Lobby, LobbyConfig } from '../../game/types'
import { unseal } from '../../game/sealing'
import { buildWorld, worldToDefensePoint } from '../../game/world'

/**
 * The whole life of an operation, played out against the emulator, with the
 * money counted at every step (ТЗ §14, §17, §18).
 *
 * The other integration suites check what the protocol *permits*. This one
 * checks that nothing is *lost*: every ETH a player puts into an operation
 * ends up somewhere a named party can reach, in all four ways an operation
 * can end — cancelled, won, missed, and abandoned mid-application.
 *
 * The invariant that catches almost everything is conservation: the emulator
 * holds escrowed funds on a protocol account rather than deleting them, so
 * the sum of every balance is the same before and after any sequence of
 * actions, and anything an operation cannot pay out shows up as a balance
 * stranded on the escrow account rather than as a rounding difference
 * nobody notices.
 */

const CREATOR = '0xc0ffee0000000000000000000000000000c0de' as Address
const ALICE = '0x1111111111111111111111111111111111111a' as Address
const BOB = '0x2222222222222222222222222222222222222b' as Address
const CAROL = '0x3333333333333333333333333333333333333c' as Address
const STRANGER = '0x4444444444444444444444444444444444444d' as Address

const GRID = { columns: 10, rows: 5 }
const EPOCH_BLOCKS = 20
const SECTOR_SPAN_KM = 1000
const EVERYONE = [CREATOR, ALICE, BOB, CAROL, STRANGER, PROTOCOL_ESCROW_ADDRESS]

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
    VITE_PROTOCOL_JOIN_FEE: '0.002',
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
  return { client, config: { ...buildDefaultLobbyConfig(appConfig, Date.now()), name: 'Sim Operation' } }
}

/** Every balance the simulation touches, so a diff can be taken across a whole flow. */
async function ledger(client: EmulatorBlockchainClient): Promise<Record<string, number>> {
  const entries = await Promise.all(EVERYONE.map(async (who) => [who, await client.getBalance(who)] as const))
  return Object.fromEntries(entries)
}

function total(book: Record<string, number>): number {
  return Object.values(book).reduce((sum, value) => sum + value, 0)
}

async function advanceTo(client: EmulatorBlockchainClient, block: number) {
  const current = await client.getBlockNumber()
  if (block > current) client.advanceBlocks(block - current)
}

async function passDeadline(config: LobbyConfig) {
  const remaining = config.participation.deadline - Date.now()
  if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining + 30))
}

/** Creates an operation and lets `players` join before the deadline passes. */
async function openAndFill(client: EmulatorBlockchainClient, config: LobbyConfig, players: Address[]) {
  config.participation.deadline = Date.now() + 300 * (players.length + 2)
  const { lobby } = await createLobby(client, CREATOR, config)
  const cost = joinCostOf(config)
  for (const player of players) await joinLobby(client, player, lobby.id, cost)
  await passDeadline(config)
  return { lobby: (await getLobby(client, lobby.id))!, cost }
}

async function launch(client: EmulatorBlockchainClient, lobby: Lobby) {
  const attack = await getAttack(client, lobby.id, lobby.activeAttackId!)
  await advanceTo(client, attack!.launchBlock + 1)
  return attack!
}

/** The one thing no client may do — reserved for the simulation's aim. */
function sealedTrajectory(client: EmulatorBlockchainClient, lobbyId: Hash, attackId: string): AttackTrajectory {
  const internals = client as unknown as {
    state: { sealedTrajectories: Map<string, Parameters<typeof unseal>[0]> }
    sealingKey: Parameters<typeof unseal>[1]
  }
  return unseal<AttackTrajectory>(internals.state.sealedTrajectories.get(`${lobbyId}:${attackId}`)!, internals.sealingKey)
}

function onPath(client: EmulatorBlockchainClient, lobby: Lobby, config: LobbyConfig, progress: number): DefensePoint {
  const { pointA, pointB } = sealedTrajectory(client, lobby.id, lobby.activeAttackId!)
  return worldToDefensePoint(
    { x: pointA.x + (pointB.x - pointA.x) * progress, y: pointA.y + (pointB.y - pointA.y) * progress },
    buildWorld(GRID, config.attack.sectorSpanKm),
  )
}

function awayFromPath(client: EmulatorBlockchainClient, lobby: Lobby, config: LobbyConfig): DefensePoint {
  const { pointA } = sealedTrajectory(client, lobby.id, lobby.activeAttackId!)
  const world = buildWorld(GRID, config.attack.sectorSpanKm)
  return {
    sector: {
      column: pointA.x > world.widthKm / 2 ? 0 : GRID.columns - 1,
      row: pointA.y > world.heightKm / 2 ? 0 : GRID.rows - 1,
    },
    offsetX: 0.5,
    offsetY: 0.5,
  }
}

describe('simulation: an operation nobody joined enough of (ТЗ §18)', () => {
  let client: EmulatorBlockchainClient
  afterEach(() => client.dispose())

  it('cancels at the deadline and hands every participant their money back on request', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config
    config.participation.minPlayers = 3
    config.participation.deadline = Date.now() + 1600

    const before = await ledger(client)
    const { lobby } = await createLobby(client, CREATOR, config)
    const cost = joinCostOf(config)
    await joinLobby(client, ALICE, lobby.id, cost)
    await buyDrone(client, ALICE, lobby.id, config.drones.price)

    await passDeadline(config)
    const cancelled = await getLobby(client, lobby.id)
    expect(cancelled!.status).toBe('CANCELLED')

    // Cancel pays everyone in the same moment: entry, author commission and
    // probes come back; the protocol keeps the creation fee.
    expect(await client.getBalance(ALICE)).toBeCloseTo(before[ALICE])
    expect(await client.getBalance(CREATOR)).toBeCloseTo(before[CREATOR] - config.economics.protocolJoinFee)

    const second = await client.writeContract('claimRefund', { lobbyId: lobby.id }, ALICE)
    expect(second.status).toBe('failed')

    const leftover = await client.writeContract('settleCreator', { lobbyId: lobby.id }, CREATOR)
    expect(leftover.status).toBe('failed')

    const after = await ledger(client)
    expect(total(after)).toBeCloseTo(total(before))
    expect(after[PROTOCOL_ESCROW_ADDRESS] - before[PROTOCOL_ESCROW_ADDRESS]).toBeCloseTo(
      config.economics.protocolJoinFee,
    )
  })

  it('refuses a refund to somebody who never joined, and on an operation that is still open', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config
    config.participation.minPlayers = 3
    config.participation.deadline = Date.now() + 1600

    const { lobby } = await createLobby(client, CREATOR, config)
    const cost = joinCostOf(config)
    await joinLobby(client, ALICE, lobby.id, cost)

    // Still open — there is nothing to refund yet; leaving is the way out.
    const early = await client.writeContract('claimRefund', { lobbyId: lobby.id }, ALICE)
    expect(early.status).toBe('failed')

    await passDeadline(config)
    const stranger = await client.writeContract('claimRefund', { lobbyId: lobby.id }, STRANGER)
    expect(stranger.status).toBe('failed')
  })
})

describe('simulation: an operation that ran and was won (ТЗ §11, §14, §17)', () => {
  let client: EmulatorBlockchainClient
  afterEach(() => client.dispose())

  it('pays the winner, pays the creator, and leaves nothing stranded', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config

    const before = await ledger(client)
    const { lobby, cost } = await openAndFill(client, config, [ALICE, BOB, CAROL])
    expect(lobby.status).toBe('ACTIVE')

    const attack = await launch(client, lobby)
    const attackId = lobby.activeAttackId!

    await sendReconProbe(client, ALICE, { lobbyId: lobby.id, attackId, probeId: 'probe-1' })
    await submitTimedDefenseAttempt(client, ALICE, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: onPath(client, lobby, config, 0.9),
      trajectory: sealedTrajectory(client, lobby.id, attackId),
      world: buildWorld(GRID, config.attack.sectorSpanKm),
      launchBlock: attack.launchBlock,
      flightBlocks: attack.flightDurationBlocks,
      defenseSpeedKmPerBlock: config.attack.defenseSpeedKmPerBlock,
    })
    await submitDefenseAttempt(client, BOB, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: awayFromPath(client, lobby, config),
    })

    await advanceTo(client, attack.impactBlock + 1)
    const resolved = await getLobby(client, lobby.id)
    expect(resolved!.outcome?.intercepted).toBe(true)
    expect(resolved!.outcome?.winners).toEqual([ALICE])

    await revealAttack(client, CAROL, { lobbyId: lobby.id, attackId })

    // ТЗ §14.6 — the Creator Fee is a claim like any other, not a payment
    // that happens to somebody while they are not looking.
    expect(await client.getBalance(CREATOR)).toBeCloseTo(before[CREATOR] - config.economics.prizePool)

    const reward = await claimReward(client, ALICE, { lobbyId: lobby.id, attackId })
    const creator = await settleCreator(client, CREATOR, lobby.id)

    const entryFees = config.participation.entryPrice * 3
    const creatorFee = entryFees * (config.economics.creatorFeePercent / 100)
    // The whole bounty plus what the entry fees left behind, exactly as the
    // contract routes it: the reward pool is everything the operation held
    // that was not a fee.
    expect(reward.amount).toBeCloseTo(config.economics.prizePool + entryFees)
    expect(creator.amount).toBeCloseTo(creatorFee)

    const after = await ledger(client)
    expect(total(after)).toBeCloseTo(total(before))
    // What the protocol keeps is the creation fee, and only the creation fee.
    expect(after[PROTOCOL_ESCROW_ADDRESS] - before[PROTOCOL_ESCROW_ADDRESS]).toBeCloseTo(
      config.economics.protocolJoinFee,
    )
    expect(await client.getBalance(ALICE)).toBeCloseTo(before[ALICE] - cost + reward.amount!)
  })

  it('forfeits the pool to the Global Defense Pool when the attack reaches Earth (ТЗ §17.1, §18)', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config

    const before = await ledger(client)
    const { lobby, cost } = await openAndFill(client, config, [ALICE, BOB])
    const attack = await launch(client, lobby)
    const attackId = lobby.activeAttackId!

    await submitDefenseAttempt(client, ALICE, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: awayFromPath(client, lobby, config),
    })
    await advanceTo(client, attack.impactBlock + 1)

    const resolved = await getLobby(client, lobby.id)
    expect(resolved!.outcome?.intercepted).toBe(false)
    expect(resolved!.outcome?.rewardPerWinner).toBe(0)

    // Nobody won, so nobody may claim.
    const nothing = await client.writeContract('claimReward', { lobbyId: lobby.id, attackId }, ALICE)
    expect(nothing.status).toBe('failed')
    expect(await client.getBalance(ALICE)).toBeCloseTo(before[ALICE] - cost)

    const entryFees = config.participation.entryPrice * 2
    const creatorFee = entryFees * (config.economics.creatorFeePercent / 100)
    const creator = await settleCreator(client, CREATOR, lobby.id)
    /*
     * ТЗ §18 — the fee, and *only* the fee.
     *
     * The rule this replaces gave the creator the unwon pool back on the
     * argument that the money had to go somewhere and they were the only
     * party with a claim on it. They were not: the pool is what the defenders
     * put up plus what the creator advertised, and handing it back on a miss
     * made a large advertised prize free to promise — it only ever left the
     * creator's hands when somebody earned it. It goes to the Global Defense
     * Pool now, to be played for by everybody at the next draw.
     */
    expect(creator.amount).toBeCloseTo(creatorFee)

    const after = await ledger(client)
    expect(total(after)).toBeCloseTo(total(before))
    // The escrow keeps the creation fee *and* the forfeited pool: it is still
    // holding the second on the game's behalf rather than anyone's.
    expect(after[PROTOCOL_ESCROW_ADDRESS] - before[PROTOCOL_ESCROW_ADDRESS]).toBeCloseTo(
      config.economics.protocolJoinFee + config.economics.prizePool + entryFees,
    )
  })

  it('lets a defender leave before the start and takes nothing for it', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config
    config.participation.deadline = Date.now() + 10_000

    const before = await ledger(client)
    const { lobby } = await createLobby(client, CREATOR, config)
    const cost = joinCostOf(config)

    await joinLobby(client, ALICE, lobby.id, cost)
    await buyDrone(client, ALICE, lobby.id, config.drones.price)
    await buyDrone(client, ALICE, lobby.id, config.drones.price)
    const { refunded } = await import('../../game/gameService').then((mod) =>
      mod.leaveLobby(client, ALICE, lobby.id),
    )

    expect(refunded).toBeCloseTo(cost + 2 * config.drones.price)
    expect(await client.getBalance(ALICE)).toBeCloseTo(before[ALICE])
    // The operation still holds exactly the creator's bounty and no more.
    const after = await ledger(client)
    expect(total(after)).toBeCloseTo(total(before))
    expect(after[PROTOCOL_ESCROW_ADDRESS] - before[PROTOCOL_ESCROW_ADDRESS]).toBeCloseTo(config.economics.prizePool)
  })
})

describe('simulation: nothing moves money without its owner asking (ТЗ §17.2)', () => {
  let client: EmulatorBlockchainClient
  afterEach(() => client.dispose())

  it('never pays a reward, a fee or a refund as a side effect of reading or of time passing', async () => {
    const built = buildClientAndConfig()
    client = built.client
    const config = built.config
    const { lobby } = await openAndFill(client, config, [ALICE, BOB])
    const attack = await launch(client, lobby)
    const attackId = lobby.activeAttackId!

    await submitTimedDefenseAttempt(client, ALICE, {
      lobbyId: lobby.id,
      attackId,
      defensePoint: onPath(client, lobby, config, 0.9),
      trajectory: sealedTrajectory(client, lobby.id, attackId),
      world: buildWorld(GRID, config.attack.sectorSpanKm),
      launchBlock: attack.launchBlock,
      flightBlocks: attack.flightDurationBlocks,
      defenseSpeedKmPerBlock: config.attack.defenseSpeedKmPerBlock,
    })

    const before = await ledger(client)
    await advanceTo(client, attack.impactBlock + 5)

    // Resolution, the reveal and every read in between: all of them are
    // free, and none of them pays anybody.
    await revealAttack(client, STRANGER, { lobbyId: lobby.id, attackId })
    await getLobby(client, lobby.id)
    await getParticipant(client, lobby.id, ALICE, ALICE)

    const after = await ledger(client)
    for (const who of [CREATOR, ALICE, BOB, PROTOCOL_ESCROW_ADDRESS]) {
      expect(after[who]).toBeCloseTo(before[who])
    }
    expect((await getParticipant(client, lobby.id, ALICE, ALICE))?.payoutState).toBe('PENDING')
  })
})
