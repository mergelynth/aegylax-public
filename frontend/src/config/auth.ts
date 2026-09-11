import { readBoolean, readEnumList, readOptionalString } from './readEnv'

/**
 * How a player gets an identity and a wallet — described without naming a
 * vendor.
 *
 * Everything here is a concept any hosted-wallet provider has: which login
 * methods to offer, whether the provider mints a wallet it manages for the
 * player, and how its modal should look. `auth/` maps this onto whichever
 * SDK is actually installed (today: Privy), and nothing outside
 * `auth/adapters/` reads a vendor-shaped value.
 *
 * Every one of these comes from ENV. There is no hardcoded app id, no
 * hardcoded login method list, and no credential in source.
 */

export type AuthProviderId = 'privy' | 'local'

/**
 * The login methods the app is willing to offer. This is the intersection
 * language: a method has to be understood here *and* enabled in the
 * provider's own dashboard before a player ever sees it.
 */
export const AUTH_LOGIN_METHODS = [
  'email',
  'sms',
  'wallet',
  'google',
  'apple',
  'github',
  'discord',
  'twitter',
  'farcaster',
  'telegram',
  'passkey',
] as const

export type AuthLoginMethod = (typeof AUTH_LOGIN_METHODS)[number]

/** Login methods that do not require the player to already own a wallet. */
export const SIMPLE_LOGIN_METHODS: readonly AuthLoginMethod[] = AUTH_LOGIN_METHODS.filter(
  (method) => method !== 'wallet',
)

/**
 * Whether the provider mints a wallet it manages on the player's behalf.
 *
 * - `users-without-wallets` (default) — somebody who signed in with email
 *   or a social account gets a managed wallet; somebody who arrived with
 *   their own keeps using it.
 * - `all-users` — always mint one, even alongside an external wallet.
 * - `off` — no managed wallets; only external ones.
 */
export const MANAGED_WALLET_POLICIES = ['users-without-wallets', 'all-users', 'off'] as const
export type ManagedWalletPolicy = (typeof MANAGED_WALLET_POLICIES)[number]

export interface AuthConfig {
  /** Which adapter `auth/AuthProvider` mounts. */
  provider: AuthProviderId
  /** The provider's public application id. Never a secret, always from ENV. */
  appId: string | null
  /** Optional per-client id, where the provider issues one. */
  clientId: string | null
  loginMethods: AuthLoginMethod[]
  managedWallets: ManagedWalletPolicy
  appearance: {
    /** 'light' | 'dark' | a hex colour the provider derives a theme from. */
    theme: string | null
    accentColor: string | null
    logoUrl: string | null
    /** Put "connect a wallet" above the email/social options. */
    showWalletLoginFirst: boolean
  }
  legal: {
    termsUrl: string | null
    privacyUrl: string | null
  }
  /** Needed only for WalletConnect-based external wallets. */
  walletConnectProjectId: string | null
}

const DEFAULT_LOGIN_METHODS: readonly AuthLoginMethod[] = ['email', 'google', 'wallet']

function readProviderId(value: string | undefined): AuthProviderId | null {
  const trimmed = value?.trim().toLowerCase()
  if (trimmed === 'privy' || trimmed === 'local') return trimmed
  return null
}

function readManagedWalletPolicy(value: string | undefined): ManagedWalletPolicy {
  const trimmed = value?.trim().toLowerCase()
  const match = MANAGED_WALLET_POLICIES.find((policy) => policy === trimmed)
  return match ?? 'users-without-wallets'
}

/**
 * Resolves which adapter runs.
 *
 * The default is deliberately conservative: a hosted provider mounts only
 * when this build talks to a real chain *and* has credentials for it, so
 * emulator mode keeps working with nothing installed and nothing
 * configured (ТЗ §8). Naming a provider explicitly overrides that — which
 * is how you exercise the real sign-in flow against the emulator — but a
 * provider with no app id cannot mount at all and falls back to local.
 */
function resolveProviderId(
  requested: AuthProviderId | null,
  appId: string | null,
  blockchainMode: string,
): AuthProviderId {
  if (requested === 'local') return 'local'
  if (requested === 'privy') return appId ? 'privy' : 'local'
  return blockchainMode === 'contract' && appId ? 'privy' : 'local'
}

export function parseAuthConfig(env: ImportMetaEnv, blockchainMode: string): AuthConfig {
  const requested = readProviderId(env.VITE_AUTH_PROVIDER)
  const appId = readOptionalString(env.VITE_PRIVY_APP_ID)
  const provider = resolveProviderId(requested, appId, blockchainMode)
  const loginMethods = readEnumList(env.VITE_AUTH_LOGIN_METHODS, AUTH_LOGIN_METHODS, DEFAULT_LOGIN_METHODS)

  const config: AuthConfig = {
    provider,
    appId,
    clientId: readOptionalString(env.VITE_PRIVY_CLIENT_ID),
    loginMethods: loginMethods.values,
    managedWallets: readManagedWalletPolicy(env.VITE_AUTH_MANAGED_WALLETS),
    appearance: {
      theme: readOptionalString(env.VITE_AUTH_THEME),
      accentColor: readOptionalString(env.VITE_AUTH_ACCENT_COLOR),
      logoUrl: readOptionalString(env.VITE_AUTH_LOGO_URL),
      showWalletLoginFirst: readBoolean(env.VITE_AUTH_SHOW_WALLET_LOGIN_FIRST, false),
    },
    legal: {
      termsUrl: readOptionalString(env.VITE_AUTH_TERMS_URL),
      privacyUrl: readOptionalString(env.VITE_AUTH_PRIVACY_URL),
    },
    walletConnectProjectId: readOptionalString(env.VITE_WALLETCONNECT_PROJECT_ID),
  }

  warnOnUnusableAuthConfig(config, requested, blockchainMode, loginMethods.unknown)

  return config
}

function warnOnUnusableAuthConfig(
  config: AuthConfig,
  requested: AuthProviderId | null,
  blockchainMode: string,
  unknownLoginMethods: string[],
): void {
  if (unknownLoginMethods.length > 0) {
    console.warn(
      `[aegylax/auth] Ignoring unknown login method(s): ${unknownLoginMethods.join(', ')}. ` +
        `Supported: ${AUTH_LOGIN_METHODS.join(', ')}.`,
    )
  }

  if (requested === 'privy' && !config.appId) {
    console.warn(
      '[aegylax/auth] VITE_AUTH_PROVIDER=privy but VITE_PRIVY_APP_ID is empty — ' +
        'falling back to the local identity. Sign-in will not reach a real wallet.',
    )
  }

  if (blockchainMode === 'contract' && config.provider === 'local') {
    console.warn(
      '[aegylax/auth] Contract mode with no auth provider configured: writes need a real ' +
        'signer, so set VITE_PRIVY_APP_ID.',
    )
  }
}

/**
 * Whether this configuration can sign a player in without them already
 * owning a wallet — the question the connect control asks to decide
 * whether it says "Sign in" or "Connect Wallet".
 */
export function offersSimpleLogin(config: AuthConfig): boolean {
  return config.provider !== 'local' && config.loginMethods.some((method) => method !== 'wallet')
}
