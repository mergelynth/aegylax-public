import { describe, expect, it } from 'vitest'
import { LobbyDirectory } from '../../../../api/indexer/lobbies'

/**
 * The directory's rules, written as the events that produce them.
 *
 * Everything here is a statement about what the *log* says, not about what a
 * lobby read would return: the fold's whole job is to be a faithful replay,
 * and the moment it starts inferring state the contract owns, a visitor is
 * being shown a guess about somebody's money.
 */

let block = 500

function event(name: string, args: Record<string, unknown>) {
  return { name, blockNumber: block++, args }
}

const ALICE = '0xAAaaAAaAAaAaAaaAaAAAAAAAaaaAaAaAaAAaaAA1'
const BOB = '0xBbBBbbBBBbbBBBbbbbBbBbbBbBBbbBBbBbBbBBb2'

function created(directory: LobbyDirectory, lobbyId: string, overrides: Record<string, unknown> = {}) {
  directory.apply(
    event('LobbyCreated', {
      lobbyId,
      creator: ALICE,
      entryPrice: 500_000_000_000_000n,
      startPrizePool: 1_000_000_000_000_000n,
      registrationDeadline: 1_800_000_000n,
      name: 'Sunrise Watch',
      ...overrides,
    }),
  )
}

describe('an operation as the log describes it', () => {
  it('carries what LobbyCreated said, and nothing invented', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xaaa')

    const [lobby] = directory.list().lobbies
    expect(lobby.name).toBe('Sunrise Watch')
    expect(lobby.entryPriceWei).toBe('500000000000000')
    expect(lobby.registrationDeadline).toBe(1_800_000_000)
    expect(lobby.status).toBe('open')
    expect(lobby.participants).toBe(0)
    // Not knowable from an event, and never guessed at.
    expect(lobby.intercepted).toBeNull()
  })

  /*
   * The count comes off the event rather than the size of the member set, so
   * it stays right even where this process began reading the log after joins
   * it therefore never saw.
   */
  it('counts seats as the contract counted them', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xaaa')
    directory.apply(event('PlayerJoined', { lobbyId: '0xaaa', player: BOB, paid: 1n, participantCount: 7 }))

    expect(directory.list().lobbies[0].participants).toBe(7)
  })

  it('follows an operation from open to in flight to a result', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xaaa')
    directory.apply(event('OperationStarted', { lobbyId: '0xaaa', epochId: 3 }))
    expect(directory.list().lobbies[0].status).toBe('active')

    directory.apply(event('WinnerDetermined', { lobbyId: '0xaaa', intercepted: true, winners: [BOB] }))
    const [lobby] = directory.list().lobbies
    expect(lobby.status).toBe('finished')
    expect(lobby.intercepted).toBe(true)
  })

  /*
   * ТЗ §18 — an operation nobody acted in is cancelled in the same
   * transaction as its result, and the cancellation arrives first. Calling it
   * "finished" would promise a result nobody played for.
   */
  it('stays cancelled when nobody ever acted', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xaaa')
    directory.apply(event('LobbyCancelled', { lobbyId: '0xaaa', reason: 'no defender ever acted' }))
    directory.apply(event('WinnerDetermined', { lobbyId: '0xaaa', intercepted: false, winners: [] }))

    const [lobby] = directory.list().lobbies
    expect(lobby.status).toBe('cancelled')
    expect(lobby.endedReason).toBe('no defender ever acted')
  })

  it('ends an unrevealed round as cancelled, with the reason the contract gave', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xaaa')
    directory.apply(event('OperationStarted', { lobbyId: '0xaaa', epochId: 3 }))
    directory.apply(event('AttackExpired', { lobbyId: '0xaaa', reason: 'no reveal within grace period' }))

    expect(directory.list().lobbies[0].status).toBe('cancelled')
  })
})

describe('the list a visitor picks from', () => {
  it('is newest first, so what can be joined now is at the top', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xolder', { name: 'Older' })
    created(directory, '0xnewer', { name: 'Newer' })

    expect(directory.list().lobbies.map((lobby) => lobby.name)).toEqual(['Newer', 'Older'])
  })

  it('narrows to one status, and reports how many there are of it', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xopen')
    created(directory, '0xflying')
    directory.apply(event('OperationStarted', { lobbyId: '0xflying', epochId: 1 }))

    expect(directory.list({ status: 'open' }).total).toBe(1)
    expect(directory.list({ status: 'active' }).lobbies[0].id).toBe('0xflying')
    expect(directory.list().total).toBe(2)
    expect(directory.list({ status: 'open' }).counts).toEqual({
      open: 1,
      active: 1,
      finished: 0,
      cancelled: 0,
      all: 2,
    })
  })

  it('pages rather than handing back everything ever opened', () => {
    const directory = new LobbyDirectory()
    for (let index = 0; index < 5; index += 1) created(directory, `0x${index}`, { name: `Op ${index}` })

    const page = directory.list({ limit: 2, offset: 1 })
    expect(page.lobbies).toHaveLength(2)
    expect(page.total).toBe(5)
  })
})

describe('the two facts no event carries', () => {
  /*
   * Capacity is lobby config and the pool is money the contract moves by its
   * own rules. Neither can be folded out of events, so both are handed in —
   * and until they are, a row says what it knows and stops rather than
   * inventing a ceiling or a prize.
   */
  it('is null until somebody reads the contract for it', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xaaa')

    const [lobby] = directory.list().lobbies
    expect(lobby.maxPlayers).toBeNull()
    expect(lobby.rewardPoolWei).toBeNull()
  })

  it('takes what the contract said, and keeps it', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xaaa')
    directory.enrich('0xaaa', { maxPlayers: 20, minPlayers: 2, rewardPoolWei: 1_500_000_000_000_000n })

    const [lobby] = directory.list().lobbies
    expect(lobby.maxPlayers).toBe(20)
    expect(lobby.minPlayers).toBe(2)
    expect(lobby.rewardPoolWei).toBe('1500000000000000')
  })

  /*
   * The one figure the contract cannot be asked for while it matters.
   *
   * A Global Defense draw's bounty stays in `globalDefensePool` until the
   * round activates, so `getLobby` answers 0 for the whole application
   * window and answers 0 forever on a room that never filled. The event is
   * the contract stating the figure itself, which is what makes it usable
   * here when `rewardPool` is not.
   */
  it("folds a draw's jackpot into the pool it is playing for", () => {
    const directory = new LobbyDirectory()
    created(directory, '0xdraw', { startPrizePool: 0n, entryPrice: 0n })
    directory.apply(event('GlobalDefenseOpened', { epochId: 1000, lobbyId: '0xdraw', pool: 28_800_000_000_000_000n }))
    directory.enrich('0xdraw', { rewardPoolWei: 0n })

    const [lobby] = directory.list().lobbies
    expect(lobby.drawBountyWei).toBe('28800000000000000')
    expect(lobby.rewardPoolWei).toBe('28800000000000000')
  })

  it('keeps saying what an unfilled draw was playing for after it is cancelled', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xdraw', { startPrizePool: 0n, entryPrice: 0n })
    directory.apply(event('GlobalDefenseOpened', { epochId: 1000, lobbyId: '0xdraw', pool: 28_800_000_000_000_000n }))
    // Probe money that stayed in the room, and no bounty: the draw never
    // started, so `commitDrawBounty` never ran.
    directory.enrich('0xdraw', { rewardPoolWei: 600_000_000_000_000n })
    directory.apply(event('LobbyCancelled', { lobbyId: '0xdraw', reason: 'minimum defenders not reached' }))

    const [lobby] = directory.list().lobbies
    expect(lobby.status).toBe('cancelled')
    expect(lobby.rewardPoolWei).toBe('29400000000000000')
  })

  it('does not count an escrowed jackpot twice once the draw has started', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xdraw', { startPrizePool: 0n, entryPrice: 0n })
    directory.apply(event('GlobalDefenseOpened', { epochId: 1000, lobbyId: '0xdraw', pool: 28_800_000_000_000_000n }))
    // `activate` escrows the pile and emits this in the same call.
    directory.apply(event('OperationStarted', { lobbyId: '0xdraw', epochId: 1000 }))
    directory.enrich('0xdraw', { rewardPoolWei: 28_800_000_000_000_000n })

    const [lobby] = directory.list().lobbies
    expect(lobby.rewardPoolWei).toBe('28800000000000000')
  })

  it('leaves a player operation alone', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xaaa')
    directory.enrich('0xaaa', { rewardPoolWei: 1_500_000_000_000_000n, drawBountyWei: 28_800_000_000_000_000n })

    const [lobby] = directory.list().lobbies
    expect(lobby.drawBountyWei).toBeNull()
    expect(lobby.rewardPoolWei).toBe('1500000000000000')
  })

  it('offers the operations worth a read: the ones somebody can still act on', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xopen')
    created(directory, '0xflying')
    directory.apply(event('OperationStarted', { lobbyId: '0xflying', epochId: 1 }))
    created(directory, '0xdone')
    directory.apply(event('WinnerDetermined', { lobbyId: '0xdone', intercepted: false, winners: [] }))

    expect(directory.liveIds().sort()).toEqual(['0xflying', '0xopen'])
  })
})

describe('searching for an operation', () => {
  it('matches part of a name, whatever the case', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xaaa', { name: 'Sunrise Watch' })
    created(directory, '0xbbb', { name: 'Night Shift' })

    expect(directory.list({ query: 'sunrise' }).total).toBe(1)
    expect(directory.list({ query: 'SHIFT' }).lobbies[0].name).toBe('Night Shift')
  })

  /* The other way somebody arrives here: holding an id out of a transaction. */
  it('matches an id', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xdeadbeef')
    expect(directory.list({ query: '0xdead' }).total).toBe(1)
  })

  it('narrows by status and search together', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xaaa', { name: 'Watch' })
    created(directory, '0xbbb', { name: 'Watch' })
    directory.apply(event('OperationStarted', { lobbyId: '0xbbb', epochId: 1 }))

    expect(directory.list({ query: 'watch', status: 'open' }).total).toBe(1)
  })
})

describe("one wallet's operations", () => {
  it('separates what is still going from what is behind them', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xlive', { creator: BOB })
    directory.apply(event('PlayerJoined', { lobbyId: '0xlive', player: ALICE, paid: 1n, participantCount: 1 }))
    created(directory, '0xdone', { creator: BOB })
    directory.apply(event('PlayerJoined', { lobbyId: '0xdone', player: ALICE, paid: 1n, participantCount: 1 }))
    directory.apply(event('WinnerDetermined', { lobbyId: '0xdone', intercepted: false, winners: [] }))

    const mine = directory.forPlayer(ALICE)
    expect(mine.live.map((lobby) => lobby.id)).toEqual(['0xlive'])
    expect(mine.past.map((lobby) => lobby.id)).toEqual(['0xdone'])
    expect(mine.live[0].joined).toBe(true)
    expect(mine.live[0].created).toBe(false)
  })

  /*
   * An author need not take a seat — `createLobby` does not join — and an
   * operation nobody else finishes is exactly the one its author has to come
   * back to.
   */
  it('includes an operation this wallet opened but never sat in', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xmine')

    const mine = directory.forPlayer(ALICE)
    expect(mine.live).toHaveLength(1)
    expect(mine.live[0].created).toBe(true)
    expect(mine.live[0].joined).toBe(false)
  })

  it('still remembers an operation whose seat was given up', () => {
    const directory = new LobbyDirectory()
    created(directory, '0xleft', { creator: BOB })
    directory.apply(event('PlayerJoined', { lobbyId: '0xleft', player: ALICE, paid: 1n, participantCount: 1 }))
    directory.apply(event('PlayerLeft', { lobbyId: '0xleft', player: ALICE, refunded: 1n, participantCount: 0 }))

    const mine = directory.forPlayer(ALICE)
    // Findable, because leaving is something this wallet did and somebody
    // looking for that operation is looking for it by name.
    expect(mine.live).toHaveLength(1)
    expect(mine.live[0].joined).toBe(false)
    expect(directory.list().lobbies[0].participants).toBe(0)
  })

  it('answers nothing for a wallet that has never been in one', () => {
    expect(new LobbyDirectory().forPlayer(BOB)).toEqual({ live: [], past: [] })
  })
})
