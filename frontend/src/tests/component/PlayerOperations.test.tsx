import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../config/env', () => ({
  appConfig: { blockchainMode: 'contract', apiBaseUrl: '' },
}))

vi.mock('../../hooks/useBlockchainClient', () => {
  const client = { mode: 'contract' }
  return { useBlockchainClient: () => client }
})

const { PlayerOperations } = await import('../../components/wallet/PlayerOperations')

const ADDRESS = '0x1111111111111111111111111111111111111111' as const

function lobby(overrides: Record<string, unknown> = {}) {
  return {
    id: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
    name: 'Sunrise Watch',
    creator: ADDRESS,
    entryPriceWei: '500000000000000',
    startPrizePoolWei: '0',
    registrationDeadline: 1_800_000_000,
    participants: 2,
    maxPlayers: 20,
    minPlayers: 2,
    rewardPoolWei: '1000000000000000',
    status: 'open',
    intercepted: null,
    endedReason: null,
    createdBlock: 1,
    startedBlock: null,
    endedBlock: null,
    joined: true,
    created: false,
    ...overrides,
  }
}

function answer(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) })
}

function show() {
  return render(
    <MemoryRouter>
      <PlayerOperations address={ADDRESS} onNavigate={vi.fn()} />
    </MemoryRouter>,
  )
}

/**
 * A shortcut back into whatever this wallet is still in — and, more
 * importantly, a block that refuses to become a list. A header dropdown that
 * grew with every round played would push the deposit address off the bottom
 * of the panel whose job is to show it.
 */
describe('<PlayerOperations />', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('links to the operations still going', async () => {
    vi.stubGlobal('fetch', answer({ ok: true, live: [lobby()], past: [] }))
    show()

    const link = await screen.findByRole('link', { name: /sunrise watch/i })
    expect(link).toHaveAttribute('href', `/lobby/${lobby().id}`)
    expect(screen.getByText('waiting to start')).toBeInTheDocument()
  })

  it('caps the list and turns the rest into a count', async () => {
    const live = [1, 2, 3, 4, 5].map((n) => lobby({ id: `0x${n}`, name: `Op ${n}` }))
    vi.stubGlobal('fetch', answer({ ok: true, live, past: [lobby({ status: 'finished' })] }))
    show()

    await screen.findByText('Op 1')
    expect(screen.getByText('Op 3')).toBeInTheDocument()
    expect(screen.queryByText('Op 4')).not.toBeInTheDocument()
    expect(screen.getByText('2 more live')).toBeInTheDocument()
    // History is a count with a link, never entries in a dropdown.
    expect(screen.getByText('1 finished')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /browse all/i })).toHaveAttribute('href', '/operations')
  })

  it('says an operation is this wallet’s own when it never took a seat in it', async () => {
    vi.stubGlobal('fetch', answer({ ok: true, live: [lobby({ joined: false, created: true })], past: [] }))
    show()
    expect(await screen.findByText('yours · open')).toBeInTheDocument()
  })

  it('renders nothing for a wallet with no operations at all', async () => {
    vi.stubGlobal('fetch', answer({ ok: true, live: [], past: [] }))
    const { container } = show()
    // Not an empty heading over an empty list: there is nothing to say yet.
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the build has no directory behind it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const { container } = show()
    expect(container).toBeEmptyDOMElement()
  })
})
