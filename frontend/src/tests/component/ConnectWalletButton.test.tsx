import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ConnectWalletButton } from '../../components/wallet/ConnectWalletButton'
import { renderWithProviders } from '../testUtils'

describe('<ConnectWalletButton /> (spec §8: emulator works without a real wallet)', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  /*
   * The label is fixed, in every configuration. It used to be derived from
   * the session's login methods, which made the header's most important
   * control rename itself to "Connect Wallet" whenever an adapter happened
   * to report wallet-only sign-in.
   */
  it('invites the player to sign in when disconnected', async () => {
    renderWithProviders(<ConnectWalletButton />)
    expect(await screen.findByRole('button', { name: /^sign in$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /connect wallet/i })).not.toBeInTheDocument()
  })

  it('shows the emulator address and a Disconnect button after connecting', async () => {
    renderWithProviders(<ConnectWalletButton />)
    fireEvent.click(await screen.findByRole('button', { name: /^sign in$/i }))
    expect(await screen.findByRole('button', { name: /disconnect/i })).toBeInTheDocument()
    expect(screen.getByText(/^0x/)).toBeInTheDocument()
  })
})
