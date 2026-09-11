import { describe, expect, it } from 'vitest'
import { PlayerLedger, RECENT_ROUNDS, type IndexedEvent } from '../../../../api/indexer/ledger'

/**
 * The rules that turn a log into a record, tested without a chain.
 *
 * The fold is deliberately free of Nest and of viem for exactly this: every
 * decision it makes — who is seated, what counts as a round, when a streak
 * breaks — is a rule about the game, and a rule about the game should be
 * checkable by writing down the events that led to it.
 */

const ALICE = '0xAAaaAAaAAaAaAaaAaAAAAAAAaaaAaAaAaAAaaAA1' as const
const BOB = '0xBbBBbbBBBbbBBBbbbbBbBbbBbBBbbBBbBbBbBBb2' as const
const LOBBY = '0xlobby-one'
const OTHER = '0xlobby-two'

let block = 100

function event(name: string, args: Record<string, unknown>): IndexedEvent {
  return { name, blockNumber: block++, args }
}

function playedRound(
  ledger: PlayerLedger,
  lobbyId: string,
  seats: readonly `0x${string}`[],
  winners: readonly `0x${string}`[],
) {
  for (const player of seats) {
    ledger.apply(event('PlayerJoined', { lobbyId, player, paid: 1_000n, participantCount: seats.length }))
  }
  ledger.apply(event('DefenseSubmitted', { lobbyId, player: seats[0], attemptIndex: 0 }))
  ledger.apply(
    event('WinnerDetermined', { lobbyId, attackId: '0xattack', intercepted: winners.length > 0, winners }),
  )
}

describe('a wallet that has done nothing', () => {
  it('is an empty record rather than an absent one', () => {
    const record = new PlayerLedger().record(ALICE)
    expect(record.roundsPlayed).toBe(0)
    expect(record.stakedWei).toBe('0')
    // How a caller tells "never played" from "played and scored zero".
    expect(record.firstBlock).toBeNull()
  })
})

describe('money and counts', () => {
  it('adds entries and probes into what the protocol received', () => {
    const ledger = new PlayerLedger()
    ledger.apply(event('PlayerJoined', { lobbyId: LOBBY, player: ALICE, paid: 5_000n }))
    ledger.apply(event('ProbesPurchased', { lobbyId: LOBBY, player: ALICE, count: 3, paid: 600n }))
    ledger.apply(event('ProbeSent', { lobbyId: LOBBY, player: ALICE, attackId: '0xattack', probeIndex: 0 }))
    ledger.apply(event('RewardClaimed', { lobbyId: LOBBY, player: ALICE, amount: 9_000n }))
    ledger.apply(event('RefundClaimed', { lobbyId: OTHER, player: ALICE, amount: 250n }))

    const record = ledger.record(ALICE)
    expect(record.stakedWei).toBe('5600')
    expect(record.wonWei).toBe('9000')
    expect(record.returnedWei).toBe('250')
    expect(record.probesBought).toBe(3)
    expect(record.probesSent).toBe(1)
    expect(record.operationsJoined).toBe(1)
  })

  it('reads a record whatever case the address is written in', () => {
    const ledger = new PlayerLedger()
    ledger.apply(event('PlayerJoined', { lobbyId: LOBBY, player: ALICE.toLowerCase(), paid: 1n }))
    expect(ledger.record(ALICE).operationsJoined).toBe(1)
    expect(ledger.record(ALICE.toUpperCase()).operationsJoined).toBe(1)
  })
})

describe('who is scored by a result', () => {
  it('counts a seat as a round played, and a named winner as an interception', () => {
    const ledger = new PlayerLedger()
    playedRound(ledger, LOBBY, [ALICE, BOB], [ALICE])

    expect(ledger.record(ALICE).roundsPlayed).toBe(1)
    expect(ledger.record(ALICE).interceptions).toBe(1)
    // Bob was in the room. Sitting out a contest somebody else played is how
    // you lose one.
    expect(ledger.record(BOB).roundsPlayed).toBe(1)
    expect(ledger.record(BOB).interceptions).toBe(0)
  })

  it('does not score a wallet that left before the result', () => {
    const ledger = new PlayerLedger()
    ledger.apply(event('PlayerJoined', { lobbyId: LOBBY, player: ALICE, paid: 1_000n }))
    ledger.apply(event('PlayerLeft', { lobbyId: LOBBY, player: ALICE, refunded: 1_000n }))
    ledger.apply(event('WinnerDetermined', { lobbyId: LOBBY, attackId: '0xattack', intercepted: false, winners: [] }))

    const record = ledger.record(ALICE)
    expect(record.roundsPlayed).toBe(0)
    expect(record.operationsLeft).toBe(1)
    expect(record.returnedWei).toBe('1000')
  })

  /*
   * ТЗ §18 — an operation nobody ever acted in ends UNPLAYED, everyone is
   * refunded, and the protocol says so by cancelling it in the same
   * transaction as the result. Scoring that as a defeat would break a streak
   * on a game that never started.
   */
  it('does not score a round nobody played', () => {
    const ledger = new PlayerLedger()
    ledger.apply(event('PlayerJoined', { lobbyId: LOBBY, player: ALICE, paid: 1_000n }))
    ledger.apply(event('LobbyCancelled', { lobbyId: LOBBY, reason: 'no defender ever acted' }))
    ledger.apply(event('WinnerDetermined', { lobbyId: LOBBY, attackId: '0xattack', intercepted: false, winners: [] }))

    expect(ledger.record(ALICE).roundsPlayed).toBe(0)
  })

  it('scores each operation once, and keeps them apart', () => {
    const ledger = new PlayerLedger()
    playedRound(ledger, LOBBY, [ALICE], [ALICE])
    playedRound(ledger, OTHER, [ALICE], [])

    const record = ledger.record(ALICE)
    expect(record.roundsPlayed).toBe(2)
    expect(record.interceptions).toBe(1)
  })
})

describe('the streak', () => {
  it('runs while the interceptions do, and remembers its best', () => {
    const ledger = new PlayerLedger()
    playedRound(ledger, 'a', [ALICE], [ALICE])
    playedRound(ledger, 'b', [ALICE], [ALICE])
    playedRound(ledger, 'c', [ALICE], [])

    const record = ledger.record(ALICE)
    expect(record.currentStreak).toBe(0)
    expect(record.bestStreak).toBe(2)
    expect(record.interceptions).toBe(2)
  })

  it('starts again after a miss', () => {
    const ledger = new PlayerLedger()
    playedRound(ledger, 'a', [ALICE], [ALICE])
    playedRound(ledger, 'b', [ALICE], [])
    playedRound(ledger, 'c', [ALICE], [ALICE])

    const record = ledger.record(ALICE)
    expect(record.currentStreak).toBe(1)
    expect(record.bestStreak).toBe(1)
  })

  it('is not broken by a round that was never played', () => {
    const ledger = new PlayerLedger()
    playedRound(ledger, 'a', [ALICE], [ALICE])
    ledger.apply(event('PlayerJoined', { lobbyId: 'b', player: ALICE, paid: 1_000n }))
    ledger.apply(event('LobbyCancelled', { lobbyId: 'b', reason: 'no defender ever acted' }))
    ledger.apply(event('WinnerDetermined', { lobbyId: 'b', attackId: '0xattack', intercepted: false, winners: [] }))

    expect(ledger.record(ALICE).currentStreak).toBe(1)
  })
})

describe('the recent form', () => {
  it('records each scored round in the order it resolved', () => {
    const ledger = new PlayerLedger()
    playedRound(ledger, 'a', [ALICE], [ALICE])
    playedRound(ledger, 'b', [ALICE], [])
    playedRound(ledger, 'c', [ALICE], [ALICE])

    expect(ledger.record(ALICE).recentRounds).toEqual([true, false, true])
  })

  it('leaves no mark for a round nobody played', () => {
    const ledger = new PlayerLedger()
    ledger.apply(event('PlayerJoined', { lobbyId: LOBBY, player: ALICE, paid: 1n }))
    ledger.apply(event('LobbyCancelled', { lobbyId: LOBBY, reason: 'no defender ever acted' }))
    ledger.apply(event('WinnerDetermined', { lobbyId: LOBBY, attackId: '0xattack', intercepted: false, winners: [] }))

    // A false mark would read as a miss, which is the one thing that round
    // was not.
    expect(ledger.record(ALICE).recentRounds).toEqual([])
  })

  /*
   * Bounded on purpose: a record that grows with every round played is a
   * memory leak with a display in front of it, and recent form is all a
   * panel can show anyway.
   */
  it('keeps only the most recent rounds, dropping the oldest', () => {
    const ledger = new PlayerLedger()
    for (let round = 0; round < RECENT_ROUNDS + 3; round += 1) {
      playedRound(ledger, `lobby-${round}`, [ALICE], round === 0 ? [ALICE] : [])
    }

    const form = ledger.record(ALICE).recentRounds
    expect(form).toHaveLength(RECENT_ROUNDS)
    // The one interception was the first round, and it has aged out.
    expect(form.some((won) => won)).toBe(false)
  })

  it('hands out a copy rather than the array it keeps mutating', () => {
    const ledger = new PlayerLedger()
    playedRound(ledger, 'a', [ALICE], [ALICE])
    const form = ledger.record(ALICE).recentRounds
    playedRound(ledger, 'b', [ALICE], [])

    expect(form).toEqual([true])
  })
})

describe('the author of an operation', () => {
  it('is credited for creating and settling, separately from winning', () => {
    const ledger = new PlayerLedger()
    ledger.apply(event('LobbyCreated', { lobbyId: LOBBY, creator: ALICE, entryPrice: 10n }))
    ledger.apply(event('CreatorSettled', { lobbyId: LOBBY, creator: ALICE, amount: 400n }))

    const record = ledger.record(ALICE)
    expect(record.operationsCreated).toBe(1)
    expect(record.creatorFeesWei).toBe('400')
    // A commission is not an interception, and the panel must never print it
    // as one.
    expect(record.wonWei).toBe('0')
  })
})

describe('when a wallet was first and last seen', () => {
  it('keeps the first block it acted in, and the latest', () => {
    const ledger = new PlayerLedger()
    ledger.apply({ name: 'PlayerJoined', blockNumber: 10, args: { lobbyId: LOBBY, player: ALICE, paid: 1n } })
    ledger.apply({ name: 'ProbeSent', blockNumber: 42, args: { lobbyId: LOBBY, player: ALICE, probeIndex: 0 } })

    const record = ledger.record(ALICE)
    expect(record.firstBlock).toBe(10)
    expect(record.lastBlock).toBe(42)
  })
})
