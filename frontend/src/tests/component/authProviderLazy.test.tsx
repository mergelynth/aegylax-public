import { act, render, screen, waitFor } from '@testing-library/react'
import { useEffect, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The hosted provider is a *sibling* of the app, not its ancestor — and
 * these are the things that buys, checked separately.
 *
 * It is worth a suite of its own because the failure is invisible in
 * development, where the SDK is already in the module graph and answers on
 * the first frame. On a cold load over a slow connection the app runs for a
 * second or more with no provider at all, and the whole design rests on
 * that second being ordinary: the page renders, the wallet control says it
 * is starting up, and when the SDK lands nothing is torn down.
 *
 * Everything is imported *after* the environment is stubbed, because
 * `appConfig` reads it once at module load and `AuthProvider` branches on
 * the result. That also means each mount gets a fresh module registry — so
 * the context the probe reads has to come from the same batch of imports as
 * the provider under test, or the two would be different modules.
 */

const sdk = vi.hoisted(() => ({
  privy: {
    ready: true,
    authenticated: false,
    user: null as unknown,
    error: null as Error | null,
    login: vi.fn(),
    logout: vi.fn(async () => {}),
  },
  wallets: { wallets: [] as unknown[], ready: true },
}))

/*
 * The stub returns *fresh objects on every render*, and that is the whole
 * point of it rather than an accident of writing it quickly.
 *
 * A mock that hands back one stable object per hook cannot reproduce the
 * only serious bug this design has had: the adapter memoises a new session
 * whenever the SDK's `login`, `error` or wallet array changes identity,
 * which the real SDK does constantly, and a subscriber sitting above the
 * adapter then feeds that back into it forever. With stable objects the
 * session keeps its identity, the store swallows the second publish, and
 * the loop never closes — the suite goes green over a black page.
 */
vi.mock('@privy-io/react-auth', () => ({
  PrivyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  usePrivy: () => ({ ...sdk.privy, login: () => {}, logout: async () => {} }),
  useWallets: () => ({ wallets: [...sdk.wallets.wallets], ready: sdk.wallets.ready }),
}))

const mounts = { app: 0 }

async function mountWithPrivyConfigured() {
  vi.stubEnv('VITE_AUTH_PROVIDER', 'privy')
  vi.stubEnv('VITE_PRIVY_APP_ID', 'test-app-id')
  vi.resetModules()

  const { AuthProvider } = await import('../../auth/AuthProvider')
  const { useAuth } = await import('../../auth/AuthContext')
  const { publishAuthSession } = await import('../../auth/sessionStore')
  const { appConfig } = await import('../../config/env')

  let login: (() => Promise<void>) | null = null

  function Probe() {
    // The mount counter lives on the outer component, so a remount of the
    // app subtree is what it counts — not a re-render of the readout.
    useEffect(() => {
      mounts.app += 1
    }, [])
    return <Readout />
  }

  function Readout() {
    const session = useAuth()
    login = session.login
    return (
      <div>
        <span data-testid="status">{session.status}</span>
        <span data-testid="ready">{String(session.isReady)}</span>
      </div>
    )
  }

  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  )

  return { publishAuthSession, loginMethods: appConfig.auth.loginMethods, login: () => login!() }
}

beforeEach(() => {
  mounts.app = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('<AuthProvider /> — a hosted SDK that is not on the critical path', () => {
  /**
   * The point of the whole inversion: the page exists before the vendor
   * bundle does. If this ever fails, 1.6MB has moved back in front of the
   * first paint.
   */
  it('renders the app while the provider is still loading, with a session that is initializing', async () => {
    await mountWithPrivyConfigured()

    expect(screen.getByTestId('status')).toHaveTextContent('initializing')
    expect(screen.getByTestId('ready')).toHaveTextContent('false')
    expect(mounts.app).toBe(1)
  })

  /**
   * The other half, and the reason the session travels through a store
   * rather than through the tree: when the adapter finally answers, the app
   * must see a new *value*, not a new tree. Mounted the usual way round —
   * a lazy provider wrapping the app — this number would be 2, and
   * everything underneath (the scene, the boot sequence, the open route)
   * would have been rebuilt a second after the page appeared.
   */
  it('does not remount the app when the session arrives', async () => {
    const { publishAuthSession, loginMethods } = await mountWithPrivyConfigured()
    expect(mounts.app).toBe(1)

    act(() => {
      publishAuthSession({
        provider: 'privy',
        status: 'unauthenticated',
        isReady: true,
        isAuthenticated: false,
        user: null,
        wallet: null,
        loginMethods,
        error: null,
        login: async () => {},
        logout: async () => {},
      })
    })

    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated')
    expect(screen.getByTestId('ready')).toHaveTextContent('true')
    expect(mounts.app).toBe(1)
  })

  /**
   * A press that lands in the gap has to say so rather than do nothing —
   * the same rule the adapter's own `startLogin` follows, and for the same
   * reason: a silent no-op is how "Sign in does nothing" bugs are born.
   */
  it('refuses a sign-in out loud while the provider is still on its way', async () => {
    const { login } = await mountWithPrivyConfigured()
    await expect(login()).rejects.toThrow(/still starting up/i)
  })

  /**
   * The bug that took the page down: a black screen, and React's own
   * "Maximum update depth exceeded" behind it.
   *
   * Publishing a session wakes every subscriber. When one of them is an
   * ancestor of the adapter — which it was, because `AuthProvider`
   * subscribed *and* rendered the adapter — the adapter re-renders, the SDK
   * hands it fresh objects, it memoises a new session, publishes that, and
   * wakes itself again. React stops the loop by unmounting the tree.
   *
   * So this test does the one thing the others deliberately do not: it lets
   * the lazy adapter actually mount, and then waits for a session to come
   * through it. With the subscription in the wrong place it never arrives —
   * the render loop throws first.
   */
  it('does not feed its own updates back into the adapter', async () => {
    await mountWithPrivyConfigured()

    // Let `React.lazy` resolve and the adapter's effects run.
    await act(async () => {
      await Promise.resolve()
    })

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'))
    expect(screen.getByTestId('ready')).toHaveTextContent('true')
    // Still the same app: the session arrived as a value, not as a new tree.
    expect(mounts.app).toBe(1)
  })
})
