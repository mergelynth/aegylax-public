import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { parseEventLogs, type Abi } from 'viem'
import { ChainService } from '../chain/chain.service'
import { CONFIG, type AppConfig } from '../config/configuration'
import { PlayerLedger, type IndexedEvent, type PlayerRecord } from './ledger'
import { LobbyDirectory, type DirectoryCounts, type LobbyStatus, type LobbySummary, type PlayerLobby } from './lobbies'

/**
 * The protocol's log, read once and folded into what each wallet did.
 *
 * A player's own history is the one question the contract cannot answer.
 * Its reads are about *now* — this operation, this attack, this balance —
 * and a record is about everything before that: rounds played, interceptions,
 * a streak. The facts are all on chain, in events the protocol emits for
 * exactly this reason (ТЗ §11), but they are scattered over months of blocks
 * and no browser is going to page through them on a wallet-panel open.
 *
 * So this reads them here, once, and answers in a single request.
 *
 * The same pass feeds a second fold: the **directory** of every operation the
 * protocol has opened (`lobbies.ts`). The contract can answer that one — page
 * `getLobbyIds`, then `getLobby` for each — but only as one request per lobby
 * per visitor, which is exactly the read a backend exists to absorb.
 *
 * **In memory, and rebuilt on boot.** There is no database, and adding one
 * for a demo would be the largest piece of infrastructure in the system for
 * the smallest feature in it. What it costs is a backfill at startup — a few
 * hundred `eth_getLogs` windows against a deployment weeks old — and what it
 * buys is that the store can never disagree with the chain, because it *is*
 * the chain, replayed. When the backfill grows past what a boot should
 * spend, that is the signal to give it storage, and the fold in `ledger.ts`
 * is already the only thing that would have to be pointed at it.
 *
 * **Behind the head, deliberately.** Nothing within `confirmations` of the
 * tip is folded in. A reorg that far back would otherwise leave a permanent
 * lie in a counter that is never recomputed — double-counted joins, a streak
 * broken by a round that un-happened — and the cursor only moves forward.
 * Lagging a few blocks is the cheaper half of that trade by a wide margin: a
 * record is a history, and nobody reads it in the same second they act.
 */
/**
 * How many live operations get a contract read per sweep.
 *
 * A ceiling rather than a page size: the directory is meant to cost the RPC a
 * fixed amount whatever the game's popularity does, and sixty rooms open at
 * once is far past anything this deployment has seen. Past it, the newest
 * sixty are refreshed — which are the ones a visitor is looking at.
 */
const LIVE_READ_LIMIT = 60

/** `GameTypes.LobbyStatus.OPEN`. See the same enum in `keeper.service.ts`. */
const LOBBY_STATUS_OPEN = 1

@Injectable()
export class IndexerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IndexerService.name)
  private readonly ledger = new PlayerLedger()
  private readonly directory = new LobbyDirectory()

  /** The next block to read. Monotonic: it never goes back over folded ground. */
  private cursor = 0n
  private timer: NodeJS.Timeout | null = null
  private alive = false
  private sweeping = false

  readonly state = {
    /** Everything up to and including this block is in the fold. */
    indexedThroughBlock: null as number | null,
    /** False while the first pass is still walking up from the deployment. */
    caughtUp: false,
    lastSweepAt: null as number | null,
    lastError: null as string | null,
    wallets: 0,
    operations: 0,
  }

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly chain: ChainService,
  ) {}

  onModuleInit(): void {
    if (!this.config.indexer.enabled) return this.logger.log('disabled')

    this.alive = true
    this.cursor = this.config.indexer.fromBlock
    this.logger.log(`reading ${this.config.chain.contract} from block ${this.cursor}`)
    void this.tick()
  }

  onModuleDestroy(): void {
    this.alive = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Whether this deployment answers record requests at all. */
  get enabled(): boolean {
    return this.config.indexer.enabled
  }

  /**
   * Which deployment these answers are about.
   *
   * The fold is scoped to one address and starts at its deployment block, so
   * every answer here is already about one contract — but nothing said which,
   * and a caller cannot tell a directory that is empty from one that belongs
   * to a protocol it is not looking at. After a redeploy that distinction is
   * the whole question: this process holds the manifest it read at boot, and
   * a client built against the new one would otherwise render the old
   * contract's rooms as its own.
   */
  get contract(): `0x${string}` {
    return this.config.chain.contract
  }

  /**
   * One wallet's record, as of whatever is folded so far.
   *
   * It answers during the backfill rather than waiting for it, and says how
   * far it has read — `indexedThroughBlock` against the chain's head is the
   * only thing that lets a panel tell a wallet with no history from a
   * history this has not reached yet.
   */
  recordFor(address: string): { record: PlayerRecord; indexedThroughBlock: number | null; syncing: boolean } {
    return {
      record: this.ledger.record(address),
      indexedThroughBlock: this.state.indexedThroughBlock,
      syncing: !this.state.caughtUp,
    }
  }

  /**
   * The directory, newest first — what a visitor picks an operation out of.
   *
   * It answers during the backfill like the record does, and for the same
   * reason: a list that is still filling is more use than a spinner, and
   * `syncing` says which one this is.
   */
  lobbies(options: { status?: LobbyStatus; limit?: number; offset?: number; query?: string }): {
    lobbies: LobbySummary[]
    total: number
    counts: DirectoryCounts
    indexedThroughBlock: number | null
    syncing: boolean
  } {
    return {
      ...this.directory.list(options),
      indexedThroughBlock: this.state.indexedThroughBlock,
      syncing: !this.state.caughtUp,
    }
  }

  /** One wallet's operations: the ones still going, and the ones behind it. */
  lobbiesFor(player: string): { live: PlayerLobby[]; past: PlayerLobby[]; syncing: boolean } {
    return { ...this.directory.forPlayer(player), syncing: !this.state.caughtUp }
  }

  private async tick(): Promise<void> {
    try {
      await this.sweep()
      this.state.lastError = null
    } catch (error) {
      /*
       * A failed window must not end the reader, and must not skip anything
       * either: the cursor is only advanced by a window that came back, so
       * the next sweep asks for the same blocks again. An RPC that rate-limits
       * a backfill is the ordinary case, not a fault.
       */
      this.state.lastError = String((error as Error)?.message ?? error).split('\n')[0]
      this.logger.warn(`sweep failed at block ${this.cursor}: ${this.state.lastError}`)
    } finally {
      if (this.alive) this.timer = setTimeout(() => void this.tick(), this.config.indexer.pollMs)
    }
  }

  private async sweep(): Promise<void> {
    // A backfill can outrun the poll interval. Overlapping sweeps would read
    // the same window twice and fold it twice, which for counters is not a
    // wasted request but a wrong answer.
    if (this.sweeping) return
    this.sweeping = true
    try {
      const head = await this.chain.blockNumber()
      const target = head - this.config.indexer.confirmations
      if (target < this.cursor) {
        this.state.caughtUp = true
        this.state.lastSweepAt = Date.now()
        return
      }

      const window = this.config.indexer.windowBlocks
      while (this.alive && this.cursor <= target) {
        const to = this.cursor + window - 1n > target ? target : this.cursor + window - 1n
        await this.fold(this.cursor, to)
        this.cursor = to + 1n
        this.state.indexedThroughBlock = Number(to)
      }

      this.state.wallets = this.ledger.size
      this.state.operations = this.directory.size
      await this.refreshLive()
      this.state.lastSweepAt = Date.now()
      if (!this.state.caughtUp) {
        this.state.caughtUp = true
        this.logger.log(`caught up at block ${this.state.indexedThroughBlock} over ${this.state.wallets} wallets`)
      }
    } finally {
      this.sweeping = false
    }
  }

  /**
   * The two facts the log does not carry, for the operations somebody can
   * still act on.
   *
   * How many seats a room holds is lobby *config*, and `LobbyCreated` does
   * not carry it; what the pool is worth is money the contract moves through
   * fees and refunds by rules that only it knows. Both are exactly what a
   * visitor is choosing by, and neither can be folded out of events without
   * duplicating the contract's arithmetic out here — where it would be a
   * second implementation of somebody's money, wrong the first time the fee
   * rules move.
   *
   * So they are read rather than derived, and the cost is bounded on purpose:
   * only operations that are open or in flight, only `LIVE_READ_LIMIT` of
   * them, once per sweep. A finished round keeps whatever was last read,
   * which is what it ended with. A failed read leaves the previous answer
   * standing rather than blanking a row — the sweep is seconds away.
   */
  private async refreshLive(): Promise<void> {
    const ids = this.directory.liveIds().slice(0, LIVE_READ_LIMIT)
    /*
     * The jackpot, once, and only when a draw is actually open.
     *
     * A protocol draw never holds its bounty while it is taking
     * applications: `openGlobalDefense` mints the room with
     * `startPrizePool: 0` and `topUpDraw` refuses to move the pile into an
     * OPEN draw, so the `getLobby` read below answers 0 for exactly the
     * stretch where the figure decides whether anybody joins. This is the
     * other half of that operation's pool, read from the contract for the
     * same reason `rewardPool` is — it is money, and this process does not
     * do money arithmetic.
     *
     * A failed read leaves the previous answer standing, the way every
     * other figure here does.
     */
    let drawBountyWei: bigint | undefined
    if (this.directory.hasLiveDraw()) {
      try {
        drawBountyWei = BigInt(await this.chain.read<bigint>('getGlobalDefensePool', []))
      } catch (error) {
        this.logger.debug?.(
          `could not read the defense pool: ${String((error as Error)?.message ?? error).split('\n')[0]}`,
        )
      }
    }

    for (const lobbyId of ids) {
      if (!this.alive) return
      try {
        const [lobby, config] = await this.chain.read<[any, any, any]>('getLobby', [lobbyId])
        this.directory.enrich(lobbyId, {
          maxPlayers: Number(config.maxPlayers ?? 0) || undefined,
          minPlayers: Number(config.minPlayers ?? 0) || undefined,
          // Only a room still taking applications is short its bounty; past
          // that `commitDrawBounty` has folded it into `rewardPool`, and
          // `enrich` ignores this on anything that is not a draw.
          drawBountyWei: lobby.status === LOBBY_STATUS_OPEN ? drawBountyWei : undefined,
          /*
           * The same expression the contract's own `getPrizePool` uses: while
           * an operation is OPEN the bounty sits in `rewardPool` and entries
           * are still counted separately; activation folds them in, and
           * adding them twice afterwards would overstate every live round.
           */
          rewardPoolWei:
            lobby.status === LOBBY_STATUS_OPEN
              ? BigInt(lobby.rewardPool ?? 0n) + BigInt(lobby.entryFeesCollected ?? 0n)
              : BigInt(lobby.rewardPool ?? 0n),
        })
      } catch (error) {
        this.logger.debug?.(
          `could not read ${lobbyId}: ${String((error as Error)?.message ?? error).split('\n')[0]}`,
        )
      }
    }
  }

  /**
   * One window of logs, in the order the chain wrote them.
   *
   * Every event for the contract is fetched rather than one filter per event
   * name: a window costs one request either way, and the fold needs
   * `LobbyCancelled` immediately before the `WinnerDetermined` it qualifies —
   * an ordering that only survives if both arrive in the same stream.
   */
  private async fold(fromBlock: bigint, toBlock: bigint): Promise<void> {
    const logs = await this.chain.publicClient.getLogs({
      address: this.config.chain.contract,
      fromBlock,
      toBlock,
    })

    // Non-strict: an event this build's ABI does not know is skipped rather
    // than thrown on, so an older deployment's logs cannot stop the backfill.
    const parsed = parseEventLogs({ abi: this.config.chain.abi as Abi, logs })

    for (const log of parsed) {
      const event: IndexedEvent = {
        name: log.eventName,
        blockNumber: Number(log.blockNumber ?? fromBlock),
        args: (log.args ?? {}) as Record<string, unknown>,
      }
      this.ledger.apply(event)
      this.directory.apply(event)
    }
  }
}
