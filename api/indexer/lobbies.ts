/**
 * Every operation the protocol has ever opened, folded out of the same log
 * the player record is.
 *
 * Until this existed there was no way into an operation except creating one
 * or being handed a link: the app had `Create Defense`, a lobby page keyed by
 * id, and nothing in between. A defense game whose rooms cannot be found is
 * a game most visitors can only play alone.
 *
 * The contract *can* answer this — `getLobbyIds` pages ids and `getLobby`
 * reads one — but only as one request per lobby per visitor, which is the
 * shape of read a browser should never make and a backend already exists to
 * absorb. So the directory is folded here once and served as a list.
 *
 * Most of what it says comes from the events: a lobby's name, its author, its
 * entry price and its deadline are all public in `LobbyCreated`, and seats are
 * counted from joins and leaves.
 *
 * Two facts are **not** in any event, and both matter to somebody choosing a
 * room: how many seats it holds (`maxPlayers` is lobby config) and what the
 * pool is worth. The pool in particular must never be *reconstructed* — it
 * moves through fees, refunds and the Global Defense Pool by rules that live
 * in the contract, and an approximation of somebody's money is worse than no
 * figure at all. So they are not derived here; they are read from the
 * contract for the operations somebody can still act on, and handed in
 * through `enrich`. See `IndexerService.refreshLive`.
 */

export type LobbyStatus = 'open' | 'active' | 'finished' | 'cancelled'

/** How many operations sit in each status, for the tab figures. */
export interface DirectoryCounts {
  open: number
  active: number
  finished: number
  cancelled: number
  all: number
}

export interface LobbySummary {
  id: string
  /** As the author typed it. Empty is legal and renders as the short id. */
  name: string
  creator: string
  entryPriceWei: string
  startPrizePoolWei: string
  /** Unix seconds, from the contract's own clock. */
  registrationDeadline: number
  /** Seats taken right now: joins minus leaves. */
  participants: number
  /**
   * Seats in total, and the floor the operation needs to start at all.
   *
   * Null until read: they are lobby *config* rather than event payload, so
   * they arrive from the contract and only for operations still worth a read
   * (see `enrich`). A row that does not know the capacity says how many
   * defenders are in the room and stops, rather than inventing a ceiling.
   */
  maxPlayers: number | null
  minPlayers: number | null
  /**
   * What winners share, exactly as the contract computes it — never folded
   * from fees out here. Null on operations nobody is refreshing any more.
   *
   * On a Global Defense draw this is the contract's figure *plus* the
   * jackpot standing behind it (`drawBountyWei`), because the draw's bounty
   * lives in `globalDefensePool` rather than in the lobby until the round
   * activates. Reporting the lobby's own number there would say 0 for the
   * whole application window and forever afterwards on a room that never
   * filled — see `drawPool`.
   */
  rewardPoolWei: string | null
  /**
   * The jackpot behind a protocol draw, and null on every player operation.
   *
   * `GlobalDefenseOpened` states it when the room is minted; a live read
   * keeps it current while applications are open, and the last value read
   * is what the round was playing for when it ended. It is reported
   * separately as well as folded into `rewardPoolWei` so a client can tell
   * a draw's pool from a creator's bounty.
   */
  drawBountyWei: string | null
  status: LobbyStatus
  /** Only once a round has been scored. Null everywhere else. */
  intercepted: boolean | null
  /** Why an operation ended without a contest, when that is what happened. */
  endedReason: string | null
  createdBlock: number
  startedBlock: number | null
  endedBlock: number | null
}

/** One wallet's relationship to an operation. A creator need not take a seat. */
export interface PlayerLobby extends LobbySummary {
  joined: boolean
  created: boolean
}

/** How many finished operations one wallet's history hands back. */
export const PLAYER_PAST_LIMIT = 12

interface MutableLobby {
  id: string
  name: string
  creator: string
  entryPriceWei: bigint
  startPrizePoolWei: bigint
  registrationDeadline: number
  participants: number
  /**
   * Seats in total, and the floor the operation needs to start at all.
   *
   * Null until read: they are lobby *config* rather than event payload, so
   * they arrive from the contract and only for operations still worth a read
   * (see `enrich`). A row that does not know the capacity says how many
   * defenders are in the room and stops, rather than inventing a ceiling.
   */
  maxPlayers: number | null
  minPlayers: number | null
  /**
   * What winners share, exactly as the contract computes it — never folded
   * from fees out here. Null on operations nobody is refreshing any more.
   */
  rewardPoolWei: bigint | null
  /** The jackpot behind a protocol draw. Null on every player operation. */
  drawBountyWei: bigint | null
  status: LobbyStatus
  intercepted: boolean | null
  endedReason: string | null
  createdBlock: number
  startedBlock: number | null
  endedBlock: number | null
  /** Seats, for answering "which operations is this wallet in". */
  members: Set<string>
}

function address(value: unknown): string | null {
  return typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null
}

function id(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('0x') ? value.toLowerCase() : null
}

function count(value: unknown): number {
  if (typeof value === 'bigint') return Number(value)
  return typeof value === 'number' ? value : 0
}

function wei(value: unknown): bigint {
  return typeof value === 'bigint' ? value : 0n
}

export class LobbyDirectory {
  private readonly lobbies = new Map<string, MutableLobby>()
  /** Every operation a wallet has taken a seat in or opened, newest last. */
  private readonly byPlayer = new Map<string, Set<string>>()

  apply(event: { name: string; blockNumber: number; args: Record<string, unknown> }): void {
    const lobbyId = id(event.args.lobbyId)
    if (!lobbyId) return

    switch (event.name) {
      case 'LobbyCreated': {
        const creator = address(event.args.creator) ?? ''
        this.lobbies.set(lobbyId, {
          id: lobbyId,
          name: typeof event.args.name === 'string' ? event.args.name : '',
          creator,
          entryPriceWei: wei(event.args.entryPrice),
          startPrizePoolWei: wei(event.args.startPrizePool),
          registrationDeadline: count(event.args.registrationDeadline),
          participants: 0,
          maxPlayers: null,
          minPlayers: null,
          rewardPoolWei: null,
          drawBountyWei: null,
          status: 'open',
          intercepted: null,
          endedReason: null,
          createdBlock: event.blockNumber,
          startedBlock: null,
          endedBlock: null,
          members: new Set(),
        })
        if (creator) this.link(creator, lobbyId)
        return
      }
      case 'GlobalDefenseOpened': {
        /*
         * What the protocol's own draw is playing for.
         *
         * The lobby does not hold it. `openGlobalDefense` mints the room
         * with `startPrizePool: 0` and leaves every wei in
         * `globalDefensePool` until `commitDrawBounty` escrows it at
         * activation — so a contract read of this operation answers 0 for
         * the whole application window, and answers 0 forever on a room
         * that never filled. This event is the contract stating the figure
         * itself, which is why the bounty can be taken from it here while
         * `rewardPool` still may not be.
         */
        const lobby = this.lobbies.get(lobbyId)
        if (!lobby) return
        lobby.drawBountyWei = wei(event.args.pool)
        return
      }
      case 'PlayerJoined': {
        const lobby = this.lobbies.get(lobbyId)
        const player = address(event.args.player)
        if (!lobby || !player) return
        lobby.members.add(player)
        /*
         * The count comes off the event rather than from the size of the set
         * above. `participantCount` is what the contract counted in the same
         * transaction, and it stays right even where this process started
         * reading the log after a join it therefore never saw.
         */
        lobby.participants = count(event.args.participantCount) || lobby.members.size
        this.link(player, lobbyId)
        return
      }
      case 'PlayerLeft': {
        const lobby = this.lobbies.get(lobbyId)
        const player = address(event.args.player)
        if (!lobby || !player) return
        lobby.members.delete(player)
        lobby.participants = count(event.args.participantCount)
        /*
         * The link is kept. A seat given up is still something this wallet
         * did, and a history that erased it would answer "no" to somebody
         * who is looking for the operation they left.
         */
        return
      }
      case 'OperationStarted': {
        const lobby = this.lobbies.get(lobbyId)
        if (!lobby) return
        lobby.status = 'active'
        lobby.startedBlock = event.blockNumber
        return
      }
      case 'WinnerDetermined': {
        const lobby = this.lobbies.get(lobbyId)
        if (!lobby) return
        lobby.intercepted = event.args.intercepted === true
        lobby.endedBlock = event.blockNumber
        /*
         * A round that was cancelled in this same transaction stays
         * cancelled: `LobbyCancelled` arrives first when nobody ever acted
         * (ТЗ §18), and calling that operation "finished" would promise a
         * result nobody played for.
         */
        if (lobby.status !== 'cancelled') lobby.status = 'finished'
        return
      }
      case 'LobbyCancelled': {
        const lobby = this.lobbies.get(lobbyId)
        if (!lobby) return
        lobby.status = 'cancelled'
        lobby.endedBlock = event.blockNumber
        lobby.endedReason = typeof event.args.reason === 'string' ? event.args.reason : null
        return
      }
      case 'AttackExpired': {
        const lobby = this.lobbies.get(lobbyId)
        if (!lobby || lobby.status === 'finished') return
        // The contract ends these as CANCELLED, and everyone is refunded.
        lobby.status = 'cancelled'
        lobby.endedBlock = event.blockNumber
        lobby.endedReason = typeof event.args.reason === 'string' ? event.args.reason : null
        return
      }
      default:
        return
    }
  }

  /**
   * The two facts no event carries, from whoever did read them.
   *
   * Deliberately a setter rather than a fetch: this file folds a log and
   * knows nothing about an RPC, which is what keeps every rule in it testable
   * by writing down events. The service decides *which* operations are worth
   * a contract read and when.
   */
  enrich(
    lobbyId: string,
    facts: {
      maxPlayers?: number
      minPlayers?: number
      rewardPoolWei?: bigint
      /**
       * The idle `globalDefensePool`, right now. Applied only to operations
       * a `GlobalDefenseOpened` already named as draws — the service reads
       * one figure per sweep and offers it to every live room, and a player
       * lobby has no business taking it.
       */
      drawBountyWei?: bigint
    },
  ): void {
    const lobby = this.lobbies.get(lobbyId.toLowerCase())
    if (!lobby) return
    if (facts.maxPlayers !== undefined) lobby.maxPlayers = facts.maxPlayers
    if (facts.minPlayers !== undefined) lobby.minPlayers = facts.minPlayers
    if (facts.rewardPoolWei !== undefined) lobby.rewardPoolWei = facts.rewardPoolWei
    if (facts.drawBountyWei !== undefined && lobby.drawBountyWei !== null) {
      lobby.drawBountyWei = facts.drawBountyWei
    }
  }

  /** Whether any operation still worth a read is a protocol draw. */
  hasLiveDraw(): boolean {
    return [...this.lobbies.values()].some(
      (lobby) => lobby.drawBountyWei !== null && (lobby.status === 'open' || lobby.status === 'active'),
    )
  }

  /** Which operations are worth a contract read: the ones somebody can act on. */
  liveIds(): string[] {
    return [...this.lobbies.values()]
      .filter((lobby) => lobby.status === 'open' || lobby.status === 'active')
      .sort((a, b) => b.createdBlock - a.createdBlock)
      .map((lobby) => lobby.id)
  }

  /**
   * The directory, newest first.
   *
   * Newest first because the question a visitor is asking is "what can I join
   * now", and the operations that answer it are the ones opened most
   * recently. `status` narrows it; without one, everything comes back in the
   * same order.
   */
  list(options: { status?: LobbyStatus; limit?: number; offset?: number; query?: string } = {}): {
    lobbies: LobbySummary[]
    total: number
    counts: DirectoryCounts
  } {
    /*
     * The name, or the id — matched as a substring, case-insensitively.
     *
     * Both, because the two ways somebody arrives at this box are "I know
     * what it was called" and "I have the id from a transaction and want the
     * room it belongs to". Nothing fuzzier: an operation is a name its author
     * typed, and a search that guessed at near-misses would put somebody in
     * the wrong room's page.
     */
    const query = options.query?.trim().toLowerCase() ?? ''
    const searched = [...this.lobbies.values()].filter(
      (lobby) => !query || lobby.name.toLowerCase().includes(query) || lobby.id.includes(query),
    )
    const counts = tally(searched)
    const all = searched
      .filter((lobby) => !options.status || lobby.status === options.status)
      .sort((a, b) => b.createdBlock - a.createdBlock)

    const offset = Math.max(0, options.offset ?? 0)
    const limit = Math.max(1, Math.min(options.limit ?? 50, 200))
    return { lobbies: all.slice(offset, offset + limit).map(summarise), total: all.length, counts }
  }

  /**
   * One wallet's operations, split by whether they are still going.
   *
   * `live` is what the panel links to — an operation still taking
   * applications, or one in flight where this wallet has a defense to place.
   * `past` is capped, because a record is a history and a wallet panel is not
   * where anybody reads all of one.
   */
  forPlayer(player: string): { live: PlayerLobby[]; past: PlayerLobby[] } {
    const key = address(player)
    const ids = key ? this.byPlayer.get(key) : undefined
    if (!key || !ids) return { live: [], past: [] }

    const mine = [...ids]
      .map((lobbyId) => this.lobbies.get(lobbyId))
      .filter((lobby): lobby is MutableLobby => lobby !== undefined)
      .sort((a, b) => b.createdBlock - a.createdBlock)
      .map((lobby) => ({
        ...summarise(lobby),
        joined: lobby.members.has(key),
        created: lobby.creator === key,
      }))

    return {
      live: mine.filter((lobby) => lobby.status === 'open' || lobby.status === 'active'),
      past: mine.filter((lobby) => lobby.status === 'finished' || lobby.status === 'cancelled').slice(0, PLAYER_PAST_LIMIT),
    }
  }

  /** How many operations the fold has seen. For `/health`. */
  get size(): number {
    return this.lobbies.size
  }

  private link(player: string, lobbyId: string): void {
    let owned = this.byPlayer.get(player)
    if (!owned) {
      owned = new Set()
      this.byPlayer.set(player, owned)
    }
    owned.add(lobbyId)
  }
}

function tally(lobbies: readonly MutableLobby[]): DirectoryCounts {
  const counts: DirectoryCounts = { open: 0, active: 0, finished: 0, cancelled: 0, all: 0 }
  for (const lobby of lobbies) {
    counts[lobby.status] += 1
    counts.all += 1
  }
  return counts
}

/**
 * The pool to report, once a Global Defense draw's bounty is accounted for.
 *
 * A draw does not hold the jackpot while it is taking applications:
 * `openGlobalDefense` mints the room with `startPrizePool: 0`, `topUpDraw`
 * refuses to move the pile into an OPEN draw, and only `commitDrawBounty`
 * escrows it — at activation, in the same call that emits
 * `OperationStarted`. So a round that started has the whole of it in
 * `rewardPool` already, and one that never did was playing for a pile that
 * is still outside the lobby (and, once it ended unplayed, back in the
 * idle pool it never left).
 *
 * `startedBlock` is therefore the test rather than the status: it is set by
 * exactly the event that escrows, which keeps this right for a round
 * cancelled *after* it started (`AttackExpired`) as well as one that never
 * filled.
 */
function drawPool(lobby: MutableLobby): bigint | null {
  if (lobby.drawBountyWei === null || lobby.startedBlock !== null) return lobby.rewardPoolWei
  return (lobby.rewardPoolWei ?? 0n) + lobby.drawBountyWei
}

function summarise(lobby: MutableLobby): LobbySummary {
  const pool = drawPool(lobby)
  return {
    id: lobby.id,
    name: lobby.name,
    creator: lobby.creator,
    entryPriceWei: lobby.entryPriceWei.toString(),
    startPrizePoolWei: lobby.startPrizePoolWei.toString(),
    registrationDeadline: lobby.registrationDeadline,
    participants: lobby.participants,
    maxPlayers: lobby.maxPlayers,
    minPlayers: lobby.minPlayers,
    rewardPoolWei: pool === null ? null : pool.toString(),
    drawBountyWei: lobby.drawBountyWei === null ? null : lobby.drawBountyWei.toString(),
    status: lobby.status,
    intercepted: lobby.intercepted,
    endedReason: lobby.endedReason,
    createdBlock: lobby.createdBlock,
    startedBlock: lobby.startedBlock,
    endedBlock: lobby.endedBlock,
  }
}
