import { useMemo } from 'react'
import { useAuth } from '../auth'
import type { AuthStatus, AuthWalletKind } from '../auth/types'
import type { AuthLoginMethod } from '../config/auth'
import type { Address } from '../game/types'

export interface WalletState {
  /**
   * The address this player acts as, and `null` until they are actually
   * signed in.
   *
   * The two are deliberately one fact rather than two. Every caller in the
   * app guards on `address` before writing (`if (!address) throw`), so an
   * address that exists ahead of the session — which is exactly what the
   * local emulator identity does, since it mints one per browser whether or
   * not anybody pressed connect — would let every one of those guards pass
   * for somebody who never connected. Reads are affected the same way and
   * for the same reason: a viewer who is not signed in is nobody, and the
   * `viewer` argument the contract reads take is what decides whose private
   * data comes back.
   */
  address: Address | null
  isConnected: boolean
  chainId: number | null
  /**
   * Where the signing keys live — `managed` when the sign-in provider holds
   * them for this player.
   *
   * The UI needs it for exactly one thing: a player with a managed wallet
   * has an address they have never seen and no other app to look it up in,
   * so the account panel has to be the place that hands it to them and says
   * it is where deposits go.
   */
  walletKind: AuthWalletKind | null
  /** The provider has finished restoring any previous session. */
  isReady: boolean
  /**
   * Where the session is, which is not the same question as `isReady`.
   *
   * `initializing` covers both "the provider has not restored a session yet"
   * and "somebody is signed in but their managed wallet is still being
   * minted". A restored session whose linked wallet is blocked or locked is
   * not that — it is `unauthenticated`, so this control stays pressable.
   */
  status: AuthStatus
  /**
   * Something human to show instead of the address — an email, a social
   * handle — when the player did not sign in with a wallet of their own.
   */
  label: string | null
  /** What the sign-in screen can offer, which decides how it is labelled. */
  loginMethods: readonly AuthLoginMethod[]
  /**
   * Why the last sign-in did not happen.
   *
   * Sign-in is the one action in the app whose failure has nowhere else to
   * appear: every other write reports through its own `useTxRunner`, but
   * `connect` resolves as soon as the flow has been handed to the provider
   * and a provider that refused to start it left the button looking dead.
   */
  error: Error | null
  connect: () => Promise<void> | void
  disconnect: () => Promise<void> | void
}

/**
 * The wallet as the game sees it: an address to act as, and two verbs.
 *
 * Every hook and page that needs "who is playing" goes through here, and
 * this is now a thin read of the auth session — the emulator identity and
 * the hosted wallet both arrive as an `AuthSession`, so there is no branch
 * left in this file and nothing above it imports an auth SDK.
 */
export function useWallet(): WalletState {
  const { wallet, user, isAuthenticated, isReady, status, loginMethods, error, login, logout } = useAuth()

  return useMemo(() => {
    const isConnected = isAuthenticated && Boolean(wallet?.address)

    return {
      // Gated on the session, not on whether an address happens to exist —
      // see `WalletState.address`.
      address: isConnected ? (wallet?.address ?? null) : null,
      isConnected,
      chainId: wallet?.chainId ?? null,
      walletKind: wallet?.kind ?? null,
      isReady,
      status,
      label: user?.label ?? null,
      loginMethods,
      error,
      connect: login,
      disconnect: logout,
    }
  }, [
    error,
    isAuthenticated,
    isReady,
    login,
    loginMethods,
    logout,
    status,
    user?.label,
    wallet?.address,
    wallet?.chainId,
    wallet?.kind,
  ])
}
