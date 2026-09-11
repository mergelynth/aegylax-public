import { lazy, Suspense, useMemo, type ReactNode } from 'react'
import { appConfig } from '../config/env'
import { DevKeyAuthProvider, hasDevKey } from './adapters/devkey/DevKeyAuthProvider'
import { LocalAuthProvider } from './adapters/local/LocalAuthProvider'
import { AuthContext } from './AuthContext'
import { usePublishedAuthSession } from './sessionStore'
import type { AuthSession } from './types'

/**
 * The hosted provider, fetched after the page exists rather than before it.
 *
 * It is the single largest thing this client ships — bigger than the client
 * — and until this line it was a static import, which meant the browser had
 * to download and evaluate all of it before React rendered anything at all.
 * Nothing on the first screen needs it: the heading, the planet and the
 * hero are the same whether somebody is signed in or not, and the wallet
 * control's own first state is "still starting up", which is a state it
 * already had.
 *
 * It renders no children (see `auth/sessionStore` for why that matters), so
 * a `null` fallback is not a hole in the page — there is nothing behind
 * this boundary but the SDK.
 */
const PrivyAuthProvider = lazy(async () => ({
  default: (await import('./adapters/privy/PrivyAuthProvider')).PrivyAuthProvider,
}))

/**
 * Picks the adapter and mounts it. This is the only file that knows which
 * providers exist at all, and the choice is `VITE_AUTH_PROVIDER`'s — see
 * `config/auth.ts` for how it resolves.
 *
 * Adding a second hosted provider is a new folder under `adapters/` and one
 * more branch here. Nothing above `auth/` has to be told.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = appConfig.auth
  const starting = useMemo(() => startingSession(auth.loginMethods), [auth.loginMethods])

  /*
   * The dev-key signer, and the three conditions that keep it out of
   * anything anybody ships — and out of the way of anybody who did not mean
   * to use it. It has to be asked for by name; it only exists in a dev
   * server (`import.meta.env.DEV` is a compile-time constant, so a
   * production build drops the branch and the adapter with it); and it has
   * to actually hold a key.
   *
   * That last one is not a formality. `VITE_AUTH_PROVIDER=devkey` left in
   * the shell that started `npm run dev` used to mount a keyless adapter
   * over the configured provider: the header relabelled itself from "Sign
   * in" to "Connect Wallet" — the adapter reports wallet-only sign-in — and
   * pressing it did nothing, because there was no account to authenticate.
   * A dev-only signer with nothing to sign with is not a provider, so the
   * real one runs instead.
   */
  if (import.meta.env.DEV && import.meta.env.VITE_AUTH_PROVIDER?.trim() === 'devkey' && hasDevKey()) {
    return <DevKeyAuthProvider>{children}</DevKeyAuthProvider>
  }

  /*
   * The hosted provider is a *sibling* of the app, not its ancestor.
   *
   * That inversion is what lets it be lazy. The context the app reads is
   * mounted here, in a position that never changes, and its value is
   * whatever the adapter has published — so the SDK arriving a moment
   * after the first paint changes a value rather than replacing the tree.
   * Mounted the usual way round, going from "not loaded" to "loaded" would
   * unmount and rebuild everything under it: the scene, the boot sequence,
   * the route.
   *
   * Until it publishes, the app sees a session that is initializing, which
   * is the state it already sits in while the SDK restores a login from
   * storage — no caller learns a new state.
   */
  if (auth.provider === 'privy') {
    return (
      <>
        <Suspense fallback={null}>
          <PrivyAuthProvider auth={auth} app={appConfig} />
        </Suspense>
        <PublishedSession starting={starting}>{children}</PublishedSession>
      </>
    )
  }

  return <LocalAuthProvider>{children}</LocalAuthProvider>
}

/**
 * The store's only subscriber, and deliberately a component of its own.
 *
 * This is not tidiness: subscribing in `AuthProvider` — which also renders
 * the adapter — is an infinite loop, and it is the kind that only appears
 * against the real SDK. Publishing a session wakes every subscriber; if one
 * of them is an ancestor of the adapter, the adapter re-renders too; and
 * the SDK hands out a fresh `login`, `error` and wallet array on every
 * render, so the adapter memoises a *new* session object, publishes it, and
 * wakes itself again. React stops it at "Maximum update depth exceeded",
 * which unmounts the tree — a black page.
 *
 * With the subscription in a sibling, a publish re-renders this component
 * and the app below it, and nothing above the adapter at all. That is also
 * exactly the shape the old wrapper had: the session changing re-rendered
 * the app, never the provider.
 *
 * A mock SDK cannot show any of this. Its hooks return the same objects
 * every render, so the session keeps its identity, the store's own
 * `current === session` check swallows the second publish and the loop
 * never closes — which is why the test beside this one builds its mock to
 * return fresh objects, the way a real SDK does.
 */
function PublishedSession({ starting, children }: { starting: AuthSession; children: ReactNode }) {
  const published = usePublishedAuthSession()
  return <AuthContext.Provider value={published ?? starting}>{children}</AuthContext.Provider>
}

/**
 * What the app reads while the provider is still on its way.
 *
 * Deliberately identical to the session a hosted adapter reports before its
 * SDK is ready: initializing, not authenticated, no wallet. The one thing
 * it has to do properly is refuse a sign-in *out loud* — a `login()` that
 * silently did nothing is the exact bug `startLogin` in the Privy adapter
 * exists to prevent, and it would be a shame to reintroduce it here for the
 * half-second before the SDK lands.
 */
function startingSession(loginMethods: AuthSession['loginMethods']): AuthSession {
  return {
    provider: 'privy',
    status: 'initializing',
    isReady: false,
    isAuthenticated: false,
    user: null,
    wallet: null,
    loginMethods,
    error: null,
    login: async () => {
      throw new Error('Sign-in is still starting up. Give it a moment and try again.')
    },
    /*
     * Logging out of a session that does not exist yet is not an error, it
     * is already true. It resolves rather than throwing for the same reason
     * the sign-in above does the opposite: a press that cannot do what it
     * promised must say so, and a press whose outcome is already the case
     * must not invent a failure.
     */
    logout: async () => {},
  }
}
