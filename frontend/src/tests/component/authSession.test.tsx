import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from '../../auth'
import { LocalAuthProvider } from '../../auth/adapters/local/LocalAuthProvider'

function SessionProbe() {
  const { status, isAuthenticated, wallet, user, login, logout } = useAuth()
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="authenticated">{String(isAuthenticated)}</span>
      <span data-testid="address">{wallet?.address ?? '—'}</span>
      <span data-testid="kind">{wallet?.kind ?? '—'}</span>
      <span data-testid="signs">{typeof wallet?.getEthereumProvider === 'function' ? 'yes' : 'no'}</span>
      <span data-testid="label">{user?.label ?? '—'}</span>
      <button type="button" onClick={() => void login()}>
        sign in
      </button>
      <button type="button" onClick={() => void logout()}>
        sign out
      </button>
    </div>
  )
}

describe('the auth session, on the local provider (ТЗ §8)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('settles into a signed-out session with nobody to act as', async () => {
    render(
      <LocalAuthProvider>
        <SessionProbe />
      </LocalAuthProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'))
    /*
     * The emulator mints an address per browser, but it stays behind the
     * session until somebody connects — the same shape a hosted provider
     * has. Handing it over early is what made connecting decorative: every
     * write in the app guards on having an address, so an address that
     * arrives before the session lets a visitor who never connected create,
     * join, probe and defend.
     */
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false')
    expect(screen.getByTestId('address')).toHaveTextContent('—')
    expect(screen.getByTestId('label')).toHaveTextContent('—')
  })

  it('signs a player in to a simulated wallet that cannot sign anything', async () => {
    const user = userEvent.setup()
    render(
      <LocalAuthProvider>
        <SessionProbe />
      </LocalAuthProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'))

    await user.click(screen.getByRole('button', { name: 'sign in' }))

    expect(screen.getByTestId('authenticated')).toHaveTextContent('true')
    expect(screen.getByTestId('address').textContent).toMatch(/^0x[0-9a-f]{40}$/)
    expect(screen.getByTestId('kind')).toHaveTextContent('simulated')
    // No signing channel, because there are no keys anywhere: contract-mode
    // writes must fail loudly here rather than through a stub.
    expect(screen.getByTestId('signs')).toHaveTextContent('no')
  })

  it('keeps the same identity across a reload, and forgets it on sign-out', async () => {
    const user = userEvent.setup()
    const first = render(
      <LocalAuthProvider>
        <SessionProbe />
      </LocalAuthProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'))
    await user.click(screen.getByRole('button', { name: 'sign in' }))
    const address = screen.getByTestId('address').textContent
    first.unmount()

    const second = render(
      <LocalAuthProvider>
        <SessionProbe />
      </LocalAuthProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('authenticated')).toHaveTextContent('true'))
    expect(screen.getByTestId('address')).toHaveTextContent(address!)

    await user.click(screen.getByRole('button', { name: 'sign out' }))
    expect(screen.getByTestId('authenticated')).toHaveTextContent('false')
    // Signing out withdraws the address from the app, exactly as it would
    // for a hosted wallet.
    expect(screen.getByTestId('address')).toHaveTextContent('—')
    second.unmount()

    // The identity itself outlives the gesture, though — signing out of the
    // emulator is not the same as burning the browser's address, so signing
    // back in lands on the one it already had.
    const third = render(
      <LocalAuthProvider>
        <SessionProbe />
      </LocalAuthProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'))
    await user.click(screen.getByRole('button', { name: 'sign in' }))
    expect(screen.getByTestId('address')).toHaveTextContent(address!)
    third.unmount()
  })

  it('never writes key material — only an address and a flag', async () => {
    const user = userEvent.setup()
    render(
      <LocalAuthProvider>
        <SessionProbe />
      </LocalAuthProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'))
    await user.click(screen.getByRole('button', { name: 'sign in' }))

    const stored = Object.keys(window.localStorage).map((key) => `${key}=${window.localStorage.getItem(key)}`)
    expect(stored.join('\n')).not.toMatch(/private|secret|mnemonic|seed|key/i)
  })
})

describe('the auth abstraction as a boundary', () => {
  it('mounts through AuthProvider without any component naming a provider', async () => {
    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )
    // The test ENV configures no hosted provider, so this is the local one —
    // the component under it cannot tell, which is the point.
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'))
  })

  it('refuses to answer outside a provider rather than inventing a session', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => act(() => void render(<SessionProbe />))).toThrow(/AuthProvider/)
    error.mockRestore()
  })

  /*
   * The dev-key signer is opt-in, dev-only — and useless without a key, so
   * it must not take the app over when it has none.
   *
   * This is a regression test with a report behind it. `VITE_AUTH_PROVIDER=devkey`
   * left in the shell that started the dev server mounted a keyless adapter
   * over the configured provider, and what that produced was the worst kind
   * of broken: the header stopped saying "Sign in" (a keyless adapter still
   * reported wallet-only sign-in) and pressing it did nothing at all, since
   * there was no account to authenticate. The configured provider has to win.
   */
  it('ignores a dev-key request that comes without a key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv('VITE_AUTH_PROVIDER', 'devkey')
    vi.stubEnv('VITE_DEV_PRIVATE_KEY', '')

    render(
      <AuthProvider>
        <SessionProbe />
      </AuthProvider>,
    )

    // The local identity, not a dev-key session that can never sign in: it
    // settles, and signing in from it actually produces a wallet.
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'))
    await userEvent.setup().click(screen.getByRole('button', { name: 'sign in' }))
    await waitFor(() => expect(screen.getByTestId('authenticated')).toHaveTextContent('true'))
    expect(screen.getByTestId('kind')).toHaveTextContent('simulated')

    vi.unstubAllEnvs()
    warn.mockRestore()
  })
})
