import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { wallet, client } = vi.hoisted(() => ({
  wallet: {
    address: null as `0x${string}` | null,
    isConnected: false,
    connect: vi.fn(),
    status: 'unauthenticated' as const,
  },
  client: {
    mode: 'contract' as const,
    listDirectoryPage: undefined as
      | ((
          offset: number,
          limit: number,
        ) => Promise<{
          lobbies: Array<{
            id: `0x${string}`
            creator: string
            createdAtBlock: number
            status: string
            ending: string
            participantCount: number
            participantAddresses: string[]
            outcome: null
            config: {
              name: string
              participation: { minPlayers: number; maxPlayers: number; entryPrice: number; deadline: number }
              economics: { prizePool: number }
            }
          }>
          total: number
        }>)
      | undefined,
  },
}))

// The suite runs in emulator mode by default (`vite.config.ts`), where the
// directory has nothing to read. These tests are about the contract build.
vi.mock('../../config/env', () => ({
  // `deployment` is read on the chain-fallback path: a row's pool asks
  // whether its creator is the game contract, because a Global Defense
  // draw's bounty is not in the lobby (see `drawPrizePool`).
  appConfig: { blockchainMode: 'contract', apiBaseUrl: '', deployment: { address: null } },
}))

vi.mock('../../hooks/useBlockchainClient', () => ({
  useBlockchainClient: () => client,
}))

vi.mock('../../hooks/useWallet', () => ({
  useWallet: () => wallet,
}))

const { OperationDirectory } = await import('../../components/lobby/OperationDirectory')

const OPEN = {
  id: '0xaaaa000000000000000000000000000000000000000000000000000000000001' as `0x${string}`,
  name: 'Sunrise Watch',
  creator: '0x1111111111111111111111111111111111111111',
  entryPriceWei: '500000000000000',
  startPrizePoolWei: '1000000000000000',
  registrationDeadline: Math.floor(Date.now() / 1000) + 3600,
  participants: 3,
  maxPlayers: 20,
  minPlayers: 2,
  rewardPoolWei: '1500000000000000',
  status: 'open' as const,
  intercepted: null,
  endedReason: null,
  createdBlock: 10,
  startedBlock: null,
  endedBlock: null,
}

function answer(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) })
}

function show() {
  return render(
    <MemoryRouter>
      <OperationDirectory />
    </MemoryRouter>,
  )
}

/**
 * The screen that makes an operation findable at all. Before it, the only
 * ways in were opening one yourself or being handed a link — so what these
 * check is reachability: is there a room on screen, does it say what joining
 * costs, and does following it go to the operation.
 */
describe('<OperationDirectory />', () => {
  beforeEach(() => {
    wallet.address = null
    wallet.isConnected = false
    wallet.connect.mockReset()
    client.listDirectoryPage = undefined
    vi.stubGlobal('fetch', answer({ ok: true, lobbies: [OPEN], total: 1, syncing: false }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('lists an operation with what it is worth, what it costs, who is in it, and a link into it', async () => {
    show()

    expect(await screen.findByText('Sunrise Watch')).toBeInTheDocument()
    // The pool is what somebody is choosing between; the entry qualifies it.
    expect(screen.getByText('0.0015 ETH')).toBeInTheDocument()
    expect(screen.getByText('0.0005 ETH')).toBeInTheDocument()
    expect(screen.getByText('3 / 20')).toBeInTheDocument()
    expect(screen.getByText('Join')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /sunrise watch/i })).toHaveAttribute('href', `/lobby/${OPEN.id}`)
  })

  it('opens on every operation, not only the ones still taking applications', async () => {
    show()
    await screen.findByText('Sunrise Watch')
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/lobbies?limit=20&offset=0')
    const filters = screen.getByRole('tablist', { name: /filter operations/i })
    expect(within(filters).getByRole('tab', { name: /any/i })).toHaveAttribute('aria-selected', 'true')
  })

  /*
   * An operation below its floor cannot start at all, and "needs one more" is
   * a better reason to join than a fraction somebody has to do arithmetic on.
   */
  it('says what an operation is still short of, rather than only how full it is', async () => {
    vi.stubGlobal(
      'fetch',
      answer({ ok: true, total: 1, syncing: false, lobbies: [{ ...OPEN, participants: 1, minPlayers: 3 }] }),
    )
    show()
    expect(await screen.findByText('1 of 3 needed to start')).toBeInTheDocument()
  })

  it('marks a room that cannot take anybody else', async () => {
    vi.stubGlobal(
      'fetch',
      answer({ ok: true, total: 1, syncing: false, lobbies: [{ ...OPEN, participants: 20 }] }),
    )
    show()
    expect(await screen.findByText('Full')).toBeInTheDocument()
  })

  /*
   * A finished round is not refreshed against the contract any more, so it has
   * no pool figure. The entry price is the one number the log itself can still
   * vouch for, and the row falls back to it rather than printing a zero.
   */
  it('falls back to the entry price where no pool was read', async () => {
    vi.stubGlobal(
      'fetch',
      answer({
        ok: true,
        total: 1,
        syncing: false,
        lobbies: [{ ...OPEN, status: 'finished', intercepted: false, rewardPoolWei: null, maxPlayers: null }],
      }),
    )
    show()
    await screen.findByText('Impact')
    expect(screen.getByText('Entry')).toBeInTheDocument()
    const row = screen.getByRole('link', { name: /sunrise watch/i })
    expect(row).toHaveTextContent(/players\s*3/i)
  })

  it('searches by name once the typing has settled', async () => {
    show()
    await screen.findByText('Sunrise Watch')

    await userEvent.type(screen.getByRole('searchbox', { name: /search operations/i }), 'sunrise')
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe('/api/lobbies?limit=20&offset=0&q=sunrise'),
    )
    // Debounced: seven keystrokes must not be seven requests.
    expect(vi.mocked(fetch).mock.calls.length).toBeLessThan(2 + 7)
  })

  it('asks for the next page on a press, and keeps what is already on screen', async () => {
    const page = (index: number) => ({ ...OPEN, id: `0x${index}`, name: `Op ${index}` })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              ok: true,
              total: 21,
              syncing: false,
              lobbies: url.includes('offset=0') ? [page(1)] : [page(2)],
            }),
        }),
      ),
    )
    show()
    await screen.findByText('Op 1')

    await userEvent.click(screen.getByRole('button', { name: /show 20 more/i }))
    expect(await screen.findByText('Op 2')).toBeInTheDocument()
    expect(screen.getByText('Op 1')).toBeInTheDocument()
  })

  it('says when a search matched nothing, naming what was searched for', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, total: url.includes('q=') ? 0 : 1, syncing: false, lobbies: url.includes('q=') ? [] : [OPEN] }),
        }),
      ),
    )
    show()
    await screen.findByText('Sunrise Watch')
    await userEvent.type(screen.getByRole('searchbox', { name: /search operations/i }), 'zulu')
    expect(await screen.findByText(/nothing matches/i)).toBeInTheDocument()
  })

  it('names a finished round by its ending rather than by the word finished', async () => {
    vi.stubGlobal(
      'fetch',
      answer({
        ok: true,
        total: 1,
        syncing: false,
        lobbies: [{ ...OPEN, status: 'finished', intercepted: true, endedBlock: 40 }],
      }),
    )
    show()
    expect(await screen.findByText('Intercepted')).toBeInTheDocument()
    // Two words, because the cell is one line with an ellipsis — see
    // `describeTiming`. A sentence here reached the card as "the threat …".
    expect(screen.getByText('Stopped')).toBeInTheDocument()
  })

  it('switches what it is showing when another state is picked', async () => {
    show()
    await screen.findByText('Sunrise Watch')

    await userEvent.click(screen.getByRole('tab', { name: /finished/i }))
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe('/api/lobbies?limit=20&offset=0&status=finished'),
    )
  })

  it('can list cancelled operations', async () => {
    vi.stubGlobal(
      'fetch',
      answer({
        ok: true,
        total: 1,
        syncing: false,
        lobbies: [
          {
            ...OPEN,
            status: 'cancelled',
            // The contract's own wording, verbatim — one of the three
            // strings `LobbyCancelled` and `AttackExpired` ever carry.
            endedReason: 'minimum defenders not reached',
            endedBlock: 40,
          },
        ],
      }),
    )
    show()
    await screen.findByText('Sunrise Watch')
    await userEvent.click(screen.getByRole('tab', { name: /cancelled/i }))
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.at(-1)?.[0]).toBe('/api/lobbies?limit=20&offset=0&status=cancelled'),
    )
    /*
     * The reason, at the width the card has.
     *
     * It used to be printed verbatim, and every one of the protocol's three
     * reasons is a sentence — so the cell showed "minimum def…", which tells
     * a reader only that something was cut off.
     */
    expect(await screen.findByText('Too few')).toBeInTheDocument()
  })

  /**
   * A reason nobody mapped must not become a fragment.
   *
   * The set is small and closed today, and an upgrade could add to it. The
   * honest fallback is the word the status pill already uses, not the first
   * twelve characters of a sentence.
   */
  it('falls back to the plain word for a cancellation reason it does not know', async () => {
    vi.stubGlobal(
      'fetch',
      answer({
        ok: true,
        total: 1,
        syncing: false,
        lobbies: [{ ...OPEN, status: 'cancelled', endedReason: 'something new', endedBlock: 40 }],
      }),
    )
    show()
    expect(await screen.findByText('Cancelled')).toBeInTheDocument()
    expect(screen.queryByText('something new')).not.toBeInTheDocument()
  })

  it('reorders the loaded page by prize pool without asking the index again', async () => {
    const lean = { ...OPEN, id: '0x1', name: 'Lean Watch', rewardPoolWei: '1000000000000000' }
    const rich = { ...OPEN, id: '0x2', name: 'Rich Watch', rewardPoolWei: '9000000000000000' }
    vi.stubGlobal('fetch', answer({ ok: true, total: 2, syncing: false, lobbies: [lean, rich] }))
    show()
    await screen.findByText('Lean Watch')
    const before = screen.getAllByRole('link', { name: /watch/i }).map((el) => el.textContent)
    expect(before[0]).toMatch(/Lean Watch/)

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /sort operations/i }), 'pool')
    const after = screen.getAllByRole('link', { name: /watch/i }).map((el) => el.textContent)
    expect(after[0]).toMatch(/Rich Watch/)
  })

  /*
   * An empty list and an absent directory are different facts, and the
   * difference matters: one says nobody is playing, the other says this build
   * cannot see who is.
   */
  it('says the catalog is empty rather than showing a blank page', async () => {
    vi.stubGlobal('fetch', answer({ ok: true, lobbies: [], total: 0, syncing: false }))
    show()
    expect(await screen.findByText(/nothing here yet/i)).toBeInTheDocument()
  })

  it('explains itself when the build has no directory behind it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    show()
    expect(await screen.findByText(/can't load operations right now/i)).toBeInTheDocument()
  })

  /*
   * Local contract mode often has no Nest process on :8787. The page still
   * has the chain, and a visitor should see rooms from `getLobbyIds` rather
   * than a box that says the directory does not exist.
   */
  it('lists operations from the chain when the index is down', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    client.listDirectoryPage = async () => ({
      total: 1,
      lobbies: [
        {
          id: OPEN.id,
          creator: OPEN.creator,
          createdAtBlock: OPEN.createdBlock,
          status: 'OPEN',
          ending: 'NONE',
          participantCount: OPEN.participants,
          participantAddresses: [],
          outcome: null,
          config: {
            name: OPEN.name,
            participation: {
              minPlayers: OPEN.minPlayers!,
              maxPlayers: OPEN.maxPlayers!,
              entryPrice: 0.0005,
              deadline: OPEN.registrationDeadline * 1000,
            },
            economics: { prizePool: 0.001 },
          },
        },
      ],
    })
    show()
    expect(await screen.findByText('Sunrise Watch')).toBeInTheDocument()
    expect(screen.queryByText(/can't load operations right now/i)).not.toBeInTheDocument()
  })

  it('starts on every operation, and asks for a sign-in only on Mine', async () => {
    show()
    expect(await screen.findByText('Sunrise Watch')).toBeInTheDocument()

    const whose = screen.getByRole('tablist', { name: /whose operations/i })
    expect(within(whose).getByRole('tab', { name: /^all/i })).toHaveAttribute('aria-selected', 'true')

    await userEvent.click(within(whose).getByRole('tab', { name: /^mine/i }))
    expect(await screen.findByText(/sign in to see your rounds/i)).toBeInTheDocument()
    expect(screen.queryByText('Sunrise Watch')).not.toBeInTheDocument()
  })

  it('shows how many operations sit in each status without opening the tab', async () => {
    vi.stubGlobal(
      'fetch',
      answer({
        ok: true,
        total: 1,
        syncing: false,
        counts: { open: 1, active: 2, finished: 4, cancelled: 3, all: 10 },
        lobbies: [OPEN],
      }),
    )
    show()
    await screen.findByText('Sunrise Watch')

    const filters = screen.getByRole('tablist', { name: /filter operations/i })
    expect(within(filters).getByRole('tab', { name: /open/i })).toHaveTextContent('1')
    expect(within(filters).getByRole('tab', { name: /live/i })).toHaveTextContent('2')
    expect(within(filters).getByRole('tab', { name: /finished/i })).toHaveTextContent('4')
    expect(within(filters).getByRole('tab', { name: /cancelled/i })).toHaveTextContent('3')
    expect(within(filters).getByRole('tab', { name: /any/i })).toHaveTextContent('10')

    const whose = screen.getByRole('tablist', { name: /whose operations/i })
    expect(within(whose).getByRole('tab', { name: /^all/i })).toHaveTextContent('10')
  })
})
