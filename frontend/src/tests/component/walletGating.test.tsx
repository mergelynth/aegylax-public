import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { LocalAuthProvider } from '../../auth/adapters/local/LocalAuthProvider'
import { useWallet } from '../../hooks/useWallet'

/**
 * The gate every write in the app depends on.
 *
 * Each action hook guards the same way — `if (!address) throw` — so whether
 * an unconnected visitor can create an operation, join one, spend a probe or
 * commit a Defense Point is decided entirely by whether `useWallet` hands out
 * an address before anybody connected. It used to, on the local identity,
 * because that adapter mints an address per browser and exposed it
 * immediately; the whole connect flow was then decorative and every guard in
 * the app passed for somebody who had never pressed it.
 *
 * These assertions are about that one fact, on the adapter where it can go
 * wrong. The hosted provider has no address to leak before sign-in.
 */
function WalletProbe() {
  const { address, isConnected, isReady, connect, disconnect } = useWallet()
  return (
    <div>
      <span data-testid="ready">{String(isReady)}</span>
      <span data-testid="connected">{String(isConnected)}</span>
      <span data-testid="address">{address ?? '—'}</span>
      <button type="button" onClick={() => void connect()}>
        connect
      </button>
      <button type="button" onClick={() => void disconnect()}>
        disconnect
      </button>
    </div>
  )
}

function renderProbe() {
  return render(
    <LocalAuthProvider>
      <WalletProbe />
    </LocalAuthProvider>,
  )
}

describe('useWallet: nobody acts without connecting', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('has no address to act as before the player connects', async () => {
    renderProbe()
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))

    expect(screen.getByTestId('connected')).toHaveTextContent('false')
    expect(screen.getByTestId('address')).toHaveTextContent('—')
  })

  it('hands one over on connect and takes it back on disconnect', async () => {
    const user = userEvent.setup()
    renderProbe()
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))

    await user.click(screen.getByRole('button', { name: 'connect' }))
    expect(screen.getByTestId('connected')).toHaveTextContent('true')
    expect(screen.getByTestId('address').textContent).toMatch(/^0x[0-9a-f]{40}$/)

    await user.click(screen.getByRole('button', { name: 'disconnect' }))
    expect(screen.getByTestId('connected')).toHaveTextContent('false')
    expect(screen.getByTestId('address')).toHaveTextContent('—')
  })

  it('does not leak an identity a previous session left in storage', async () => {
    // The address survives sign-out on purpose — it is this browser's, and
    // signing back in should land on it. What must not survive is the app
    // being able to *use* it while nobody is signed in.
    window.localStorage.setItem(
      'emulator-wallet-address',
      JSON.stringify('0x00000000000000000000000000000000000000aa'),
    )
    window.localStorage.setItem('emulator-wallet-connected', JSON.stringify(false))

    renderProbe()
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'))

    expect(screen.getByTestId('address')).toHaveTextContent('—')
  })
})
