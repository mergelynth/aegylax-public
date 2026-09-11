import { describe, expect, it } from 'vitest'
import { parseEnv, protocolGenesisBlock } from '../../config/env'
import { AEGYLAX_DEPLOYMENTS } from '../../contracts/generated'

/**
 * The deployment this suite asserts against — the real generated manifest,
 * because the whole point of these tests is that the *chain's* numbers reach
 * the UI rather than ENV's.
 */
const DEPLOYED = AEGYLAX_DEPLOYMENTS['84532']

function buildEnv(overrides: Partial<Record<string, string>>): ImportMetaEnv {
  const base: Record<string, string> = {
    VITE_APP_NAME: '',
    VITE_APP_SUBTITLE: '',
    VITE_BLOCKCHAIN_MODE: '',
    VITE_PRIVY_APP_ID: '',
    VITE_CHAIN_ID: '',
    VITE_RPC_URL: '',
    VITE_EXPLORER_URL: '',
    VITE_CONTRACT_ADDRESS: '',
    VITE_DEPLOYMENT_BLOCK: '',
    VITE_GENESIS_BLOCK: '',
    VITE_MIN_PLAYERS: '',
    VITE_MAX_PLAYERS: '',
    VITE_MIN_ENTRY_FEE: '',
    VITE_MAX_ENTRY_FEE: '',
    VITE_MIN_START_PRIZE_POOL: '',
    VITE_MIN_REGISTRATION_DURATION_MINUTES: '',
    VITE_MAX_REGISTRATION_DURATION_DAYS: '',
    VITE_MAX_CREATOR_FEE_PERCENT: '',
    VITE_MAX_RECON_PROBES: '',
    VITE_PROTOCOL_JOIN_FEE: '',
    VITE_CREATOR_FEE_PERCENT: '',
    VITE_DEFAULT_ENTRY_PRICE: '',
    VITE_GAME_CURRENCY: '',
    VITE_GAME_CURRENCY_NAME: '',
    VITE_GAME_CURRENCY_TOKEN: '',
    VITE_RECON_PROBE_FREE_COUNT: '',
    VITE_RECON_PROBE_PRICE: '',
    VITE_EMULATOR_INITIAL_BLOCK: '',
    VITE_EMULATOR_BLOCK_TIME_MS: '',
    VITE_ATTACK_EPOCH_BLOCKS: '',
    VITE_SECTOR_SPAN_KM: '',
    VITE_DEFENSE_INTERCEPTION_RADIUS: '',
    VITE_DEFENSE_SPEED_KM_PER_BLOCK: '',
    VITE_MAP_GRID_COLUMNS: '',
    VITE_MAP_GRID_ROWS: '',
  }
  return { ...base, ...overrides } as unknown as ImportMetaEnv
}

describe('parseEnv', () => {
  it('falls back to sane defaults when values are missing', () => {
    const config = parseEnv(buildEnv({}))
    expect(config.appName).toBe('AEGYLAX')
    expect(config.blockchainMode).toBe('emulator')
    expect(config.protocol.epochBlocks).toBe(150)
    expect(config.protocol.sectorSpanKm).toBe(1000)
    expect(config.protocol.interceptionRadiusSectors).toBeGreaterThan(0)
    expect(config.protocol.defenseSpeedKmPerBlock).toBeGreaterThan(0)
    expect(config.protocol.globalDefenseEpochInterval).toBe(1000)
    expect(config.protocol.globalDefenseJoinWindowMs).toBe(24 * 60 * 60 * 1000)
    expect(config.protocol.freeReconProbes).toBe(3)
    expect(config.map.columns).toBeGreaterThan(0)
    expect(config.currency).toEqual({ ticker: 'ETH', name: 'Ether', tokenAddress: null })
  })

  it('reads the game currency so a later USDC switch is ENV, not a UI rewrite', () => {
    const config = parseEnv(
      buildEnv({
        VITE_GAME_CURRENCY: 'usdc',
        VITE_GAME_CURRENCY_NAME: 'USD Coin',
        VITE_GAME_CURRENCY_TOKEN: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      }),
    )
    expect(config.currency.ticker).toBe('USDC')
    expect(config.currency.name).toBe('USD Coin')
    expect(config.currency.tokenAddress).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
  })

  it('treats a blank or malformed currency token as the native coin', () => {
    expect(parseEnv(buildEnv({ VITE_GAME_CURRENCY_TOKEN: '   ' })).currency.tokenAddress).toBeNull()
    expect(parseEnv(buildEnv({ VITE_GAME_CURRENCY_TOKEN: 'not-an-address' })).currency.tokenAddress).toBeNull()
  })

  it('falls back to protocol limits that keep a defense operation playable', () => {
    const config = parseEnv(buildEnv({}))
    expect(config.protocol.minPlayers).toBe(2)
    expect(config.protocol.maxPlayers).toBe(20)
    expect(config.protocol.maxCreatorFeePercent).toBe(5)
    expect(config.protocol.maxReconProbes).toBe(6)
  })

  it('takes the player floor from the protocol config, never below one player', () => {
    expect(parseEnv(buildEnv({ VITE_MIN_PLAYERS: '1' })).protocol.minPlayers).toBe(1)
    expect(parseEnv(buildEnv({ VITE_MIN_PLAYERS: '4' })).protocol.minPlayers).toBe(4)
    expect(parseEnv(buildEnv({ VITE_MIN_PLAYERS: '0' })).protocol.minPlayers).toBe(1)
  })

  it('reads the start prize pool the creator must fund', () => {
    expect(parseEnv(buildEnv({ VITE_MIN_START_PRIZE_POOL: '0.05' })).protocol.minStartPrizePool).toBe(0.05)
    expect(parseEnv(buildEnv({})).protocol.minStartPrizePool).toBe(0)
  })

  it('reads registration-window limits in their ENV units', () => {
    const config = parseEnv(
      buildEnv({ VITE_MIN_REGISTRATION_DURATION_MINUTES: '15', VITE_MAX_REGISTRATION_DURATION_DAYS: '7' }),
    )
    expect(config.protocol.minRegistrationDurationMs).toBe(15 * 60 * 1000)
    expect(config.protocol.maxRegistrationDurationMs).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('parses provided numeric/string values', () => {
    const config = parseEnv(
      buildEnv({
        VITE_BLOCKCHAIN_MODE: 'contract',
        VITE_CHAIN_ID: '8453',
        VITE_ATTACK_EPOCH_BLOCKS: '75',
        VITE_MAX_RECON_PROBES: '6',
      }),
    )
    expect(config.blockchainMode).toBe('contract')
    expect(config.chainId).toBe(8453)
    expect(config.protocol.epochBlocks).toBe(75)
    expect(config.protocol.maxReconProbes).toBe(6)
  })

  // ENV still decides it for a build with no deployment behind it — the
  // emulator, where dropping the interval to 2 is how the rollover gets
  // exercised without waiting a thousand epochs. Point the same config at a
  // chain and the manifest wins; see the deployment suite below.
  it('reads the Global Defense draw cadence from ENV when no chain has answered', () => {
    expect(parseEnv(buildEnv({})).protocol.globalDefenseEpochInterval).toBe(1000)
    expect(parseEnv(buildEnv({ VITE_GLOBAL_DEFENSE_EPOCH_INTERVAL: '2' })).protocol.globalDefenseEpochInterval).toBe(2)
    expect(parseEnv(buildEnv({ VITE_GLOBAL_DEFENSE_EPOCH_INTERVAL: '0' })).protocol.globalDefenseEpochInterval).toBe(0)
    expect(parseEnv(buildEnv({ VITE_GLOBAL_DEFENSE_JOIN_WINDOW_HOURS: '12' })).protocol.globalDefenseJoinWindowMs).toBe(
      12 * 60 * 60 * 1000,
    )
  })

  it('treats an unrecognized mode string as emulator', () => {
    const config = parseEnv(buildEnv({ VITE_BLOCKCHAIN_MODE: 'nonsense' }))
    expect(config.blockchainMode).toBe('emulator')
  })
})

describe('parseEnv: authentication', () => {
  it('carries the auth block through, so the app has one config object', () => {
    const config = parseEnv(buildEnv({ VITE_BLOCKCHAIN_MODE: 'contract', VITE_PRIVY_APP_ID: 'app-id' }))
    expect(config.auth.provider).toBe('privy')
    expect(config.auth.appId).toBe('app-id')
  })

  it('leaves emulator mode on the local identity, app id or not (ТЗ §8)', () => {
    const config = parseEnv(buildEnv({ VITE_BLOCKCHAIN_MODE: 'emulator', VITE_PRIVY_APP_ID: 'app-id' }))
    expect(config.auth.provider).toBe('local')
  })
})

/**
 * The deployment, not the `.env`, decides what a creator may pick.
 *
 * Chain 84532 has a manifest committed in this repository, so pointing the
 * config at it is enough to exercise the real path — which is the point of
 * testing it this way rather than against a fixture: what these assertions
 * pin is that the numbers a build shows come from the same place the
 * contract enforces them from.
 */
describe('parseEnv: protocol limits come from the deployment', () => {
  const deployedEnv = (overrides: Partial<Record<string, string>> = {}) =>
    buildEnv({ VITE_BLOCKCHAIN_MODE: 'contract', VITE_CHAIN_ID: '84532', ...overrides })

  it('overrides ENV with what initialize() wrote into contract storage', () => {
    // Deliberately absurd ENV values, of the kind a `.env` collects while
    // somebody is testing something: none of them may reach the UI.
    const config = parseEnv(
      deployedEnv({
        VITE_MIN_PLAYERS: '1',
        VITE_MAX_PLAYERS: '3',
        VITE_ATTACK_EPOCH_BLOCKS: '150',
        VITE_RECON_PROBE_PRICE: '9.99',
      }),
    )

    const params = DEPLOYED.params
    if (!params) throw new Error('the generated manifest for 84532 has no params to convert')

    expect(config.protocol.minPlayers).toBe(Number(params.minPlayers))
    expect(config.protocol.maxPlayers).toBe(Number(params.maxPlayers))
    expect(config.protocol.epochBlocks).toBe(Number(params.epochBlocks))
    expect(config.protocol.reconProbePrice).toBeCloseTo(Number(params.probePrice) / 1e18, 12)
  })

  /*
   * The draw cadence takes the same route as the limits above and arrives by
   * a different door: it is not a `GameParams` field, because that struct is
   * snapshotted onto every lobby and has no room for a protocol-wide
   * setting, so on chain it has its own slot and in the manifest it sits
   * beside `params`.
   *
   * It is pinned here because the consequence of getting it wrong is
   * invisible rather than loud. A build counting down to every 1000th epoch
   * against a contract set to something else does not fail — it points a
   * countdown at an epoch where nothing is ever going to open, which is what
   * the deployment did for its whole life while the slot sat at zero.
   */
  it('takes the Global Defense cadence from the chain, not from ENV', () => {
    const recorded = DEPLOYED.globalDefenseEpochInterval
    if (typeof recorded !== 'number') {
      throw new Error('the generated manifest for 84532 has no globalDefenseEpochInterval')
    }

    const config = parseEnv(deployedEnv({ VITE_GLOBAL_DEFENSE_EPOCH_INTERVAL: '7' }))
    expect(config.protocol.globalDefenseEpochInterval).toBe(recorded)
    expect(config.protocol.globalDefenseEpochInterval).not.toBe(7)
  })

  it('converts the chain\'s units into the ones the UI works in', () => {
    const config = parseEnv(deployedEnv())

    /*
     * Each expectation is *derived from the manifest*, not written out as a
     * literal, and that is the difference between testing the conversion and
     * testing today's deployment. A hard-coded `0.00001` here broke the moment
     * the protocol fee was governed on chain — which is a parameter change
     * working exactly as designed, reported as a unit-conversion failure.
     */
    // Present by construction — `chain:sync` writes it — but the generated
    // type allows a manifest from before params were recorded.
    const params = DEPLOYED.params
    if (!params) throw new Error('the generated manifest for 84532 has no params to convert')
    const wei = (value: string) => Number(value) / 1e18

    // wei -> ETH
    expect(config.protocol.maxEntryPrice).toBeCloseTo(wei(params.maxEntryFee), 12)
    expect(config.protocol.joinFee).toBeCloseTo(wei(params.protocolJoinFee), 12)
    // basis points -> percent
    expect(config.protocol.maxCreatorFeePercent).toBe(Number(params.maxCreatorFeeBps) / 100)
    // thousandths of a sector -> sectors
    expect(config.protocol.interceptionRadiusSectors).toBeCloseTo(
      Number(params.interceptRadiusMilliSectors) / 1000,
      12,
    )
    // seconds -> ms
    expect(config.protocol.maxRegistrationDurationMs).toBe(Number(params.maxRegistrationSeconds) * 1000)
  })

  it('draws the playfield at the resolution the contract measures against', () => {
    const config = parseEnv(deployedEnv({ VITE_MAP_GRID_COLUMNS: '40', VITE_MAP_GRID_ROWS: '25' }))
    expect(config.map.columns).toBe(10)
    expect(config.map.rows).toBe(5)
  })

  it('measures the epoch grid from the contract genesis, not the proxy deploy block', () => {
    const config = parseEnv(deployedEnv())
    expect(config.deployment.genesisBlock).toBe(DEPLOYED.genesisBlock)
    expect(protocolGenesisBlock(config)).toBe(DEPLOYED.genesisBlock)
  })

  /*
   * The two numbers coincide on a first deployment and diverge once a chain
   * has been redeployed onto an older epoch grid, so the shipped manifest
   * cannot demonstrate the difference — it only happens to show one or the
   * other. An explicit override is what proves the grid follows the
   * contract's genesis rather than the block its proxy landed in.
   */
  it('prefers the contract genesis over the deploy block when they differ', () => {
    const config = parseEnv(deployedEnv({ VITE_GENESIS_BLOCK: '12345', VITE_DEPLOYMENT_BLOCK: '99999' }))
    expect(config.deployment.deploymentBlock).toBe(99999)
    expect(config.deployment.genesisBlock).toBe(12345)
    expect(protocolGenesisBlock(config)).toBe(12345)
  })

  it('falls back to ENV where there is no deployment to ask', () => {
    const config = parseEnv(buildEnv({ VITE_MAX_PLAYERS: '9999', VITE_ATTACK_EPOCH_BLOCKS: '150' }))
    expect(config.deployment.configured).toBe(false)
    expect(config.protocol.maxPlayers).toBe(9999)
    expect(config.protocol.epochBlocks).toBe(150)
  })
})
