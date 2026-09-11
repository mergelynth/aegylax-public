import { parseAuthConfig, type AuthConfig } from './auth'
import { resolveDeployment, type DeploymentInfo } from './deployment'
import {
  readBoolean,
  readNumber,
  readOptionalNumber,
  readOptionalString,
  readString,
  readTimestamp,
} from './readEnv'

export type BlockchainMode = 'emulator' | 'contract'

/**
 * The protocol's own rules — the boundaries a Defense Operation creator
 * can never step outside of. These are game rules, not lobby parameters:
 * the Create Defense Operation form only lets a creator pick values
 * *inside* these ranges, and `validateLobbyConfig` re-checks every one of
 * them at creation time so a hand-edited payload cannot bypass the form.
 *
 * In contract mode these come from the *deployment* rather than from ENV:
 * `initialize()` wrote them into contract storage, `chain:sync` carried them
 * into the generated manifest, and `protocolLimitsFromParams` reads them back
 * (spec §15, §22). ENV is the fallback for a build with no deployment behind
 * it — the emulator — and, either way, the chain re-validates every one of
 * them, so the frontend copy exists to show ranges and fail fast rather than
 * to be the authority.
 */
export interface ProtocolLimits {
  /** Absolute lower boundary for a creator's `minPlayers`. Never 1. */
  minPlayers: number
  /**
   * Absolute upper boundary for a creator's `maxPlayers`.
   *
   * Live Sepolia is 25 (`deployments/84532.json`). The Solidity field is
   * `uint16` (65535) and `ProtocolRules` only checks `max >= min`. Reveal
   * ACL is O(1) (one pad key); scoring is batched at `MAX_SCORE_BATCH`
   * (32). 25 is the live parameter, not a type or ACL limit.
   */
  maxPlayers: number
  /** ETH */
  minEntryPrice: number
  /** ETH */
  maxEntryPrice: number
  /**
   * ETH the creator must actually fund the operation with. A non-zero
   * value makes the creator put up the initial reward pool; 0 allows an
   * operation whose pool comes purely from entries.
   */
  minStartPrizePool: number
  /** Shortest allowed application window, in ms. 0 disables the check (only "must be in the future" applies). */
  minRegistrationDurationMs: number
  /** Longest allowed application window, in ms. */
  maxRegistrationDurationMs: number
  maxCreatorFeePercent: number
  /**
   * Recon Probes one player may send per attack.
   *
   * Protocol-owned rather than creator-set, and so is the price below. The
   * epoch's attack is one object every operation is defending against, so
   * what a probe reveals is worth the same everywhere — a creator who could
   * price it would only be deciding which operation everybody buys their
   * reconnaissance in (ТЗ §3).
   */
  maxReconProbes: number
  /** Recon Probes every player starts an attack with. */
  freeReconProbes: number
  /** ETH — what one Recon Probe costs. A price, not a ceiling. */
  reconProbePrice: number
  /** Flat protocol fee per join — protocol-owned, never creator-set. */
  joinFee: number
  /**
   * Attack cadence — protocol-owned, never creator-set. An operation's one
   * attack launches at an epoch boundary and impacts at the next, so this
   * is also the flight duration (ТЗ §5.3).
   */
  epochBlocks: number
  /**
   * Side of one sector in km — the playfield's only declared scale. Speed
   * is not a protocol constant any more: each attack derives its own from
   * how far it has to travel (ТЗ §5.4), so this is what fixes how big the
   * world is.
   */
  sectorSpanKm: number
  /**
   * `DEFENSE_INTERCEPTION_RADIUS` (ТЗ §10.2) — how close a Defense Point
   * has to be for the threat to enter its radius, measured in sectors so
   * it means the same thing whatever the grid resolution or km scale.
   * Protocol-owned: a player cannot change it (§10.3), and the same value
   * is used by the frontend's drawing, the private computation and the
   * contract's verification (§10.4).
   */
  interceptionRadiusSectors: number
  /**
   * Unused in scoring: the snapshot is the submit block. Kept so GameParams
   * layout and existing deployments stay compatible.
   */
  defenseSpeedKmPerBlock: number
  /**
   * How often the Global Defense Pool is played for, in epochs (ТЗ §18).
   *
   * Every COMPLETED round the threat won forfeits its pool here. Once every
   * `globalDefenseEpochInterval` epochs the protocol opens a free-to-enter
   * operation of its own with the whole accumulated pool as the bounty. A
   * draw nobody wins returns the pool by the same rule and waits for the
   * next interval. `0` disables the draw and leaves the pool accumulating.
   *
   * This is the knob meant to move often in testing — drop it to 2 or 3 so
   * a jackpot rollover is a few epochs away rather than a thousand. On a
   * live deployment the chain's own `globalDefenseEpochInterval` is the
   * authority; this ENV value is what the emulator (and a build with no
   * deployment) uses.
   */
  globalDefenseEpochInterval: number
  /**
   * How long a Global Defense draw stays open for applications, in ms.
   *
   * A calendar day by default, so there is time to notice and join. If the
   * whole interval is shorter than this (a test cadence, or huge epochs),
   * the window shrinks to half the interval so the other half can still
   * accumulate toward the next draw.
   */
  globalDefenseJoinWindowMs: number
}

export interface AppConfig {
  appName: string
  appSubtitle: string
  blockchainMode: BlockchainMode
  /**
   * How a player signs in and where their wallet comes from, described
   * without naming a vendor. `auth/` is the only layer that reads it.
   */
  auth: AuthConfig
  chainId: number | null
  /** The first configured endpoint — what a single-URL consumer means by "the RPC". */
  rpcUrl: string | null
  /**
   * Every endpoint this build may read through, in the order they were
   * given (`VITE_RPC_URL` is comma-separated).
   *
   * More than one is not redundancy for its own sake: a public endpoint
   * answers a page that reads on every block with a rate limit, and a
   * browser cannot retry its way out of one. The contract client puts them
   * behind a fallback transport that ranks them by how they are actually
   * behaving.
   */
  rpcUrls: string[]
  explorerUrl: string | null
  contractAddress: `0x${string}` | null
  /**
   * The deployment this build talks to, resolved from the generated
   * manifest with ENV overriding it (ТЗ §8, §9). Nothing else in the app
   * may hold a contract address.
   */
  deployment: DeploymentInfo
  /**
   * Average block time in ms for the active network, used only to turn
   * block numbers into human countdowns. Never for game state: every
   * authoritative deadline in the protocol is a block number.
   */
  blockTimeMs: number
  /** Hard protocol boundaries (spec §16-17) — not defaults, but limits. */
  protocol: ProtocolLimits
  economics: {
    protocolJoinFee: number
    creatorFeePercent: number
    defaultEntryPrice: number
  }
  /**
   * What the protocol pays and prices in — the ticker on screen, and the
   * coin itself when that is not the chain's native token.
   *
   * Today this is ETH. Switching the prize to USDC (or anything else) is
   * these three values, not a hunt through components: the ticker is what
   * every amount is labelled with, the name is what a tooltip says, and
   * `tokenAddress` is empty for the native coin and an ERC-20 when it is
   * not. The contract still has to accept that token; this is only the
   * frontend's name for it.
   */
  currency: {
    ticker: string
    name: string
    tokenAddress: `0x${string}` | null
  }
  emulator: {
    initialBlock: number
    blockTimeMs: number
  }
  map: {
    columns: number
    rows: number
    /**
     * Whether the A-J / 1-5 axis labels are drawn along the grid's edges.
     *
     * Off by default. The grid is orientation, and the labels turned out to
     * be the part of it that reads as chrome: a player picks a sector by
     * clicking it and identifies it from the badge under the pointer, so
     * the permanent letters and numbers around the board were spending
     * attention on a coordinate system nobody has to name out loud.
     */
    showGridLabels: boolean
  }
  /**
   * Which provider theme to paint in, overriding the one the deployment's
   * confidential engine implies (`VITE_PROVIDER_THEME`).
   *
   * Empty is the normal case, and the normal case is the point: the theme
   * follows the provider the build actually talks to, so nothing has to be
   * kept in agreement with anything. This exists for previewing another
   * provider's look against an existing deployment — a demo concern, not a
   * deployment one — and it changes only paint, never which confidential
   * network the client encrypts against.
   */
  providerTheme: string | null
  /**
   * Outbound links the UI offers, so no component ever holds a URL.
   *
   * The confidential network's site is the one a player follows to check
   * who provides the privacy this protocol rests on; it belongs to whoever
   * the deployment is wired to, so it is ENV rather than a constant in a
   * component (ТЗ §12).
   */
  links: {
    /** Site of whoever provides confidentiality for this deployment. */
    privacyLayerUrl: string | null
  }
  /**
   * Where the backend lives, without a trailing slash.
   *
   * Empty means "same origin", which is what a dev server with a proxy
   * gives you. The demo splits the two — the page is on Vercel, the backend
   * on Render — so this is the only way the browser knows where to ask, and
   * it is `VITE_` on purpose: it is a public URL, not a secret. Nothing that
   * has to stay secret is ever reachable from this config.
   */
  apiBaseUrl: string
  /**
   * The Event Horizon countdown — Day X (spec §15-19).
   *
   * A base date the protocol moves away from, and the two rates it moves at.
   * They are deliberately *asymmetric*: a miss pulls the date closer by a
   * little, an interception pushes it back by ten times as much, so one
   * successful defense pays for ten failures. That ratio is the whole
   * economic statement of the timer — a planet that mostly loses still slides
   * towards the horizon, and a run of interceptions is visibly worth
   * something rather than merely cancelling the last miss.
   *
   *     DayX = base − (misses × daysPerMiss) + (intercepts × daysPerIntercept)
   */
  apocalypse: {
    baseTimestamp: number
    /** Days one missed attack pulls Day X *closer*. */
    daysPerMiss: number
    /** Days one interception pushes Day X *further away*. */
    daysPerIntercept: number
  }
}

function readMode(value: string | undefined): BlockchainMode {
  return value?.trim() === 'contract' ? 'contract' : 'emulator'
}

const WEI_PER_ETH = 1e18

/** A decimal wei string from the manifest, as the ETH figure the UI works in. */
function weiToEth(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed / WEI_PER_ETH : null
}

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function readOptionalAddress(value: string | undefined): `0x${string}` | null {
  const trimmed = value?.trim()
  if (!trimmed) return null
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return null
  return trimmed as `0x${string}`
}

/**
 * The deployed contract's own limits, in the units the app works in.
 *
 * Every field is a straight unit conversion of something `initialize()` put
 * in storage — wei to ETH, seconds to ms, basis points to percent,
 * thousandths of a sector to sectors. A field the manifest does not carry is
 * left out rather than guessed, so the ENV value stays in place for it.
 */
function protocolLimitsFromParams(params: DeploymentInfo['params']): Partial<ProtocolLimits> {
  if (!params) return {}

  const limits: Partial<ProtocolLimits> = {}
  const assign = <TKey extends keyof ProtocolLimits>(key: TKey, value: number | null) => {
    if (value !== null) limits[key] = value
  }

  assign('minPlayers', toNumber(params.minPlayers))
  assign('maxPlayers', toNumber(params.maxPlayers))
  assign('minEntryPrice', weiToEth(params.minEntryFee))
  assign('maxEntryPrice', weiToEth(params.maxEntryFee))
  assign('minStartPrizePool', weiToEth(params.minStartPrizePool))
  assign('reconProbePrice', weiToEth(params.probePrice))
  assign('joinFee', weiToEth(params.protocolJoinFee))
  assign('maxReconProbes', toNumber(params.maxProbesPerPlayer))
  assign('freeReconProbes', toNumber(params.freeProbes))
  assign('epochBlocks', toNumber(params.epochBlocks))
  assign('sectorSpanKm', toNumber(params.sectorSpanKm))

  const minRegistrationSeconds = toNumber(params.minRegistrationSeconds)
  if (minRegistrationSeconds !== null) limits.minRegistrationDurationMs = minRegistrationSeconds * 1000
  const maxRegistrationSeconds = toNumber(params.maxRegistrationSeconds)
  if (maxRegistrationSeconds !== null) limits.maxRegistrationDurationMs = maxRegistrationSeconds * 1000

  const maxCreatorFeeBps = toNumber(params.maxCreatorFeeBps)
  if (maxCreatorFeeBps !== null) limits.maxCreatorFeePercent = maxCreatorFeeBps / 100

  const radiusMilliSectors = toNumber(params.interceptRadiusMilliSectors)
  if (radiusMilliSectors !== null) limits.interceptionRadiusSectors = radiusMilliSectors / 1000

  assign('defenseSpeedKmPerBlock', toNumber(params.defenseSpeedKmPerBlock))

  return limits
}

/** The playfield grid the deployed contract was initialized with. */
function mapGridFromParams(params: DeploymentInfo['params']): { columns?: number; rows?: number } {
  if (!params) return {}
  const columns = toNumber(params.gridColumns)
  const rows = toNumber(params.gridRows)
  return {
    ...(columns !== null ? { columns } : {}),
    ...(rows !== null ? { rows } : {}),
  }
}

/**
 * Parses `import.meta.env` into a typed, defaulted AppConfig. Nothing in
 * the app should read `import.meta.env` directly outside this module.
 */
export function parseEnv(env: ImportMetaEnv = import.meta.env): AppConfig {
  const blockchainMode = readMode(env.VITE_BLOCKCHAIN_MODE)
  const oneMinuteMs = 60 * 1000
  const oneDayMs = 24 * 60 * oneMinuteMs

  /*
   * ENV's endpoints first, then the one the deployment was made against —
   * which is the documented normal case and, on a public network, the one
   * most likely to be rate-limited. Duplicates are dropped so a build that
   * lists the manifest's own URL does not read through it twice.
   */
  const envRpcUrls = (readOptionalString(env.VITE_RPC_URL) ?? '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean)

  const deployment = resolveDeployment(readOptionalNumber(env.VITE_CHAIN_ID), {
    address: readOptionalString(env.VITE_CONTRACT_ADDRESS),
    explorerUrl: readOptionalString(env.VITE_EXPLORER_URL),
    rpcUrl: envRpcUrls[0] ?? null,
    deploymentBlock: readOptionalNumber(env.VITE_DEPLOYMENT_BLOCK),
    genesisBlock: readOptionalNumber(env.VITE_GENESIS_BLOCK),
    // Inco's published verifier for this chain is used when ENV is empty —
    // see `defaultSessionVerifier`. An explicit value still wins.
    sessionVerifier: readOptionalString(env.VITE_CONFIDENTIAL_SESSION_VERIFIER),
  })

  const rpcUrls = [...new Set([...envRpcUrls, ...(deployment.rpcUrl ? [deployment.rpcUrl] : [])])]

  /*
   * The chain's own limits win wherever it has stated one. ENV keeps every
   * field it does not cover, and keeps all of them for a build with no
   * deployment behind it, which is what emulator mode is.
   */
  const chainLimits = protocolLimitsFromParams(deployment.params)
  const chainGrid = mapGridFromParams(deployment.params)
  /*
   * The draw cadence the deployed contract is actually running.
   *
   * Not part of `chainLimits` because it is not part of `GameParams` — it
   * lives in its own slot on chain and beside `params` in the manifest. It
   * overrides ENV for the same reason every other limit does: a countdown
   * built from a `.env` that says 1000 against a chain running something
   * else points at an epoch where nothing happens.
   */
  const drawInterval = deployment.globalDefenseEpochInterval
  const chainDrawInterval = typeof drawInterval === 'number' && Number.isFinite(drawInterval) ? drawInterval : null

  const config: AppConfig = {
    appName: readString(env.VITE_APP_NAME, 'AEGYLAX'),
    appSubtitle: readString(env.VITE_APP_SUBTITLE, 'Planetary Defense'),
    blockchainMode,
    auth: parseAuthConfig(env, blockchainMode),
    chainId: readOptionalNumber(env.VITE_CHAIN_ID),
    rpcUrl: envRpcUrls[0] ?? null,
    rpcUrls,
    explorerUrl: readOptionalString(env.VITE_EXPLORER_URL),
    contractAddress: readOptionalString(env.VITE_CONTRACT_ADDRESS) as `0x${string}` | null,
    deployment,
    blockTimeMs: readNumber(env.VITE_BLOCK_TIME_MS, blockchainMode === 'contract' ? 2000 : readNumber(env.VITE_EMULATOR_BLOCK_TIME_MS, 2000)),
    protocol: {
      // Whatever the protocol is configured with is the boundary — the
      // form and the creation path both read it from here, so lowering it
      // is a protocol decision, never a creator one.
      minPlayers: Math.max(1, readNumber(env.VITE_MIN_PLAYERS, 2)),
      maxPlayers: readNumber(env.VITE_MAX_PLAYERS, 20),
      minEntryPrice: readNumber(env.VITE_MIN_ENTRY_FEE, 0),
      maxEntryPrice: readNumber(env.VITE_MAX_ENTRY_FEE, 10),
      minStartPrizePool: readNumber(env.VITE_MIN_START_PRIZE_POOL, 0),
      minRegistrationDurationMs: readNumber(env.VITE_MIN_REGISTRATION_DURATION_MINUTES, 0) * oneMinuteMs,
      maxRegistrationDurationMs: readNumber(env.VITE_MAX_REGISTRATION_DURATION_DAYS, 30) * oneDayMs,
      maxCreatorFeePercent: readNumber(env.VITE_MAX_CREATOR_FEE_PERCENT, 5),
      maxReconProbes: readNumber(env.VITE_MAX_RECON_PROBES, 6),
      freeReconProbes: readNumber(env.VITE_RECON_PROBE_FREE_COUNT, 3),
      reconProbePrice: readNumber(env.VITE_RECON_PROBE_PRICE, 0.002),
      joinFee: readNumber(env.VITE_PROTOCOL_JOIN_FEE, 0),
      epochBlocks: readNumber(env.VITE_ATTACK_EPOCH_BLOCKS, 150),
      sectorSpanKm: readNumber(env.VITE_SECTOR_SPAN_KM, 1000),
      interceptionRadiusSectors: readNumber(env.VITE_DEFENSE_INTERCEPTION_RADIUS, 0.14),
      defenseSpeedKmPerBlock: readNumber(env.VITE_DEFENSE_SPEED_KM_PER_BLOCK, 250),
      globalDefenseEpochInterval: readNumber(env.VITE_GLOBAL_DEFENSE_EPOCH_INTERVAL, 1000),
      globalDefenseJoinWindowMs: readNumber(env.VITE_GLOBAL_DEFENSE_JOIN_WINDOW_HOURS, 24) * 60 * 60 * 1000,
      ...chainLimits,
      ...(chainDrawInterval !== null ? { globalDefenseEpochInterval: chainDrawInterval } : {}),
    },
    economics: {
      protocolJoinFee: readNumber(env.VITE_PROTOCOL_JOIN_FEE, 0),
      creatorFeePercent: readNumber(env.VITE_CREATOR_FEE_PERCENT, 5),
      defaultEntryPrice: readNumber(env.VITE_DEFAULT_ENTRY_PRICE, 0.01),
    },
    currency: {
      ticker: readString(env.VITE_GAME_CURRENCY, 'ETH').toUpperCase(),
      name: readString(env.VITE_GAME_CURRENCY_NAME, 'Ether'),
      tokenAddress: readOptionalAddress(env.VITE_GAME_CURRENCY_TOKEN),
    },
    emulator: {
      initialBlock: readNumber(env.VITE_EMULATOR_INITIAL_BLOCK, 1),
      blockTimeMs: readNumber(env.VITE_EMULATOR_BLOCK_TIME_MS, 2000),
    },
    // 10 x 5 = the 50 sectors the globe grid draws, labelled A1..J5.
    // Deliberately coarse: sectors are the player's orientation layer, not
    // the game's precision. The hidden attack keeps its full continuous
    // world-space position inside whichever sector it falls in, so a finer
    // grid would leak location without adding play (ТЗ §9).
    map: {
      columns: readNumber(env.VITE_MAP_GRID_COLUMNS, 10),
      rows: readNumber(env.VITE_MAP_GRID_ROWS, 5),
      // The grid the deployed contract measures distances against. A board
      // drawn at a different resolution from the one the protocol resolves
      // interceptions on would put every marker in the wrong place.
      ...chainGrid,
      showGridLabels: readBoolean(env.VITE_MAP_SHOW_GRID_LABELS, false),
    },
    providerTheme: readOptionalString(env.VITE_PROVIDER_THEME),
    links: {
      privacyLayerUrl:
        readOptionalString(env.VITE_PRIVACY_LAYER_URL) ?? readOptionalString(env.VITE_PRIVACY_PROTOCOL_URL),
    },
    apiBaseUrl: (readOptionalString(env.VITE_API_URL) ?? '').replace(/\/+$/, ''),
    apocalypse: {
      baseTimestamp: readTimestamp(env.VITE_APOCALYPSE_BASE_DATE, '2030-01-01T00:00:00Z'),
      daysPerMiss: readNumber(env.VITE_APOCALYPSE_DAYS_PER_MISS, 0.01),
      daysPerIntercept: readNumber(env.VITE_APOCALYPSE_DAYS_PER_INTERCEPT, 0.1),
    },
  }

  warnOnMissingProductionConfig(config)

  return config
}

function warnOnMissingProductionConfig(config: AppConfig): void {
  if (config.blockchainMode !== 'contract') return

  const missing: string[] = []
  if (!config.chainId) missing.push('VITE_CHAIN_ID')
  if (!config.rpcUrl && !config.deployment.rpcUrl) missing.push('VITE_RPC_URL')
  if (!config.auth.appId) missing.push('VITE_PRIVY_APP_ID')

  if (missing.length > 0) {
    console.warn(
      `[aegylax/config] VITE_BLOCKCHAIN_MODE=contract but missing: ${missing.join(', ')}. ` +
        'The contract client will not function correctly until these are set.',
    )
  }

  // The contract address is deliberately *not* on that list: it comes from
  // the generated deployment manifest, so a missing one means "nothing has
  // been deployed to this chain yet", which is a different problem with a
  // different fix (ТЗ §14).
  if (!config.deployment.configured) {
    console.warn(
      `[aegylax/config] No deployment found for chain ${config.chainId ?? '(unset)'}. ` +
        'Run "npm run chain:deploy" for that network, or set VITE_CONTRACT_ADDRESS to override.',
    )
  }
}

export const appConfig: AppConfig = parseEnv()

/**
 * The block the protocol's epoch grid is measured from.
 *
 * On chain that is `genesisBlock` — pinned at `initialize` and recorded in
 * the deployment manifest. It is not the proxy's current `deploymentBlock`:
 * those two numbers differ on a chain that has been upgraded, and using the
 * deploy block for the header countdown is how "Next attack" and an
 * operation's own launch timer can sit a minute apart while counting to
 * the same event. The emulator's `initialBlock` is the same idea for a
 * chain that starts when the tab does.
 *
 * One exported answer because more than one screen needs it — the header's
 * next-attack countdown and an operation's scheduled epoch have to be
 * measured against the same grid, and a second copy of this that read the
 * emulator's value in contract mode would put them on different ones.
 */
export function protocolGenesisBlock(config: AppConfig = appConfig): number {
  return config.blockchainMode === 'contract'
    ? config.deployment.genesisBlock || config.deployment.deploymentBlock
    : config.emulator.initialBlock
}

/**
 * The protocol rules every layer validates against. Imported by
 * `game/lobby.ts` as the default limits so the authoritative creation path
 * enforces them even when a caller forgets to pass them explicitly.
 */
export const protocolLimits: ProtocolLimits = appConfig.protocol
