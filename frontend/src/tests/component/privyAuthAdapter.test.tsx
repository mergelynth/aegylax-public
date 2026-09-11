import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState, type ReactNode } from 'react'
import { baseSepolia } from 'viem/chains'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../../auth'
import { PrivyAuthProvider, WALLET_RESTORE_MS } from '../../auth/adapters/privy/PrivyAuthProvider'
import { resetAuthSession, usePublishedAuthSession } from '../../auth/sessionStore'

import { privySessionStatus } from '../../auth/adapters/privy/PrivyAuthProvider'
import { parseAuthConfig, type AuthConfig } from '../../config/auth'
import { appConfig } from '../../config/env'

/**
 * The adapter, with the vendor SDK stubbed out.
 *
 * This is where the translation is checked: Privy's shapes go in, an
 * `AuthSession` comes out, and the app above never sees the difference.
 * The SDK is mocked rather than reached over the network — the questions
 * here are about mapping, not about Privy's servers.
 */

/**
 * Every value the adapter hands to the store, in order — the real function
 * still runs underneath, so nothing about the adapter's behaviour changes.
 */
const published = vi.hoisted(() => [] as unknown[])

vi.mock('../../auth/sessionStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../auth/sessionStore')>()
  return {
    ...actual,
    publishAuthSession: (session: Parameters<typeof actual.publishAuthSession>[0]) => {
      published.push(session)
      actual.publishAuthSession(session)
    },
  }
})

const sdk = vi.hoisted(() => ({
  privy: {
    ready: true,
    authenticated: true,
    user: null as unknown,
    error: null as Error | null,
    login: vi.fn(),
    logout: vi.fn(async () => {}),
  },
  wallets: { wallets: [] as unknown[], ready: true },
  providerProps: null as { appId?: string; clientId?: string; config?: Record<string, unknown> } | null,
}))

vi.mock('@privy-io/react-auth', () => ({
  PrivyProvider: ({ children, ...props }: { children: ReactNode }) => {
    sdk.providerProps = props
    return <>{children}</>
  },
  usePrivy: () => sdk.privy,
  useWallets: () => sdk.wallets,
}))

/** A connected wallet as Privy hands it over — a fresh object every read. */
function connectedWallet(address: string, walletClientType: string, chainId = `eip155:${baseSepolia.id}`) {
  return {
    address,
    walletClientType,
    chainId,
    getEthereumProvider: vi.fn(async () => ({ request: vi.fn() })),
    switchChain: vi.fn(async () => {}),
  }
}

function SessionProbe() {
  const { status, isAuthenticated, wallet, user, loginMethods, login, logout, error } = useAuth()
  const [loginError, setLoginError] = useState<string | null>(null)
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="authenticated">{String(isAuthenticated)}</span>
      <span data-testid="address">{wallet?.address ?? '—'}</span>
      <span data-testid="kind">{wallet?.kind ?? '—'}</span>
      <span data-testid="chain">{wallet?.chainId ?? '—'}</span>
      <span data-testid="label">{user?.label ?? '—'}</span>
      <span data-testid="method">{user?.loginMethod ?? '—'}</span>
      <span data-testid="methods">{loginMethods.join(',')}</span>
      <button
        type="button"
        onClick={() => {
          void login().then(
            () => setLoginError('(resolved)'),
            (err: unknown) => setLoginError(err instanceof Error ? err.message : String(err)),
          )
        }}
      >
        sign in
      </button>
      <span data-testid="login-outcome">{loginError ?? '—'}</span>
      <span data-testid="error">{error?.message ?? '—'}</span>
      <button type="button" onClick={() => void logout()}>
        sign out
      </button>
    </div>
  )
}

function authConfig(env: Partial<Record<string, string>> = {}): AuthConfig {
  return parseAuthConfig({ VITE_PRIVY_APP_ID: 'app-id', ...env } as unknown as ImportMetaEnv, 'contract')
}

function renderAdapter(config: AuthConfig = authConfig(), children: ReactNode = <SessionProbe />) {
  return render(
    <PrivyAuthProvider auth={config} app={{ ...appConfig, chainId: baseSepolia.id }}>
      {children}
    </PrivyAuthProvider>,
  )
}

beforeEach(() => {
  sdk.privy = {
    ready: true,
    authenticated: true,
    user: null,
    error: null,
    login: vi.fn(),
    logout: vi.fn(async () => {}),
  }
  sdk.wallets = { wallets: [], ready: true }
  sdk.providerProps = null
  resetAuthSession()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('privySessionStatus', () => {
  const restoring = {
    ready: false,
    walletsReady: false,
    authenticated: false,
    hasAddress: false,
    hasLinkedWallet: false,
    restoreTimedOut: false,
  }

  it('is initializing until the SDK has restored its session', () => {
    expect(privySessionStatus(restoring)).toMatchObject({ status: 'initializing', isReady: false })
  })

  it('offers sign-in while wallets are still hydrating and nobody is signed in', () => {
    expect(
      privySessionStatus({ ...restoring, ready: true, walletsReady: false }),
    ).toMatchObject({ status: 'unauthenticated', stuck: false, isReady: true })
  })

  it('waits on a first-time managed wallet, then gives up', () => {
    const minting = {
      ...restoring,
      ready: true,
      walletsReady: true,
      authenticated: true,
    }
    expect(privySessionStatus(minting)).toMatchObject({ status: 'initializing', stuck: false })
    expect(privySessionStatus({ ...minting, restoreTimedOut: true })).toMatchObject({
      status: 'unauthenticated',
      stuck: true,
    })
  })

  it('drops a linked external wallet that the browser will not hand over', () => {
    expect(
      privySessionStatus({
        ready: true,
        walletsReady: true,
        authenticated: true,
        hasAddress: false,
        hasLinkedWallet: true,
        restoreTimedOut: false,
      }),
    ).toMatchObject({ status: 'unauthenticated', stuck: true, isReady: true })
  })
})

describe('the Privy adapter: what reaches the SDK', () => {
  it('passes the ENV-configured app id and client config, never a hardcoded one', () => {
    renderAdapter(authConfig({ VITE_PRIVY_CLIENT_ID: 'client-id', VITE_AUTH_LOGIN_METHODS: 'email,wallet' }))

    expect(sdk.providerProps?.appId).toBe('app-id')
    expect(sdk.providerProps?.clientId).toBe('client-id')
    expect(sdk.providerProps?.config).toMatchObject({
      loginMethods: ['email', 'wallet'],
      embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
    })

    /*
     * The chain is matched by id rather than by object identity. The
     * definition handed to the SDK is viem's, with the deployment
     * manifest's RPC and explorer layered on top — that layering is the
     * point, since it is what lets a network the app has never been
     * compiled for still arrive with a working transport — so it is
     * deliberately not the untouched `baseSepolia` constant.
     */
    const config = sdk.providerProps?.config as { defaultChain?: { id: number }; supportedChains?: { id: number }[] }
    expect(config.defaultChain?.id).toBe(baseSepolia.id)
    expect(config.supportedChains?.map((chain) => chain.id)).toContain(baseSepolia.id)
  })

  it('refuses to mount without an app id instead of reaching for a default', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderAdapter(parseAuthConfig({} as ImportMetaEnv, 'emulator'))).toThrow(/VITE_PRIVY_APP_ID/)
    error.mockRestore()
  })
})

describe('the Privy adapter: what comes back out', () => {
  it('reports a session that is still restoring as initializing', () => {
    sdk.privy.ready = false
    renderAdapter()

    expect(screen.getByTestId('status')).toHaveTextContent('initializing')
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false')
  })

  it('turns a social login with a managed wallet into an address and a human label', () => {
    sdk.privy.user = { id: 'did:privy:1', google: { email: 'pilot@example.test', name: 'Pilot' } }
    sdk.wallets = { wallets: [connectedWallet('0xAAaa', 'privy')], ready: true }
    renderAdapter()

    expect(screen.getByTestId('status')).toHaveTextContent('authenticated')
    expect(screen.getByTestId('address')).toHaveTextContent('0xAAaa')
    expect(screen.getByTestId('kind')).toHaveTextContent('managed')
    expect(screen.getByTestId('chain')).toHaveTextContent(String(baseSepolia.id))
    expect(screen.getByTestId('label')).toHaveTextContent('pilot@example.test')
    expect(screen.getByTestId('method')).toHaveTextContent('google')
  })

  it('leaves a wallet-only player with no invented label', () => {
    sdk.privy.user = { id: 'did:privy:2', wallet: { address: '0xBBbb' } }
    sdk.wallets = { wallets: [connectedWallet('0xBBbb', 'metamask')], ready: true }
    renderAdapter()

    expect(screen.getByTestId('label')).toHaveTextContent('—')
    expect(screen.getByTestId('method')).toHaveTextContent('wallet')
    expect(screen.getByTestId('kind')).toHaveTextContent('external')
  })

  it('plays as the account the session is verified against when several are connected', () => {
    sdk.privy.user = { id: 'did:privy:3', wallet: { address: '0xCCcc' } }
    sdk.wallets = {
      wallets: [connectedWallet('0xDDdd', 'privy'), connectedWallet('0xCCcc', 'metamask')],
      ready: true,
    }
    renderAdapter()

    expect(screen.getByTestId('address')).toHaveTextContent('0xCCcc')
  })

  it('prefers the managed wallet when the session names none', () => {
    sdk.privy.user = { id: 'did:privy:4', email: { address: 'pilot@example.test' } }
    sdk.wallets = {
      wallets: [connectedWallet('0xEEee', 'metamask'), connectedWallet('0xFFff', 'privy')],
      ready: true,
    }
    renderAdapter()

    expect(screen.getByTestId('address')).toHaveTextContent('0xFFff')
    expect(screen.getByTestId('kind')).toHaveTextContent('managed')
  })

  it('is not yet playable when signed in with no wallet minted yet', () => {
    sdk.privy.user = { id: 'did:privy:5', email: { address: 'pilot@example.test' } }
    renderAdapter()

    expect(screen.getByTestId('authenticated')).toHaveTextContent('false')
    expect(screen.getByTestId('address')).toHaveTextContent('—')
    // Not "authenticated": a caller must never be told the session is ready
    // and then find no address on it.
    expect(screen.getByTestId('status')).toHaveTextContent('initializing')
  })

  /**
   * A previous MetaMask (or any external wallet) that Privy still has a
   * session for, but the browser will not hand over — locked, blocked, or
   * disconnected. That is not initializing: the SDK finished restoring, the
   * wallet list is complete, and the linked address is not in it. Staying
   * on "Loading…" here disabled Sign in forever.
   */
  it('drops a restored session whose linked wallet never appears', async () => {
    sdk.privy.user = { id: 'did:privy:9', wallet: { address: '0xB10c' } }
    sdk.wallets = { wallets: [], ready: true }
    renderAdapter()

    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated')
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false')
    await waitFor(() => expect(sdk.privy.logout).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent(/blocked or locked/i))
  })

  /**
   * Logged out, but `useWallets().ready` never flips — a blocked extension
   * hanging the wallet scan. Sign in must still be offered; waiting on the
   * wallet list is how "Loading…" used to trap people who were not even
   * signed in.
   */
  it('offers sign-in when the wallet list is still hydrating and nobody is signed in', () => {
    sdk.privy.authenticated = false
    sdk.wallets = { wallets: [], ready: false }
    renderAdapter()

    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated')
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false')
  })

  it('gives up on a managed wallet that never mints', async () => {
    vi.useFakeTimers()
    sdk.privy.user = { id: 'did:privy:10', email: { address: 'pilot@example.test' } }
    sdk.wallets = { wallets: [], ready: true }
    renderAdapter()

    expect(screen.getByTestId('status')).toHaveTextContent('initializing')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(WALLET_RESTORE_MS)
    })

    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated')
    expect(screen.getByTestId('error')).toHaveTextContent(/blocked or locked/i)
    vi.useRealTimers()
  })

  /**
   * The bug this exists to stop coming back: pressing a button that starts
   * sign-in, while the SDK was still restoring its session, did nothing at
   * all.
   *
   * Privy's `login()` is not a promise and is not guarded — called before
   * `ready` it logs a warning and returns. Every caller in this app wraps
   * the call in `try/catch` specifically so a sign-in that cannot start
   * says so, and there was never anything to catch: no modal, no
   * transaction, no error. Launch Defense looked like a dead button.
   *
   * So an unstartable sign-in has to *reject*, and it has to not pretend it
   * reached the SDK.
   */
  it('refuses a sign-in the SDK cannot start yet, instead of doing nothing', async () => {
    const user = userEvent.setup()
    sdk.privy.ready = false
    renderAdapter()

    await user.click(screen.getByRole('button', { name: 'sign in' }))

    expect(sdk.privy.login).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByTestId('login-outcome')).toHaveTextContent(/still starting up/i),
    )
  })

  it('drops a restored session before opening sign-in, so the SDK will accept it', async () => {
    const user = userEvent.setup()
    sdk.privy.user = { id: 'did:privy:11', wallet: { address: '0xB10c' } }
    sdk.wallets = { wallets: [], ready: true }
    renderAdapter()

    await user.click(screen.getByRole('button', { name: 'sign in' }))
    await waitFor(() => expect(sdk.privy.logout).toHaveBeenCalled())
    expect(sdk.privy.login).toHaveBeenCalled()
  })

  it('delegates sign-in and sign-out to the SDK', async () => {
    const user = userEvent.setup()
    sdk.privy.user = { id: 'did:privy:6', wallet: { address: '0xAAaa' } }
    sdk.wallets = { wallets: [connectedWallet('0xAAaa', 'privy')], ready: true }
    renderAdapter()

    await user.click(screen.getByRole('button', { name: 'sign in' }))
    expect(sdk.privy.login).toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'sign out' }))
    await waitFor(() => expect(sdk.privy.logout).toHaveBeenCalled())
  })
})

describe('the Privy adapter: identity stability', () => {
  it('keeps one wallet identity while the address and chain hold still', async () => {
    const attach = vi.fn()

    function WalletWatcher() {
      const { wallet } = useAuth()
      useEffect(() => {
        attach()
      }, [wallet])
      return null
    }

    /**
     * Re-renders the adapter itself, which is what makes this a real test:
     * the session is rebuilt from a *new* batch of SDK wallet objects, the
     * way it is on every SDK render in the browser.
     */
    function Harness() {
      const [tick, setTick] = useState(0)
      return (
        <>
          <button type="button" onClick={() => setTick((n) => n + 1)}>
            re-render
          </button>
          <PrivyAuthProvider auth={authConfig()} app={{ ...appConfig, chainId: baseSepolia.id }} key="stable">
            <WalletWatcher />
            <span data-testid="tick">{tick}</span>
          </PrivyAuthProvider>
        </>
      )
    }

    const user = userEvent.setup()
    sdk.privy.user = { id: 'did:privy:7', wallet: { address: '0xAAaa' } }
    sdk.wallets = { wallets: [connectedWallet('0xAAaa', 'privy')], ready: true }
    render(<Harness />)

    expect(attach).toHaveBeenCalledTimes(1)

    // The SDK rebuilds its wallet object constantly; the signer bridge runs
    // an effect on ours, so a new object per render would re-attach a
    // wallet client on every render.
    sdk.wallets = { wallets: [connectedWallet('0xAAaa', 'privy')], ready: true }
    await user.click(screen.getByRole('button', { name: 're-render' }))
    sdk.wallets = { wallets: [connectedWallet('0xAAaa', 'privy')], ready: true }
    await user.click(screen.getByRole('button', { name: 're-render' }))

    expect(screen.getByTestId('tick')).toHaveTextContent('2')
    expect(attach).toHaveBeenCalledTimes(1)
  })

  it('hands over a new wallet identity when the player switches chain', async () => {
    const attach = vi.fn()

    function WalletWatcher() {
      const { wallet } = useAuth()
      useEffect(() => {
        attach(wallet?.chainId ?? null)
      }, [wallet])
      return null
    }

    function Harness() {
      const [tick, setTick] = useState(0)
      return (
        <>
          <button type="button" onClick={() => setTick((n) => n + 1)}>
            re-render
          </button>
          <PrivyAuthProvider auth={authConfig()} app={{ ...appConfig, chainId: baseSepolia.id }}>
            <WalletWatcher />
            <span data-testid="tick">{tick}</span>
          </PrivyAuthProvider>
        </>
      )
    }

    const user = userEvent.setup()
    sdk.privy.user = { id: 'did:privy:8', wallet: { address: '0xAAaa' } }
    sdk.wallets = { wallets: [connectedWallet('0xAAaa', 'privy')], ready: true }
    render(<Harness />)

    sdk.wallets = { wallets: [connectedWallet('0xAAaa', 'privy', 'eip155:8453')], ready: true }
    await user.click(screen.getByRole('button', { name: 're-render' }))

    expect(attach).toHaveBeenNthCalledWith(1, baseSepolia.id)
    expect(attach).toHaveBeenNthCalledWith(2, 8453)
  })
})

/**
 * The session also leaves this adapter through `auth/sessionStore`, because
 * in the app the adapter is a lazily loaded *sibling* of the tree rather
 * than its root — see `auth/AuthProvider`. What the store must never do is
 * blink.
 */
describe('the Privy adapter: what reaches the store', () => {
  function StoreProbe({ log }: { log: (session: unknown) => void }) {
    log(usePublishedAuthSession())
    return null
  }

  /**
   * Asserted on the *store's* contents rather than on what a React
   * subscriber renders, and the difference is the whole reason this test is
   * written this way.
   *
   * The mistake it guards against is publishing `null` from the effect's
   * cleanup, which then runs on every change of the session and not only on
   * unmount — so each auth update writes a gap into the store before it
   * writes the new value. Through `useSyncExternalStore` that gap is
   * usually invisible: both writes land in the same commit and React
   * coalesces them, which is exactly why a test that watched a rendered
   * probe passed against the bug and proved nothing. The gap is real in the
   * store all the same, and anything that reads it outside that coalescing
   * — a later subscriber, a read from an effect, a non-React consumer —
   * reads "no session" in the middle of an update that had one.
   */
  it('never publishes a gap between one session and the next', () => {
    published.length = 0

    const { rerender } = render(
      <PrivyAuthProvider auth={authConfig()} app={{ ...appConfig, chainId: baseSepolia.id }} />,
    )

    // A wallet arrives — the SDK's own state changes and the adapter
    // recomputes a new session object.
    sdk.wallets = { wallets: [connectedWallet('0x1111111111111111111111111111111111111111', 'privy')], ready: true }
    rerender(<PrivyAuthProvider auth={authConfig()} app={{ ...appConfig, chainId: baseSepolia.id }} />)

    const sessions = published.slice(published.findIndex((session) => session !== null))
    expect(sessions.length).toBeGreaterThan(1)
    expect(sessions).not.toContain(null)
  })

  /** And it does clear on the way out, so a later mount starts empty. */
  it('clears the store when it unmounts', () => {
    const seen: unknown[] = []
    const { unmount } = render(
      <>
        <PrivyAuthProvider auth={authConfig()} app={{ ...appConfig, chainId: baseSepolia.id }} />
        <StoreProbe log={(session) => seen.push(session)} />
      </>,
    )
    expect(seen.at(-1)).not.toBeNull()

    unmount()

    const after: unknown[] = []
    render(<StoreProbe log={(session) => after.push(session)} />)
    expect(after.at(-1)).toBeNull()
  })
})
