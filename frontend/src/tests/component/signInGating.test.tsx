import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WalletState } from '../../hooks/useWallet'
import { renderWithProviders } from '../testUtils'

const wallet: { current: WalletState } = { current: {} as WalletState }

vi.mock('../../hooks/useWallet', () => ({
  useWallet: () => wallet.current,
}))

const { CreateLobbyModal } = await import('../../components/lobby/CreateLobbyModal')

function signedOut(status: WalletState['status'], connect = vi.fn()): WalletState {
  return {
    address: null,
    isConnected: false,
    chainId: null,
    walletKind: null,
    label: null,
    status,
    isReady: status !== 'initializing',
    loginMethods: [],
    error: null,
    connect,
    disconnect: vi.fn(),
  }
}

/** The form is valid only once the operation has a name. */
function nameTheOperation() {
  fireEvent.change(screen.getByLabelText('Operation name'), { target: { value: 'Test Operation' } })
}

/**
 * The primary control, pressed. Signed out it is the sign-in — the button
 * says so, because a press with no wallet behind it cannot launch anything
 * and should not claim it will.
 */
function pressPrimary() {
  fireEvent.click(screen.getByRole('button', { name: /sign in to launch/i }))
}

/**
 * Pressing Launch Defense without a wallet, in the two states a signed-out
 * player can be in.
 *
 * The bug this covers: while the sign-in SDK was still restoring its
 * session, the press did *nothing at all* — no modal, no error, no busy
 * state. Privy's `login()` is a no-op before it is ready, so the modal's
 * `try/catch` had nothing to catch and the primary call to action of the
 * whole app looked broken for the first seconds of every page load.
 */
describe('Launch Defense while signed out', () => {
  beforeEach(() => {
    wallet.current = signedOut('unauthenticated')
  })

  it('opens sign-in when the provider is ready', () => {
    const connect = vi.fn()
    wallet.current = signedOut('unauthenticated', connect)
    renderWithProviders(<CreateLobbyModal />)

    nameTheOperation()
    pressPrimary()

    expect(connect).toHaveBeenCalledTimes(1)
  })

  /**
   * The press is *taken*, not refused and not dropped: the button says it is
   * waiting, and the sign-in opens on its own the moment the provider is up.
   * What it does not do is go on to launch — spending waits for a press of
   * its own, held (see the Create Operation suite).
   */
  it('acknowledges the press while the provider is still starting up', () => {
    const connect = vi.fn()
    wallet.current = signedOut('initializing', connect)
    renderWithProviders(<CreateLobbyModal />)

    nameTheOperation()
    pressPrimary()

    // Asking a provider that cannot answer is what produced silence before.
    expect(connect).not.toHaveBeenCalled()

    const button = screen.getByRole('button', { name: /waiting for sign-in/i })
    expect(button).toHaveAttribute('aria-busy', 'true')
  })

  /** Whatever happens, the press must never be a no-op. */
  it('never leaves the press with nothing to show for it', () => {
    for (const status of ['unauthenticated', 'initializing'] as const) {
      const connect = vi.fn()
      wallet.current = signedOut(status, connect)
      const { unmount } = renderWithProviders(<CreateLobbyModal />)

      nameTheOperation()
      pressPrimary()

      const reached = connect.mock.calls.length > 0
      const waiting = screen.queryByRole('button', { name: /waiting for sign-in/i }) !== null
      expect(reached || waiting).toBe(true)

      unmount()
    }
  })
})
