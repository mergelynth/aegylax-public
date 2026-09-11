import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
 * The suite runs in emulator mode by default (see `vite.config.ts`), where
 * this section is about the contract build's fetch path, so they say so.
 */
vi.mock('../../config/env', () => ({
  appConfig: { blockchainMode: 'contract', apiBaseUrl: '' },
}))

vi.mock('../../hooks/useBlockchainClient', () => {
  const client = { mode: 'contract' }
  return { useBlockchainClient: () => client }
})

const { PlayerRecordPanel } = await import('../../components/wallet/PlayerRecordPanel')

const ADDRESS = '0x1111111111111111111111111111111111111111' as const

const EMPTY = {
  address: ADDRESS,
  operationsCreated: 0,
  operationsJoined: 0,
  operationsLeft: 0,
  roundsPlayed: 0,
  interceptions: 0,
  currentStreak: 0,
  bestStreak: 0,
  probesBought: 0,
  probesSent: 0,
  defensesSubmitted: 0,
  recentRounds: [] as boolean[],
  stakedWei: '0',
  wonWei: '0',
  creatorFeesWei: '0',
  returnedWei: '0',
  firstBlock: null as number | null,
  lastBlock: null as number | null,
}

function answer(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) })
}

describe('<PlayerRecordPanel /> showing the player to themselves', () => {
  const PLAYED = {
    ...EMPTY,
    roundsPlayed: 4,
    interceptions: 3,
    currentStreak: 2,
    bestStreak: 3,
    probesSent: 11,
    defensesSubmitted: 4,
    recentRounds: [true, false, true, true],
    stakedWei: '43000000000000000',
    wonWei: '120000000000000000',
    firstBlock: 10,
    lastBlock: 900,
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', answer({ ok: true, syncing: false, record: EMPTY }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('prints the record this wallet earned', async () => {
    vi.stubGlobal('fetch', answer({ ok: true, syncing: false, record: PLAYED }))
    render(<PlayerRecordPanel address={ADDRESS} />)

    expect(await screen.findByText('Played')).toBeInTheDocument()
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(screen.getByText('Won')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('0.12 ETH')).toBeInTheDocument()
    expect(screen.getByText('0 ETH')).toBeInTheDocument()
  })

  /*
   * The strip is the streak made visible, and it is the one graphic here that
   * carries a fact rather than an ornament — so it says out loud what it
   * draws, in order, for anybody who cannot see it.
   */
  it('draws the recent rounds, and names them for a screen reader', async () => {
    vi.stubGlobal('fetch', answer({ ok: true, syncing: false, record: PLAYED }))
    render(<PlayerRecordPanel address={ADDRESS} />)
    await screen.findByText('Played')
    expect(
      screen.getByRole('img', { name: 'Last 4 rounds: won, lost, won, won' }),
    ).toBeInTheDocument()
  })

  it('draws no strip for a wallet with no rounds behind it', async () => {
    vi.stubGlobal(
      'fetch',
      answer({ ok: true, syncing: false, record: { ...EMPTY, operationsJoined: 1, firstBlock: 4, lastBlock: 4 } }),
    )
    render(<PlayerRecordPanel address={ADDRESS} />)
    await screen.findByText('Played')
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('prints money lost when the wallet staked more than it took back', async () => {
    vi.stubGlobal(
      'fetch',
      answer({
        ok: true,
        syncing: false,
        record: { ...PLAYED, interceptions: 0, wonWei: '0', recentRounds: [false, false, false, false] },
      }),
    )
    render(<PlayerRecordPanel address={ADDRESS} />)
    expect(await screen.findByText('Lost')).toBeInTheDocument()
    expect(screen.getByText('0.043 ETH')).toBeInTheDocument()
    expect(screen.getByText('0 ETH')).toBeInTheDocument()
  })

  it('says a wallet has no history rather than printing zeroes at it', async () => {
    render(<PlayerRecordPanel address={ADDRESS} />)
    expect(await screen.findByText(/nothing yet/i)).toBeInTheDocument()
    // A newcomer's first fact about themselves must not be "0%".
    expect(screen.queryByText('0%')).not.toBeInTheDocument()
  })

  it('says the chain is still being read rather than claiming an empty record', async () => {
    vi.stubGlobal('fetch', answer({ ok: true, syncing: true, record: EMPTY }))
    render(<PlayerRecordPanel address={ADDRESS} />)
    expect(await screen.findByText(/still reading the chain/i)).toBeInTheDocument()
  })

  /*
   * A build served without the backend behind it. The section is absent, not
   * broken: nothing on a wallet panel should explain an infrastructure gap to
   * somebody who only wanted their address.
   */
  it('renders nothing at all when no backend answers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const { container } = render(<PlayerRecordPanel address={ADDRESS} />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })

  it('renders nothing when the deployment keeps no records', async () => {
    vi.stubGlobal('fetch', answer({ ok: false, error: 'This deployment does not keep player records.' }, false))
    const { container } = render(<PlayerRecordPanel address={ADDRESS} />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
  })
})
