import type { PrivyClientConfig } from '@privy-io/react-auth'
import type { Chain } from 'viem/chains'
import type { AuthConfig } from '../../../config/auth'

/**
 * The vendor seam.
 *
 * This function is the only place where the app's own, provider-agnostic
 * `AuthConfig` becomes something Privy-shaped. It is deliberately pure and
 * separately tested: when the provider is replaced, this file and its
 * sibling adapter are what gets rewritten, and the test that pins this
 * mapping is what tells you whether the replacement kept its promises.
 *
 * Nothing is invented here. Every value either comes from ENV or is left
 * unset so the provider's own dashboard configuration wins — an option the
 * app does not set is an option an operator can change without a rebuild.
 */

type PrivyLoginMethod = NonNullable<PrivyClientConfig['loginMethods']>[number]

function isHexColor(value: string): value is `#${string}` {
  return /^#[0-9a-fA-F]{3,8}$/.test(value)
}

/** 'light' | 'dark' | a hex colour; anything else is dropped rather than guessed. */
function toTheme(theme: string | null): 'light' | 'dark' | `#${string}` | undefined {
  if (!theme) return undefined
  const normalized = theme.trim().toLowerCase()
  if (normalized === 'light' || normalized === 'dark') return normalized
  if (isHexColor(theme.trim())) return theme.trim() as `#${string}`
  console.warn(`[aegylax/auth] Ignoring VITE_AUTH_THEME="${theme}" — expected light, dark or a hex colour.`)
  return undefined
}

export interface PrivyChainSelection {
  /** Every chain the wallet is allowed to be on. */
  supported: readonly Chain[]
  /** The chain this build actually talks to, when one is configured. */
  active: Chain | null
}

export function toPrivyClientConfig(auth: AuthConfig, chains: PrivyChainSelection): PrivyClientConfig {
  const accentColor = auth.appearance.accentColor?.trim()
  const theme = toTheme(auth.appearance.theme)

  return {
    // Privy's own union happens to use the same names as ours; the cast is
    // the assertion that they still line up, and the login-method test is
    // what keeps that honest.
    loginMethods: auth.loginMethods as PrivyLoginMethod[],

    /*
     * The point of the whole integration: somebody who signed in with an
     * email or a social account walks away with a wallet the provider
     * manages for them, and can sign a defense transaction without ever
     * meeting a seed phrase. The keys are the provider's problem by design
     * — this app never receives, derives or stores them.
     */
    embeddedWallets: {
      ethereum: { createOnLogin: auth.managedWallets },
      /*
       * No confirmation sheet in front of a managed wallet's transactions.
       *
       * This is a deliberate trade and it is worth naming what is on each
       * side. AEGYLAX asks for a signature far more often than a wallet app
       * does: a probe is a transaction, a defense is a transaction, and the
       * reveal is two more that `useProtocolKeeper` sends on the player's
       * behalf without being asked. With the sheet on, finishing one round
       * meant a stack of modals — most of them for actions the player had
       * already committed to by pressing the button behind them, and the
       * automatic ones for actions they never pressed at all.
       *
       * What is given up is the last chance to say no before ETH moves. That
       * is a real protection, and it is why this is scoped as narrowly as the
       * option allows: it only affects wallets the provider holds keys for —
       * the ones created for somebody who signed in with an email and has
       * never seen a seed phrase. A player who connected their own wallet
       * still gets their own wallet's confirmation on every transaction, and
       * nothing here can change that.
       *
       * The app's own guards are what stand in its place: every write is
       * simulated before it is sent (see `ContractBlockchainClient.send`), so
       * a transaction that would revert never reaches the chain, and every
       * control that spends money states the amount before it is pressed.
       */
      showWalletUIs: false,
    },

    supportedChains: chains.supported as Chain[],
    ...(chains.active ? { defaultChain: chains.active } : {}),

    appearance: {
      ...(theme ? { theme } : {}),
      ...(accentColor && isHexColor(accentColor) ? { accentColor } : {}),
      ...(auth.appearance.logoUrl ? { logo: auth.appearance.logoUrl } : {}),
      showWalletLoginFirst: auth.appearance.showWalletLoginFirst,
    },

    ...(auth.legal.termsUrl || auth.legal.privacyUrl
      ? {
          legal: {
            ...(auth.legal.termsUrl ? { termsAndConditionsUrl: auth.legal.termsUrl } : {}),
            ...(auth.legal.privacyUrl ? { privacyPolicyUrl: auth.legal.privacyUrl } : {}),
          },
        }
      : {}),

    ...(auth.walletConnectProjectId ? { walletConnectCloudProjectId: auth.walletConnectProjectId } : {}),
  }
}
