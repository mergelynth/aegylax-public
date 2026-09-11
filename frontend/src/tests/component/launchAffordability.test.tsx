import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WalletState } from '../../hooks/useWallet'
import { formatEth } from '../../utils/format'
import { renderWithProviders } from '../testUtils'

const wallet: { current: WalletState } = { current: {} as WalletState }
const balance: { current: number | null } = { current: null }

vi.mock('../../hooks/useWallet', () => ({ useWallet: () => wallet.current }))
vi.mock('../../hooks/useWalletBalance', () => ({ useWalletBalance: () => balance.current }))

const { CreateLobbyModal } = await import('../../components/lobby/CreateLobbyModal')

function signedIn(): WalletState {
  return {
    address: '0x00000000000000000000000000000000000000aa',
    isConnected: true,
    chainId: 1,
    walletKind: 'managed',
    label: null,
    status: 'authenticated',
    isReady: true,
    loginMethods: [],
    error: null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  }
}

function poolField(): HTMLElement {
  return screen.getByRole('spinbutton', { name: /start pool/i })
}

function noteOf(control: HTMLElement): HTMLElement {
  const id = control.getAttribute('aria-describedby')
  const note = id ? document.getElementById(id) : null
  if (!note) throw new Error('Control has no aria-describedby target')
  return note
}

/**
 * The one input to this form that is not on it.
 *
 * A creator can set a start pool larger than they hold, and the protocol's
 * creation fee is charged on top of it — so the first sign of trouble used
 * to be an insufficient-funds revert from their own wallet, after signing,
 * with nothing on screen saying which number to change.
 *
 * The check is deliberately a refusal rather than a cap on the field. A
 * protocol limit is permanent and worth making unreachable, the way the
 * player rail clamps; a balance is transient, and a control that rewrote the
 * start pool when the balance dipped would be changing the creator's terms
 * behind their back.
 */
describe('what the wallet can afford to launch', () => {
  beforeEach(() => {
    wallet.current = signedIn()
    balance.current = null
  })

  it('refuses a start pool the wallet cannot cover, and says so under the field', async () => {
    balance.current = 0.01
    renderWithProviders(<CreateLobbyModal />)

    fireEvent.change(screen.getByLabelText(/operation name/i), { target: { value: 'Orbital Watch' } })
    fireEvent.change(poolField(), { target: { value: '0.5' } })

    await waitFor(() => expect(noteOf(poolField())).toHaveTextContent(/not enough eth/i))
    // It names both figures, so the creator knows how far off they are.
    expect(noteOf(poolField())).toHaveTextContent(formatEth(0.01))
    expect(noteOf(poolField())).toHaveAttribute('role', 'alert')

    fireEvent.click(screen.getByRole('button', { name: /launch operation/i }))
    expect(screen.getByText(/fix the highlighted field/i)).toBeInTheDocument()
  })

  it('leaves a start pool the wallet can cover alone', async () => {
    balance.current = 1
    renderWithProviders(<CreateLobbyModal />)

    fireEvent.change(poolField(), { target: { value: '0.5' } })

    await waitFor(() => expect(noteOf(poolField())).toHaveTextContent(/funded by you at launch/i))
  })

  /*
   * The pool alone fits; the pool plus the protocol's creation fee and the gas
   * reserve does not. This is the case a naive "pool <= balance" check waves
   * through and the wallet then rejects — the fee is charged at mint and is
   * not the creator's to remove.
   */
  it('counts the protocol fee and a gas reserve, not just the pool', async () => {
    balance.current = 0.1
    renderWithProviders(<CreateLobbyModal />)

    fireEvent.change(poolField(), { target: { value: '0.1' } })

    await waitFor(() => expect(noteOf(poolField())).toHaveTextContent(/not enough eth/i))
  })

  /*
   * `null` is unknown, never zero: it is the value before the first read
   * lands, and the honest answer in contract mode with no RPC configured.
   * Refusing on it would block launches for wallets with money in them.
   */
  it('does not refuse a launch merely because the balance has not arrived', () => {
    balance.current = null
    renderWithProviders(<CreateLobbyModal />)

    fireEvent.change(poolField(), { target: { value: '999' } })

    expect(noteOf(poolField())).not.toHaveTextContent(/not enough eth/i)
  })

  it('says nothing about affordability while nobody is signed in', () => {
    balance.current = 0.0001
    wallet.current = { ...signedIn(), address: null, isConnected: false, status: 'unauthenticated' }
    renderWithProviders(<CreateLobbyModal />)

    fireEvent.change(poolField(), { target: { value: '999' } })

    expect(noteOf(poolField())).not.toHaveTextContent(/not enough eth/i)
  })
})
