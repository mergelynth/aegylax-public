import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { WalletStatus } from '../../components/wallet/WalletStatus'
import { BlockchainClientProvider } from '../../app/providers/BlockchainClientProvider'

const ADDRESS = '0x1111111111111111111111111111111111111111' as const

function renderStatus(props: Partial<Parameters<typeof WalletStatus>[0]> = {}) {
  return render(
    <MemoryRouter>
      <BlockchainClientProvider>
        <WalletStatus address={ADDRESS} chainId={null} onDisconnect={vi.fn()} {...props} />
      </BlockchainClientProvider>
    </MemoryRouter>,
  )
}

/**
 * The account panel exists because of one dead end (ТЗ §2).
 *
 * Sign in with an email and the pill shows the email, the balance shows
 * zero, and every action in the game costs ETH — with no address on screen
 * there is no way to fund the wallet at all. So the tests below are about
 * reachability rather than decoration: is the address gettable, in full, in
 * one press, and does the screen say what to do with it.
 */
describe('<WalletStatus /> funding a wallet', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
  })

  it('keeps the address one press away even when a login label stands in for it', () => {
    renderStatus({ label: 'player@example.com' })
    // The pill names the human, not the hex — but the hex is not gone.
    expect(screen.getByText('player@example.com')).toBeInTheDocument()
    expect(screen.queryByText(ADDRESS)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /wallet address and deposits/i }))
    expect(screen.getByRole('dialog', { name: 'Wallet' })).toBeInTheDocument()
    // In full: this is the string that gets pasted into a withdrawal form,
    // and an elided middle is exactly the part nobody can reconstruct.
    expect(screen.getByText(ADDRESS)).toBeInTheDocument()
  })

  it('copies the whole address to the clipboard and says that it did', async () => {
    renderStatus({ label: 'player@example.com' })
    fireEvent.click(screen.getByRole('button', { name: /wallet address and deposits/i }))
    fireEvent.click(screen.getByRole('button', { name: /copy address/i }))

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(ADDRESS)
    await waitFor(() => expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument())
  })

  it('explains where the wallet came from when the player never chose one', () => {
    renderStatus({ label: 'player@example.com', isManaged: true })
    fireEvent.click(screen.getByRole('button', { name: /wallet address and deposits/i }))
    expect(screen.getByText(/created for you when you signed in/i)).toBeInTheDocument()
    expect(screen.getByText(/send eth/i)).toBeInTheDocument()
  })

  it('closes on Escape rather than staying open over the page', () => {
    renderStatus()
    fireEvent.click(screen.getByRole('button', { name: /wallet address and deposits/i }))
    expect(screen.getByRole('dialog', { name: 'Wallet' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Wallet' })).not.toBeInTheDocument()
  })

  it('still offers Disconnect as its own control, not buried in the panel', () => {
    const onDisconnect = vi.fn()
    renderStatus({ onDisconnect })
    fireEvent.click(screen.getByRole('button', { name: /disconnect wallet/i }))
    expect(onDisconnect).toHaveBeenCalledOnce()
  })
})
