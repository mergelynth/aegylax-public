import type { EIP1193Provider } from 'viem'
import type { AuthLoginMethod, AuthProviderId } from '../config/auth'
import type { Address } from '../game/types'

/**
 * What the rest of the app is allowed to know about "who is playing".
 *
 * This is the whole contract. No component, hook, page or blockchain client
 * imports an authentication SDK — they import `useAuth` and get the types
 * below, which describe a session in terms the game cares about: is
 * somebody signed in, what address are they playing as, and how do we get
 * something that can sign a transaction for them.
 *
 * Replacing the provider means writing one new file under
 * `auth/adapters/` that produces an `AuthSession`. Nothing above this line
 * changes.
 */

export type AuthStatus = 'initializing' | 'unauthenticated' | 'authenticated'

/**
 * Where the signing keys live.
 *
 * - `managed` — the provider holds them on the player's behalf (that is the
 *   point: sign in with an email, get a wallet, sign transactions).
 * - `external` — the player's own wallet, connected from their browser.
 * - `simulated` — emulator mode's stand-in address, which signs nothing and
 *   has no keys anywhere.
 *
 * In no case does this app see, derive or store a private key or a
 * recovery phrase. A wallet is reachable here only as an EIP-1193
 * provider, which is a request channel, not key material.
 */
export type AuthWalletKind = 'managed' | 'external' | 'simulated'

export interface AuthWallet {
  address: Address
  /** The chain the wallet is currently on, when it will say. */
  chainId: number | null
  kind: AuthWalletKind
  /**
   * The signing channel, when this wallet has one. Absent for `simulated`
   * wallets — the emulator has no transport to hand out.
   */
  getEthereumProvider?: () => Promise<EIP1193Provider>
  /** Moves the wallet to a chain. Managed wallets do this without a prompt. */
  switchChain?: (chainId: number) => Promise<void>
}

export interface AuthUser {
  /** The provider's stable id for this player. Never an address by design. */
  id: string
  /** How they signed in, when the provider says. */
  loginMethod: AuthLoginMethod | null
  /**
   * Something human to show instead of a hex address — an email, a social
   * handle. Null when the only thing known about a player is their wallet.
   */
  label: string | null
}

export interface AuthSession {
  provider: AuthProviderId
  status: AuthStatus
  /** The provider has finished restoring any previous session. */
  isReady: boolean
  isAuthenticated: boolean
  user: AuthUser | null
  /** The wallet this player acts as. Null until they are signed in. */
  wallet: AuthWallet | null
  /** What this session can offer on its sign-in screen. */
  loginMethods: readonly AuthLoginMethod[]
  error: Error | null
  /**
   * Starts sign-in. Resolves once the flow has been *handed to* the
   * provider — a modal opening is not a promise that the player finishes
   * it, so callers watch `isAuthenticated` rather than awaiting a result.
   */
  login: () => Promise<void>
  logout: () => Promise<void>
}
