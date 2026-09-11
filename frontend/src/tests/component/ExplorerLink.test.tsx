import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { ExplorerLink } from '../../components/common/ExplorerLink'
import * as explorer from '../../utils/explorer'

/**
 * The component's whole job is the decision it makes when there is no
 * explorer for the active network: a value the player can still read,
 * rather than a link that goes nowhere (ТЗ §12).
 */
describe('<ExplorerLink />', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('links out when the active network has an explorer', () => {
    vi.spyOn(explorer, 'getTxUrl').mockReturnValue('https://sepolia.basescan.org/tx/0xabc')

    render(<ExplorerLink kind="tx" value="0x1234567890abcdef1234567890abcdef" />)

    const link = screen.getByRole('link')
    expect(link).toHaveAttribute('href', 'https://sepolia.basescan.org/tx/0xabc')
    expect(link).toHaveAttribute('target', '_blank')
    // Opening an external page must not hand it a window reference back.
    expect(link.getAttribute('rel')).toContain('noopener')
    expect(link).toHaveTextContent('0x1234…cdef')
  })

  it('renders plain text when the network has no explorer', () => {
    vi.spyOn(explorer, 'getBlockUrl').mockReturnValue(null)

    render(<ExplorerLink kind="block" value={4321} />)

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('4321')).toBeInTheDocument()
  })

  it('renders a dash for a missing value rather than an empty link', () => {
    render(<ExplorerLink kind="address" value={null} />)
    expect(screen.getByText('—')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('shows a caller-supplied label instead of an abbreviated hash', () => {
    vi.spyOn(explorer, 'getAddressUrl').mockReturnValue('https://example.org/address/0xabc')

    render(
      <ExplorerLink kind="address" value="0xabc">
        Contract
      </ExplorerLink>,
    )
    expect(screen.getByRole('link')).toHaveTextContent('Contract')
  })
})
