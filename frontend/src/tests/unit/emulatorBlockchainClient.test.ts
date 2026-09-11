import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EmulatorBlockchainClient } from '../../blockchain/EmulatorBlockchainClient'
import { buildDefaultLobbyConfig } from '../../config/gameConfig'
import { parseEnv } from '../../config/env'
import { joinCostOf } from '../../game/economics'
import type { Address } from '../../game/types'

const ADDRESS_A = '0x1111111111111111111111111111111111111a' as Address
const ADDRESS_B = '0x2222222222222222222222222222222222222b' as Address

function buildEnv(overrides: Partial<Record<string, string>> = {}): ImportMetaEnv {
  const base: Record<string, string> = {
    VITE_APP_NAME: '',
    VITE_APP_SUBTITLE: '',
    VITE_BLOCKCHAIN_MODE: 'emulator',
    VITE_PRIVY_APP_ID: '',
    VITE_CHAIN_ID: '',
    VITE_RPC_URL: '',
    VITE_EXPLORER_URL: '',
    VITE_CONTRACT_ADDRESS: '',
    VITE_PROTOCOL_JOIN_FEE: '0',
    VITE_CREATOR_FEE_PERCENT: '5',
    VITE_DEFAULT_ENTRY_PRICE: '0.01',
    VITE_RECON_PROBE_FREE_COUNT: '3',
    VITE_RECON_PROBE_PRICE: '0.002',
    VITE_EMULATOR_INITIAL_BLOCK: '1',
    VITE_EMULATOR_BLOCK_TIME_MS: '2000',
    VITE_ATTACK_EPOCH_BLOCKS: '10',
    VITE_MAP_GRID_COLUMNS: '8',
    VITE_MAP_GRID_ROWS: '8',
  }
  return { ...base, ...overrides } as unknown as ImportMetaEnv
}

/**
 * A very large block time so the background ticker never fires during a
 * test. `protocolLimits` comes from the same ENV the lobby configs are
 * built from — the client rejects any config that disagrees with the
 * protocol rules it was constructed with.
 */
function createClient(envOverrides: Partial<Record<string, string>> = {}): EmulatorBlockchainClient {
  return new EmulatorBlockchainClient({
    initialBlock: 1,
    blockTimeMs: 10_000_000,
    mapGrid: { columns: 8, rows: 8 },
    epochBlocks: 150,
    protocolLimits: parseEnv(buildEnv(envOverrides)).protocol,
  })
}

/** The opposite: a block time short enough to observe the ticker running. */
function createTickingClient(): EmulatorBlockchainClient {
  return new EmulatorBlockchainClient({
    initialBlock: 1,
    blockTimeMs: 5,
    mapGrid: { columns: 8, rows: 8 },
    epochBlocks: 150,
    protocolLimits: parseEnv(buildEnv()).protocol,
  })
}

describe('EmulatorBlockchainClient block clock', () => {
  let client: EmulatorBlockchainClient
  beforeEach(() => {
    client = createClient()
  })
  afterEach(() => {
    client.dispose()
  })

  it('starts at the configured initial block', async () => {
    expect(await client.getBlockNumber()).toBe(1)
  })

  it('advances blocks synchronously and instantly, with no real waiting', async () => {
    const start = performance.now()
    client.advanceBlocks(500)
    const elapsed = performance.now() - start
    expect(await client.getBlockNumber()).toBe(501)
    expect(elapsed).toBeLessThan(200)
  })

  it('mints deterministic, unique block hashes as it advances', async () => {
    client.advanceBlocks(3)
    const blockTwo = await client.getBlock(2)
    const blockThree = await client.getBlock(3)
    expect(blockTwo.hash).not.toBe(blockThree.hash)
    expect(blockThree.parentHash).toBe(blockTwo.hash)
  })

  /**
   * StrictMode tears the provider effect down and sets it up again on the
   * same client. If `start()` could not revive a disposed ticker, the chain
   * would freeze for the whole session and every block-derived readout —
   * the next-attack countdown above all — would stall with it.
   */
  it('keeps mining after a dispose/start cycle', async () => {
    const ticking = createTickingClient()
    try {
      ticking.dispose()
      ticking.start()

      const before = await ticking.getBlockNumber()
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(await ticking.getBlockNumber()).toBeGreaterThan(before)
    } finally {
      ticking.dispose()
    }
  })

  it('stops mining once disposed', async () => {
    const ticking = createTickingClient()
    ticking.dispose()

    const before = await ticking.getBlockNumber()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(await ticking.getBlockNumber()).toBe(before)
  })
})

describe('EmulatorBlockchainClient transactions', () => {
  let client: EmulatorBlockchainClient
  beforeEach(() => {
    client = createClient()
  })
  afterEach(() => {
    client.dispose()
  })

  it('generates a unique tx hash per write call and confirms via waitForTransaction', async () => {
    const config = { ...buildDefaultLobbyConfig(parseEnv(buildEnv()), Date.now()), name: 'Test Operation' }
    const submitted = await client.writeContract('createLobby', { config, value: 0 }, ADDRESS_A)
    expect(submitted.hash).toMatch(/^0x[0-9a-f]{64}$/)

    const confirmed = await client.waitForTransaction(submitted.hash)
    expect(confirmed.status).toBe('confirmed')
    expect(confirmed.events[0]?.name).toBe('LobbyCreated')
  })

  it('uses the creation transaction hash as the lobby id (spec §14)', async () => {
    const config = { ...buildDefaultLobbyConfig(parseEnv(buildEnv()), Date.now()), name: 'Test Operation' }
    const tx = await client.writeContract('createLobby', { config, value: 0 }, ADDRESS_A)
    const lobby = await client.readContract('getLobby', { lobbyId: tx.hash })
    expect(lobby).not.toBeNull()
    expect(lobby?.id).toBe(tx.hash)
    expect(lobby?.creationTxHash).toBe(tx.hash)
  })

  it('fails the transaction when the joiner sends less than the required entry cost', async () => {
    const config = { ...buildDefaultLobbyConfig(parseEnv(buildEnv()), Date.now()), name: 'Test Operation' }
    const createTx = await client.writeContract('createLobby', { config, value: 0 }, ADDRESS_A)
    const joinTx = await client.writeContract('joinLobby', { lobbyId: createTx.hash, value: 0 }, ADDRESS_B)
    expect(joinTx.status).toBe('failed')
    expect(joinTx.errorMessage).toMatch(/entry cost/i)
  })

  it('joins successfully with sufficient value and increments participant count', async () => {
    const config = { ...buildDefaultLobbyConfig(parseEnv(buildEnv()), Date.now()), name: 'Test Operation' }
    const createTx = await client.writeContract('createLobby', { config, value: 0 }, ADDRESS_A)
    const cost = joinCostOf(config)
    const joinTx = await client.writeContract('joinLobby', { lobbyId: createTx.hash, value: cost }, ADDRESS_B)
    expect(joinTx.status).toBe('confirmed')

    const lobby = await client.readContract('getLobby', { lobbyId: createTx.hash })
    expect(lobby?.participantCount).toBe(1)
  })
})

describe('EmulatorBlockchainClient getGameStats', () => {
  let client: EmulatorBlockchainClient
  beforeEach(() => {
    client = createClient()
  })
  afterEach(() => {
    client.dispose()
  })

  it('reports the protocol epoch from the canonical block-based epoch math', async () => {
    // epochBlocks 150 from genesis block 1: block 1 is epoch 0, and 150
    // blocks later the protocol has moved into epoch 1.
    expect((await client.readContract('getGameStats', {})).currentEpoch).toBe(0)

    client.advanceBlocks(149)
    expect((await client.readContract('getGameStats', {})).currentEpoch).toBe(0)

    client.advanceBlocks(1)
    const stats = await client.readContract('getGameStats', {})
    expect(stats.currentBlock).toBe(151)
    expect(stats.currentEpoch).toBe(1)
  })

  it('counts each created defense operation once, no matter how many participants join it', async () => {
    const config = { ...buildDefaultLobbyConfig(parseEnv(buildEnv()), Date.now()), name: 'Test Operation' }
    const createTx = await client.writeContract('createLobby', { config, value: 0 }, ADDRESS_A)
    const cost = joinCostOf(config)
    await client.writeContract('joinLobby', { lobbyId: createTx.hash, value: cost }, ADDRESS_B)

    const stats = await client.readContract('getGameStats', {})
    expect(stats.totalLobbies).toBe(1)
  })

  it('keeps totalLobbies as a lifetime count once an operation is no longer active', async () => {
    const config = { ...buildDefaultLobbyConfig(parseEnv(buildEnv()), Date.now()), name: 'Test Operation' }
    // Nobody can join in time, so the deadline cancels the operation — but it
    // was still created, so it stays in the lifetime count.
    config.participation.minPlayers = 2
    config.participation.deadline = Date.now() + 400
    await client.writeContract('createLobby', { config, value: 0 }, ADDRESS_A)
    await new Promise((resolve) => setTimeout(resolve, 350))

    const stats = await client.readContract('getGameStats', {})
    expect(stats.activeLobbies).toBe(0)
    expect(stats.totalLobbies).toBe(1)
  })

  /**
   * ТЗ §7 — the protocol attacks Earth once an epoch, defended or not. So
   * the lifetime attack count follows the epoch clock rather than the
   * number of operations anybody happened to create.
   */
  it('counts one attack per finished epoch, with no lobby anywhere in sight', async () => {
    const quiet = await client.readContract('getGameStats', {})
    expect(quiet.totalLobbies).toBe(0)
    expect(quiet.totalAttacks).toBe(0)

    // Three full epochs pass with nothing organised against them.
    client.advanceBlocks(3 * 150)
    const after = await client.readContract('getGameStats', {})

    expect(after.currentEpoch).toBe(3)
    expect(after.totalAttacks).toBe(3)
    // ТЗ §7 — none were intercepted, so all three are unintercepted.
    expect(after.interceptedAttacks).toBe(0)
    expect(after.missedAttacks).toBe(3)
  })

  it('does not double-count attacks across repeated reads', async () => {
    client.advanceBlocks(2 * 150)

    const first = await client.readContract('getGameStats', {})
    const second = await client.readContract('getGameStats', {})

    expect(first.totalAttacks).toBeGreaterThan(0)
    expect(second.totalAttacks).toBe(first.totalAttacks)
    // With nothing in flight, the three agree: every attack is either
    // stopped or it lands.
    expect(first.interceptedAttacks + first.missedAttacks).toBe(first.totalAttacks)
  })

  /**
   * An attack that is still in the sky has no verdict, and the status bar
   * must not invent one for it.
   *
   * The epoch ticks over at exactly the block the attack launches from, so
   * a `missed = total - intercepted` rule announced the impact at the
   * *start* of the round — players were watching the Impacts counter go up
   * while they still had probes in hand and no Defense Point placed.
   */
  it('never counts an attack still in flight as an impact (ТЗ §7)', async () => {
    const config = { ...buildDefaultLobbyConfig(parseEnv(buildEnv()), Date.now()), name: 'In flight' }
    config.participation.deadline = Date.now() + 900
    const createTx = await client.writeContract('createLobby', { config, value: 0 }, ADDRESS_A)
    expect(createTx.status).toBe('confirmed')
    const cost = joinCostOf(config)
    // Two defenders, so the operation meets its minimum and actually starts.
    await client.writeContract('joinLobby', { lobbyId: createTx.hash, value: cost }, ADDRESS_A)
    await client.writeContract('joinLobby', { lobbyId: createTx.hash, value: cost }, ADDRESS_B)

    // The deadline passes; the first read settles the lobby to ACTIVE and
    // schedules its one attack on the next epoch boundary.
    await new Promise((resolve) => setTimeout(resolve, 700))
    const lobby = await client.readContract('getLobby', { lobbyId: createTx.hash })
    const attackId = lobby!.activeAttackId!
    const scheduled = await client.readContract('getAttack', { lobbyId: createTx.hash, attackId })

    client.advanceBlocks(scheduled!.launchBlock - (await client.getBlockNumber()))
    const inFlight = await client.readContract('getGameStats', {})

    expect((await client.readContract('getAttack', { lobbyId: createTx.hash, attackId }))!.status).toBe('LAUNCHED')
    expect(inFlight.totalAttacks).toBe(1)
    expect(inFlight.interceptedAttacks).toBe(0)
    // The round is under way. Nothing is known about it yet.
    expect(inFlight.missedAttacks).toBe(0)

    // And once it lands undefended, it counts — then and not before.
    client.advanceBlocks(scheduled!.impactBlock - (await client.getBlockNumber()))
    const landed = await client.readContract('getGameStats', {})
    expect(landed.missedAttacks).toBe(1)
  })
})

/**
 * ТЗ §5 — Leave Operation, and the refund that is the whole point of it.
 * Nothing a withdrawing defender paid for was ever delivered, so all of it
 * comes back.
 */
describe('EmulatorBlockchainClient leaveLobby', () => {
  it('refunds the entry, the author commission and every Recon Probe bought', async () => {
    const overrides = { VITE_PROTOCOL_JOIN_FEE: '0.001' }
    const client = createClient(overrides)
    try {
      const config = { ...buildDefaultLobbyConfig(parseEnv(buildEnv(overrides)), Date.now()), name: 'Withdrawable' }
      // ТЗ §17 — the creator holds a seat too, so creating costs the bounty
      // plus the same per-seat protocol fee a joiner pays.
      const createCost = config.economics.prizePool + config.economics.protocolJoinFee
      const createTx = await client.writeContract('createLobby', { config, value: createCost }, ADDRESS_A)
      const entryCost = joinCostOf(config)

      const opening = await client.getBalance(ADDRESS_B)
      await client.writeContract('joinLobby', { lobbyId: createTx.hash, value: entryCost }, ADDRESS_B)
      await client.writeContract('buyDrone', { lobbyId: createTx.hash, value: config.drones.price }, ADDRESS_B)
      await client.writeContract('buyDrone', { lobbyId: createTx.hash, value: config.drones.price }, ADDRESS_B)

      const spent = entryCost + 2 * config.drones.price
      expect(await client.getBalance(ADDRESS_B)).toBeCloseTo(opening - spent, 12)

      const leaveTx = await client.writeContract('leaveLobby', { lobbyId: createTx.hash }, ADDRESS_B)
      expect(leaveTx.status).toBe('confirmed')
      expect(leaveTx.events[0]?.name).toBe('LobbyLeft')
      // The probes are not forfeit: the refund is everything that went in.
      expect((leaveTx.events[0]?.payload as { refunded: number }).refunded).toBeCloseTo(spent, 12)
      expect(await client.getBalance(ADDRESS_B)).toBeCloseTo(opening, 12)

      const lobby = await client.readContract('getLobby', { lobbyId: createTx.hash })
      expect(lobby?.participantCount).toBe(0)
    } finally {
      client.dispose()
    }
  })
})
