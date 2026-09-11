import { PrivyProvider, usePrivy, useWallets, type ConnectedWallet, type User } from '@privy-io/react-auth'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { EIP1193Provider } from 'viem'
import type { AuthConfig, AuthLoginMethod } from '../../../config/auth'
import type { AppConfig } from '../../../config/env'
import { resolveActiveChain, resolveSupportedChains } from '../../../config/networks'
import type { Address } from '../../../game/types'
import { keepIfUnchanged } from '../../../utils/identity'
import { AuthContext } from '../../AuthContext'
import { publishAuthSession } from '../../sessionStore'
import type { AuthSession, AuthStatus, AuthUser, AuthWallet, AuthWalletKind } from '../../types'
import { toPrivyClientConfig } from './privyClientConfig'

/**
 * Privy, and nowhere else.
 *
 * Together with `privyClientConfig.ts` this is the entire surface of the
 * vendor in this codebase: no other file imports `@privy-io/react-auth`,
 * and nothing outside `auth/` sees a Privy type. What leaves this file is
 * an `AuthSession` — an address, a login label, and a way to get an
 * EIP-1193 provider — which is all the game and blockchain layers were
 * ever written against.
 *
 * On keys: none of them are ours. A managed wallet's keys live with the
 * provider under its own security model; this adapter never reads, derives
 * or persists key material, never calls the SDK's export-wallet flow, and
 * writes nothing about the session to `localStorage`. Session persistence
 * across reloads is the SDK's own, and it is what `ready` is waiting for.
 */

/** Privy marks its own embedded wallets with these client types. */
const MANAGED_WALLET_CLIENT_TYPES = new Set(['privy', 'privy-v2'])

/**
 * How long a restored session may sit without a usable wallet before we
 * treat it as gone rather than still arriving.
 *
 * A first-time email login spends this window minting a managed wallet.
 * A previous MetaMask that is now locked or blocked never arrives at all —
 * without a bound, the header stays on "Loading…" forever and Sign in is
 * disabled, which is indistinguishable from a dead control.
 */
export const WALLET_RESTORE_MS = 6_000

const UNAVAILABLE_WALLET =
  'Your previous wallet is blocked or locked. Unlock it, or sign in another way.'

/**
 * Session restore vs a wallet that will never come back.
 *
 * `authenticated && !address` is two different facts: a managed wallet
 * still being minted, and a linked external wallet the browser will not
 * hand over. The first is initializing. The second is not — and neither
 * is a logged-out visitor whose wallet list is still hydrating.
 */
export function privySessionStatus(args: {
  ready: boolean
  walletsReady: boolean
  authenticated: boolean
  hasAddress: boolean
  hasLinkedWallet: boolean
  restoreTimedOut: boolean
}): { status: AuthStatus; stuck: boolean; isReady: boolean } {
  if (args.ready && args.authenticated && args.hasAddress) {
    return { status: 'authenticated', stuck: false, isReady: true }
  }
  if (!args.ready) {
    return { status: 'initializing', stuck: false, isReady: false }
  }

  const waitingForWallet = args.authenticated && !args.hasAddress
  const stuck =
    waitingForWallet && (args.restoreTimedOut || (args.walletsReady && args.hasLinkedWallet))

  if (waitingForWallet && !stuck) {
    return { status: 'initializing', stuck: false, isReady: false }
  }

  return { status: 'unauthenticated', stuck, isReady: true }
}

function walletKind(wallet: ConnectedWallet): AuthWalletKind {
  return MANAGED_WALLET_CLIENT_TYPES.has(wallet.walletClientType) ? 'managed' : 'external'
}

/** `eip155:8453` -> 8453. Absent or unparseable means "the wallet did not say". */
function parseCaip2ChainId(chainId: string | undefined): number | null {
  if (!chainId) return null
  const parsed = Number(chainId.split(':')[1])
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Which of the connected wallets the player is actually playing as.
 *
 * The order matters. Privy's `user.wallet` is the account the session is
 * verified against, so it wins; a managed wallet comes next, because
 * somebody who signed in with an email has exactly one and it is the whole
 * reason they can play; only then does the first connected wallet stand in.
 */
function selectActiveWallet(wallets: ConnectedWallet[], user: User | null): ConnectedWallet | null {
  if (wallets.length === 0) return null

  const verified = user?.wallet?.address?.toLowerCase()
  const primary = verified ? wallets.find((wallet) => wallet.address.toLowerCase() === verified) : undefined
  if (primary) return primary

  return wallets.find((wallet) => walletKind(wallet) === 'managed') ?? wallets[0]
}

/**
 * How this player signed in, in the app's vocabulary rather than Privy's.
 *
 * Privy reports linked accounts, not "the method used"; for a display
 * label and a coarse "did they need a wallet of their own" signal, the
 * first linked account in this order is a truthful answer.
 */
const LOGIN_METHOD_READERS: ReadonlyArray<{
  method: AuthLoginMethod
  read: (user: User) => string | null | undefined
}> = [
  { method: 'email', read: (user) => user.email?.address },
  { method: 'google', read: (user) => user.google?.email ?? user.google?.name },
  { method: 'apple', read: (user) => user.apple?.email },
  { method: 'twitter', read: (user) => user.twitter?.username },
  { method: 'discord', read: (user) => user.discord?.username },
  { method: 'github', read: (user) => user.github?.username },
  { method: 'telegram', read: (user) => user.telegram?.username },
  { method: 'farcaster', read: (user) => user.farcaster?.username },
  { method: 'sms', read: (user) => user.phone?.number },
]

function toAuthUser(user: User | null): AuthUser | null {
  if (!user) return null

  for (const { method, read } of LOGIN_METHOD_READERS) {
    const label = read(user)
    if (label) return { id: user.id, loginMethod: method, label }
  }

  // Signed in with a wallet and nothing else: there is no human label to
  // show, and the address the pill already displays is the honest one.
  return { id: user.id, loginMethod: user.wallet ? 'wallet' : null, label: null }
}

function PrivySessionBridge({ auth, children }: { auth: AuthConfig; children: ReactNode }) {
  const { ready, authenticated, user, error, login, logout } = usePrivy()
  const { wallets, ready: walletsReady } = useWallets()

  const active = selectActiveWallet(wallets, user)
  const hasAddress = Boolean(active?.address)
  const waitingForWallet = ready && authenticated && !hasAddress
  const [restoreTimedOut, setRestoreTimedOut] = useState(false)

  useEffect(() => {
    if (!waitingForWallet) {
      setRestoreTimedOut(false)
      return
    }
    const id = window.setTimeout(() => setRestoreTimedOut(true), WALLET_RESTORE_MS)
    return () => window.clearTimeout(id)
  }, [waitingForWallet])

  /*
   * The connected-wallet object is rebuilt by the SDK as it re-renders, but
   * the wallet it describes is the same one. Holding the latest in a ref
   * and exposing stable callbacks is what keeps `AuthWallet` identity tied
   * to the address and chain rather than to render count — the signer
   * bridge runs an effect on that identity, and a new object every render
   * would re-attach a wallet client on every render.
   */
  const activeRef = useRef<ConnectedWallet | null>(null)
  activeRef.current = active ?? null

  const getEthereumProvider = useCallback(async (): Promise<EIP1193Provider> => {
    const wallet = activeRef.current
    if (!wallet) throw new Error('No wallet connected')
    return (await wallet.getEthereumProvider()) as EIP1193Provider
  }, [])

  const switchChain = useCallback(async (chainId: number) => {
    await activeRef.current?.switchChain(chainId)
  }, [])

  const address = (active?.address as Address | undefined) ?? null
  const chainId = parseCaip2ChainId(active?.chainId)
  const kind = active ? walletKind(active) : null

  const wallet = useMemo<AuthWallet | null>(
    () => (address && kind ? { address, chainId, kind, getEthereumProvider, switchChain } : null),
    [address, chainId, kind, getEthereumProvider, switchChain],
  )

  // `user` is a fresh object on every SDK render; the app only cares about
  // the three fields `toAuthUser` keeps, so a session whose label and login
  // method did not change keeps the identity React already has.
  const userRef = useRef<AuthUser | null>(null)
  userRef.current = keepIfUnchanged(userRef.current, toAuthUser(user))
  const authUser = userRef.current

  /**
   * Hand the sign-in flow to the SDK — or say why it could not be handed
   * over.
   *
   * `login()` is not a promise, and before the SDK has restored its session
   * it is not even an action: it logs a warning and returns. Nothing about
   * that reaches a caller — which is how pressing Launch Defense while the
   * SDK was still coming up managed to do *literally nothing*. The modal
   * wrapped this call in `try/catch` precisely so a sign-in that could not
   * start would say so, and there was never anything to catch.
   *
   * So the one state the SDK silently swallows is turned into an error
   * here, once, rather than left for every call site to remember. A caller
   * that would rather wait than fail can ask `status` first and hold the
   * press until a wallet exists — see `CreateLobbyModal`.
   *
   * A restored session with no usable wallet is the other unstartable
   * state: Privy still considers the player authenticated, so `login()`
   * throws. Drop that session first, then open the modal.
   */
  const startLogin = useCallback(async () => {
    if (!ready) {
      throw new Error('Sign-in is still starting up. Give it a moment and try again.')
    }
    if (authenticated && !activeRef.current) {
      await logout()
    }
    login()
  }, [authenticated, login, logout, ready])

  const endLogout = useCallback(async () => {
    await logout()
  }, [logout])

  const phase = privySessionStatus({
    ready,
    walletsReady,
    authenticated,
    hasAddress,
    hasLinkedWallet: Boolean(user?.wallet?.address),
    restoreTimedOut,
  })

  const droppedStuck = useRef(false)
  useEffect(() => {
    if (!phase.stuck) {
      droppedStuck.current = false
      return
    }
    if (droppedStuck.current) return
    droppedStuck.current = true
    void logout()
  }, [logout, phase.stuck])

  const [recovery, setRecovery] = useState<Error | null>(null)
  useEffect(() => {
    if (phase.stuck) setRecovery(new Error(UNAVAILABLE_WALLET))
    if (hasAddress) setRecovery(null)
  }, [hasAddress, phase.stuck])

  const session = useMemo<AuthSession>(() => {
    return {
      provider: 'privy',
      status: phase.status,
      isReady: phase.isReady,
      isAuthenticated: phase.status === 'authenticated',
      user: authUser,
      wallet,
      loginMethods: auth.loginMethods,
      error: recovery ?? error ?? null,
      login: startLogin,
      logout: endLogout,
    }
  }, [auth.loginMethods, authUser, endLogout, error, phase.isReady, phase.status, recovery, startLogin, wallet])

  /*
   * The session leaves this subtree twice, and the two ways are for two
   * different callers.
   *
   * The *store* is how the app gets it in production: this adapter is
   * mounted as a sibling of the app rather than as a wrapper around it, so
   * that 1.6MB of vendor SDK can be fetched after the page has painted
   * instead of before (see `auth/sessionStore`). Published from an effect
   * rather than during render, because writing to an external store while
   * another component is rendering is exactly the thing React warns about.
   *
   * The *context* is for anybody who mounts this adapter directly with
   * children — the adapter's own tests, and any future host that wants the
   * old wrapper shape. In the app there are no children here at all, and
   * the provider costs nothing.
   */
  useEffect(() => {
    publishAuthSession(session)
  }, [session])

  /*
   * Cleared on unmount and *only* on unmount — deliberately a second effect
   * rather than a cleanup on the one above.
   *
   * A cleanup there runs on every change of `session` as well, so each auth
   * update would write `null` into the store and then the new value. Read
   * through `useSyncExternalStore` that gap is usually invisible — both
   * writes land in the same commit and React coalesces them — which is
   * precisely why it is worth being explicit about: the store genuinely
   * holds "no session" in the middle of an update that had one, and
   * anything reading it outside that coalescing (a later subscriber, a read
   * from an effect, a non-React consumer) reads the gap. A store that is
   * only correct because of when its readers happen to look is not correct.
   *
   * `privyAuthAdapter.test.tsx` asserts on the published sequence rather
   * than on a rendered probe, for the same reason.
   */
  useEffect(() => () => publishAuthSession(null), [])

  return <AuthContext.Provider value={session}>{children}</AuthContext.Provider>
}

export function PrivyAuthProvider({
  auth,
  app,
  children,
}: {
  auth: AuthConfig
  app: AppConfig
  /**
   * Optional, and empty in the app itself: the session travels through
   * `auth/sessionStore` instead, which is what lets this whole module be a
   * lazily loaded sibling of the tree rather than its root.
   */
  children?: ReactNode
}) {
  if (!auth.appId) {
    // Unreachable through `AuthProvider`, which resolves the provider to
    // "local" when there is no app id. Kept as a hard failure rather than a
    // silent one for anybody mounting this directly.
    throw new Error('PrivyAuthProvider requires an app id (VITE_PRIVY_APP_ID)')
  }

  const clientConfig = toPrivyClientConfig(auth, {
    supported: resolveSupportedChains(app),
    active: resolveActiveChain(app),
  })

  return (
    <PrivyProvider appId={auth.appId} {...(auth.clientId ? { clientId: auth.clientId } : {})} config={clientConfig}>
      <PrivySessionBridge auth={auth}>{children}</PrivySessionBridge>
    </PrivyProvider>
  )
}
