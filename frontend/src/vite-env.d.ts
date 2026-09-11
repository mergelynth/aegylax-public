/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_APP_NAME: string
  readonly VITE_APP_SUBTITLE: string
  /** Injected at build from git (`0.MINOR.commits`). Optional override. */
  readonly VITE_PROTOCOL_VERSION: string

  readonly VITE_BLOCKCHAIN_MODE: string

  readonly VITE_AUTH_PROVIDER: string
  readonly VITE_PRIVY_APP_ID: string
  readonly VITE_PRIVY_CLIENT_ID: string
  readonly VITE_AUTH_LOGIN_METHODS: string
  readonly VITE_AUTH_MANAGED_WALLETS: string
  readonly VITE_AUTH_THEME: string
  readonly VITE_AUTH_ACCENT_COLOR: string
  readonly VITE_AUTH_LOGO_URL: string
  readonly VITE_AUTH_SHOW_WALLET_LOGIN_FIRST: string
  readonly VITE_AUTH_TERMS_URL: string
  readonly VITE_AUTH_PRIVACY_URL: string
  readonly VITE_WALLETCONNECT_PROJECT_ID: string

  readonly VITE_CHAIN_ID: string
  readonly VITE_RPC_URL: string
  readonly VITE_EXPLORER_URL: string
  readonly VITE_CONTRACT_ADDRESS: string
  readonly VITE_DEPLOYMENT_BLOCK: string
  readonly VITE_GENESIS_BLOCK: string
  readonly VITE_BLOCK_TIME_MS: string
  readonly VITE_SUPPORTED_CHAIN_IDS: string

  readonly VITE_MIN_PLAYERS: string
  readonly VITE_MAX_PLAYERS: string
  readonly VITE_MIN_ENTRY_FEE: string
  readonly VITE_MAX_ENTRY_FEE: string
  readonly VITE_MIN_START_PRIZE_POOL: string
  readonly VITE_MIN_REGISTRATION_DURATION_MINUTES: string
  readonly VITE_MAX_REGISTRATION_DURATION_DAYS: string
  readonly VITE_MAX_CREATOR_FEE_PERCENT: string
  readonly VITE_MAX_RECON_PROBES: string

  readonly VITE_PROTOCOL_JOIN_FEE: string
  readonly VITE_CREATOR_FEE_PERCENT: string
  readonly VITE_DEFAULT_ENTRY_PRICE: string
  readonly VITE_GAME_CURRENCY: string
  readonly VITE_GAME_CURRENCY_NAME: string
  readonly VITE_GAME_CURRENCY_TOKEN: string

  readonly VITE_RECON_PROBE_FREE_COUNT: string
  readonly VITE_RECON_PROBE_PRICE: string

  readonly VITE_EMULATOR_INITIAL_BLOCK: string
  readonly VITE_EMULATOR_BLOCK_TIME_MS: string

  readonly VITE_ATTACK_EPOCH_BLOCKS: string
  readonly VITE_SECTOR_SPAN_KM: string
  readonly VITE_DEFENSE_INTERCEPTION_RADIUS: string
  readonly VITE_DEFENSE_SPEED_KM_PER_BLOCK: string
  readonly VITE_GLOBAL_DEFENSE_EPOCH_INTERVAL: string
  readonly VITE_GLOBAL_DEFENSE_JOIN_WINDOW_HOURS: string

  readonly VITE_MAP_GRID_COLUMNS: string
  readonly VITE_MAP_GRID_ROWS: string
  readonly VITE_MAP_SHOW_GRID_LABELS: string

  readonly VITE_APOCALYPSE_BASE_DATE: string
  readonly VITE_APOCALYPSE_DAYS_PER_MISS: string
  readonly VITE_APOCALYPSE_DAYS_PER_INTERCEPT: string

  readonly VITE_PRIVACY_LAYER_URL: string
  readonly VITE_PRIVACY_PROTOCOL_URL: string
  /** Backend base URL (faucet, keeper status). Empty = same origin. */
  readonly VITE_API_URL: string
  /** Provider theme override — paint only. See `AppConfig.providerTheme`. */
  readonly VITE_PROVIDER_THEME: string
  readonly VITE_CONFIDENTIAL_SESSION_VERIFIER: string

  /**
   * Dev server only: the key `VITE_AUTH_PROVIDER=devkey` signs with. A
   * production build drops the adapter that reads it.
   */
  readonly VITE_DEV_PRIVATE_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*protocol-version.mjs' {
  export function protocolLine(pkgVersion: string): { major: string; minor: string }
  export function gitCommitCount(cwd?: string, env?: NodeJS.ProcessEnv): number | null
  export function gitCommitSha(cwd?: string, env?: NodeJS.ProcessEnv): string | null
  export function resolveProtocolVersion(opts?: {
    env?: NodeJS.ProcessEnv
    pkgVersion?: string
    commitCount?: number | null
    commitSha?: string | null
  }): string
}
