/**
 * A wallet's record, folded out of the protocol's own event log.
 *
 * Nothing here is computed, decided or remembered anywhere else: the
 * contract emits money and timing in public (ТЗ §11), and this reduces that
 * stream to what one address did. It holds no key, sends nothing, and can be
 * rebuilt from an empty map by replaying the same logs in the same order —
 * which is exactly what happens on every restart, because there is no
 * database behind it.
 *
 * It is deliberately free of Nest and of viem: it takes decoded events and
 * returns numbers, so the rules below are testable without a chain and
 * without a container. `IndexerService` owns everything this does not — the
 * RPC, the window, the cursor, the retry.
 *
 * What it may *not* learn is as fixed as what it may. No event on the
 * protocol's list carries a coordinate before `AttackRevealed`, so no shape
 * of aggregation here can leak where a defense went or what a probe saw; a
 * record is counts and money, and reconnaissance stays with whoever paid for
 * it.
 */

export interface PlayerRecord {
  address: `0x${string}`
  /** Operations this wallet opened. */
  operationsCreated: number
  /** Seats taken, whether or not the round went on to be played. */
  operationsJoined: number
  /** Seats given up before the operation started. */
  operationsLeft: number
  /**
   * Resolved rounds this wallet was still seated in — the denominator for
   * everything below it. An operation nobody ever acted in is not one of
   * them; see `applyWinnerDetermined`.
   */
  roundsPlayed: number
  /** Rounds among those where the protocol named this wallet a winner. */
  interceptions: number
  /** Interceptions in a row, counting back from the most recent resolved round. */
  currentStreak: number
  /** The longest such run this wallet has ever had. */
  bestStreak: number
  probesBought: number
  probesSent: number
  defensesSubmitted: number
  /**
   * Wei this wallet handed the protocol: entry fees and probes.
   *
   * Not "spent". Gas is invisible from a log — it is charged by the chain,
   * not by the contract, and no event carries it — so this is what the
   * protocol received, and a panel that called it spending would be
   * understating it by an amount it cannot measure.
   */
  stakedWei: string
  /** Wei claimed out of a pool this wallet won. */
  wonWei: string
  /** Wei taken as the author of an operation. */
  creatorFeesWei: string
  /** Wei that came back: refunds, and what leaving a seat returned. */
  returnedWei: string
  /**
   * How the last few rounds went, oldest first: true where this wallet was
   * named a winner.
   *
   * The counts above say how often; this says *when*, which is the only way
   * a streak can be looked at rather than read as a number. Bounded, because
   * a record that grows without limit is a memory leak with a display in
   * front of it — and a wallet's recent form is what a panel can show
   * anyway.
   */
  recentRounds: boolean[]
  /** The blocks this wallet's first and last recorded action landed in. */
  firstBlock: number | null
  lastBlock: number | null
}

/** How many rounds of form a record carries. Twelve fits one row at panel width. */
export const RECENT_ROUNDS = 12

/** One decoded log, in the only shape the fold below cares about. */
export interface IndexedEvent {
  name: string
  blockNumber: number
  args: Record<string, unknown>
}

interface MutableRecord {
  address: `0x${string}`
  operationsCreated: number
  operationsJoined: number
  operationsLeft: number
  roundsPlayed: number
  interceptions: number
  currentStreak: number
  bestStreak: number
  probesBought: number
  probesSent: number
  defensesSubmitted: number
  stakedWei: bigint
  wonWei: bigint
  creatorFeesWei: bigint
  returnedWei: bigint
  recentRounds: boolean[]
  firstBlock: number | null
  lastBlock: number | null
}

/**
 * Lower case everywhere inside, checksummed nowhere: this is a map key.
 *
 * The whole string is matched case-insensitively, prefix included. An
 * address arrives here from two directions — decoded out of a log, where it
 * is checksummed, and typed into a URL by whoever is asking — and the second
 * one has no rule about case at all. Two spellings of one wallet indexing to
 * two records would be an empty history handed to somebody who has one.
 */
function key(value: unknown): `0x${string}` | null {
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value)
    ? (value.toLowerCase() as `0x${string}`)
    : null
}

function amount(value: unknown): bigint {
  return typeof value === 'bigint' ? value : 0n
}

function count(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  return typeof value === 'number' ? value : 0
}

export class PlayerLedger {
  private readonly players = new Map<string, MutableRecord>()

  /**
   * Who is seated in each operation right now.
   *
   * A round's result names its winners and nobody else, so the losers are
   * only knowable against the seats — which means membership has to be
   * carried from `PlayerJoined` all the way to `WinnerDetermined`. It is
   * dropped the moment the operation ends, in either direction, because a
   * lobby resolves exactly once and holding it afterwards would grow this
   * map for the lifetime of the process.
   */
  private readonly seats = new Map<string, Set<`0x${string}`>>()

  /**
   * Operations that ended without ever being played.
   *
   * `resolveRound` emits `LobbyCancelled` and then `WinnerDetermined` in the
   * same transaction when no defender ever acted (ТЗ §18), and the log
   * arrives in that order — so by the time the result is folded, this
   * already knows the round was a room the attack flew over rather than a
   * contest anybody lost.
   */
  private readonly unplayed = new Set<string>()

  apply(event: IndexedEvent): void {
    switch (event.name) {
      case 'LobbyCreated': {
        const creator = key(event.args.creator)
        if (creator) this.touch(creator, event.blockNumber).operationsCreated += 1
        return
      }
      case 'PlayerJoined': {
        const player = key(event.args.player)
        const lobbyId = String(event.args.lobbyId ?? '')
        if (!player || !lobbyId) return
        const record = this.touch(player, event.blockNumber)
        record.operationsJoined += 1
        record.stakedWei += amount(event.args.paid)
        this.seatsFor(lobbyId).add(player)
        return
      }
      case 'PlayerLeft': {
        const player = key(event.args.player)
        const lobbyId = String(event.args.lobbyId ?? '')
        if (!player || !lobbyId) return
        const record = this.touch(player, event.blockNumber)
        record.operationsLeft += 1
        record.returnedWei += amount(event.args.refunded)
        this.seats.get(lobbyId)?.delete(player)
        return
      }
      case 'ProbesPurchased': {
        const player = key(event.args.player)
        if (!player) return
        const record = this.touch(player, event.blockNumber)
        record.probesBought += count(event.args.count)
        record.stakedWei += amount(event.args.paid)
        return
      }
      case 'ProbeSent': {
        const player = key(event.args.player)
        if (player) this.touch(player, event.blockNumber).probesSent += 1
        return
      }
      case 'DefenseSubmitted': {
        const player = key(event.args.player)
        if (player) this.touch(player, event.blockNumber).defensesSubmitted += 1
        return
      }
      case 'LobbyCancelled': {
        const lobbyId = String(event.args.lobbyId ?? '')
        if (!lobbyId) return
        this.unplayed.add(lobbyId)
        this.seats.delete(lobbyId)
        return
      }
      case 'WinnerDetermined': {
        this.applyWinnerDetermined(event)
        return
      }
      case 'RewardClaimed': {
        const player = key(event.args.player)
        if (player) this.touch(player, event.blockNumber).wonWei += amount(event.args.amount)
        return
      }
      case 'RefundClaimed': {
        const player = key(event.args.player)
        if (player) this.touch(player, event.blockNumber).returnedWei += amount(event.args.amount)
        return
      }
      case 'CreatorSettled': {
        const creator = key(event.args.creator)
        if (creator) this.touch(creator, event.blockNumber).creatorFeesWei += amount(event.args.amount)
        return
      }
      default:
        return
    }
  }

  /**
   * The one event that scores anybody, and the only place a streak moves.
   *
   * Two rules make the record honest rather than merely available:
   *
   * A round nobody played is not a round anybody lost. `UNPLAYED` ends an
   * operation where no probe was sent and no defense submitted; everyone is
   * refunded and the protocol says as much by cancelling it. Counting that
   * as a defeat would break a streak on a game that never started.
   *
   * And a seat is scored whether or not its holder acted in the round,
   * because `validActions > 0` says *somebody* did: from here on the
   * operation was a contest, and sitting it out is how you lose one.
   */
  private applyWinnerDetermined(event: IndexedEvent): void {
    const lobbyId = String(event.args.lobbyId ?? '')
    if (!lobbyId) return

    const seated = this.seats.get(lobbyId)
    this.seats.delete(lobbyId)
    if (this.unplayed.has(lobbyId)) {
      this.unplayed.delete(lobbyId)
      return
    }
    if (!seated) return

    const winners = new Set<string>()
    if (Array.isArray(event.args.winners)) {
      for (const winner of event.args.winners) {
        const address = key(winner)
        if (address) winners.add(address)
      }
    }

    for (const player of seated) {
      const record = this.touch(player, event.blockNumber)
      record.roundsPlayed += 1
      record.recentRounds.push(winners.has(player))
      if (record.recentRounds.length > RECENT_ROUNDS) record.recentRounds.shift()
      if (winners.has(player)) {
        record.interceptions += 1
        record.currentStreak += 1
        if (record.currentStreak > record.bestStreak) record.bestStreak = record.currentStreak
      } else {
        record.currentStreak = 0
      }
    }
  }

  /**
   * What one wallet did, or an empty record.
   *
   * An address with no history gets zeroes rather than a 404: a wallet that
   * has never played is a real answer to the question, and the panel that
   * asks has to render something either way. `firstBlock` stays null, which
   * is how a caller tells "nothing yet" from "nothing this time".
   */
  record(address: string): PlayerRecord {
    const normalised = key(address)
    const existing = normalised ? this.players.get(normalised) : undefined
    const record = existing ?? blank((normalised ?? (address.toLowerCase() as `0x${string}`)))
    return {
      ...record,
      // A copy: the fold keeps mutating its own array, and a caller holding
      // the same one would watch a JSON response change under it.
      recentRounds: [...record.recentRounds],
      stakedWei: record.stakedWei.toString(),
      wonWei: record.wonWei.toString(),
      creatorFeesWei: record.creatorFeesWei.toString(),
      returnedWei: record.returnedWei.toString(),
    }
  }

  /** How many wallets the fold has ever seen. For `/health`, not for a player. */
  get size(): number {
    return this.players.size
  }

  private touch(address: `0x${string}`, blockNumber: number): MutableRecord {
    let record = this.players.get(address)
    if (!record) {
      record = blank(address)
      this.players.set(address, record)
    }
    if (record.firstBlock === null) record.firstBlock = blockNumber
    record.lastBlock = blockNumber
    return record
  }

  private seatsFor(lobbyId: string): Set<`0x${string}`> {
    let seated = this.seats.get(lobbyId)
    if (!seated) {
      seated = new Set()
      this.seats.set(lobbyId, seated)
    }
    return seated
  }
}

function blank(address: `0x${string}`): MutableRecord {
  return {
    address,
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
    stakedWei: 0n,
    wonWei: 0n,
    creatorFeesWei: 0n,
    returnedWei: 0n,
    recentRounds: [],
    firstBlock: null,
    lastBlock: null,
  }
}
