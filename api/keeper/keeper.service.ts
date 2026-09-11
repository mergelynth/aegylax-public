import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { formatEther } from 'viem'
import { ChainService } from '../chain/chain.service'
import { CONFIG, ROOT, type AppConfig } from '../config/configuration'

/**
 * `GameTypes.LobbyStatus`, in its own order.
 *
 * Written out in full and taken from the enum rather than counted from the
 * first case anybody cares about: `NONE` occupies zero, so the statuses this
 * sweep acts on are 1, 2 and 3 — not 0 and 1. Getting that wrong is silent.
 * Every branch simply never runs, the sweep reports no work, and a keeper
 * that does nothing looks exactly like a keeper with nothing to do. It
 * happened, and it cost a played round that sat unrevealed until somebody
 * checked why.
 */
const enum LobbyStatus {
  NONE = 0,
  OPEN = 1,
  READY = 2,
  ACTIVE = 3,
}

/**
 * How long after a deadline block the keeper aims to be awake.
 *
 * Not zero. The deadline is a block, the timer is wall-clock, and the
 * conversion is an average — so a wake-up aimed exactly at the boundary
 * lands on the wrong side of it about half the time and burns a whole retry
 * interval discovering that nothing is due yet.
 */
const DEADLINE_LEAD_MS = 1_000

/** The shortest the scheduler will sleep. A deadline two seconds out is worth waiting for. */
const MIN_DELAY_MS = 1_000

/** How often to re-ask the confidential network while waiting for the unlock to propagate. */
const ATTEST_POLL_MS = 1_000

/**
 * "This lobby needs attention now" — a block that has already passed.
 *
 * The scheduler reads the returned block as *when to come back*, so work
 * that was due and did not complete has to say so in the same currency.
 */
const DUE_NOW = 0n

/** No deadline — this operation is not waiting on the clock for anything. */
const NEVER = -1n

/**
 * The daemon the protocol does not have.
 *
 * Four transitions are permissionless *and* necessary: applications close,
 * an under-filled operation is cancelled, a landed attack is unlocked, and a
 * finished round is revealed and scored. Permissionless means anybody may
 * send them; necessary means that until somebody does, an operation is
 * finished in every sense except the one that pays.
 *
 * In the app they are sent by `useProtocolKeeper`, from the browser of
 * whoever has the page open — the right default for a protocol with no
 * server, and not enough for a public demo, where people watch one round and
 * close the tab.
 *
 * It computes nothing and decides nothing. Every transition is the
 * contract's own, guarded by the contract's own conditions, and this only
 * pays the gas to trigger them. Losing a race to a player's browser is the
 * ordinary outcome, not a failure: whoever won it did the identical thing.
 *
 * **It sleeps to the clock, not on a metronome.** Every deadline in this
 * protocol is a block number known long in advance — an operation's
 * `registrationDeadlineBlock`, an attack's `impactBlock`, the next epoch
 * boundary — so each sweep ends by working out which of them comes first and
 * setting its own timer for a second after it. A fixed interval spent the
 * player's patience on a number nobody had chosen: half of it on average,
 * every time, for a deadline the keeper already knew about. The configured
 * interval survives only as the idle cap.
 */
@Injectable()
export class KeeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KeeperService.name)
  private timer: NodeJS.Timeout | null = null
  private running = false
  private confidential: any = null
  /** Immutable once read — the epoch grid is anchored to it. */
  private genesisBlock: bigint | null = null

  readonly state = {
    lastSweepAt: null as number | null,
    lastSweepBlock: null as number | null,
    /**
     * When the next sweep is due.
     *
     * The one number that says whether the scheduler is tracking a deadline
     * or idling. Without it, a keeper waiting thirty seconds for nothing and
     * a keeper waiting two seconds for an impact block look identical from
     * `/health`.
     */
    nextSweepAt: null as number | null,
    lastError: null as string | null,
    actions: 0,
  }

  private sweeping: Promise<number> | null = null
  /** Per-lobby work in flight, so two nudges for one operation become one. */
  private readonly lobbyJobs = new Map<string, Promise<void>>()

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly chain: ChainService,
  ) {}

  /**
   * Run now rather than at the next wake-up.
   *
   * The page's Reveal control calls this so a finished round does not wait
   * for the scheduler — and so the player never signs unlock/scoring.
   *
   * With a `lobbyId` it advances that operation and nothing else. That is
   * the difference between an answer and a shrug: a bare nudge used to join
   * whichever full sweep happened to be in flight, which may already have
   * walked past the caller's lobby, and then returned `ok` for work it had
   * not done. Scanning every operation to answer one page was also the
   * slowest possible way to say yes.
   */
  async nudge(lobbyId?: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.config.keeper.enabled || !this.config.keeper.privateKey) {
      return { ok: false, error: 'The keeper is not running.' }
    }
    try {
      if (lobbyId) await this.runLobby(lobbyId)
      else await this.runSweep()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: reason(error) }
    }
  }

  async onModuleInit() {
    if (!this.config.keeper.enabled) return this.logger.log('disabled')
    if (!this.config.keeper.privateKey) return this.logger.warn('no key — not starting')

    this.running = true
    const address = this.config.keeper.address!
    const balance = await this.chain.balanceOf(address)
    this.logger.log(`${address} on ${this.config.chain.network}, gas balance ${formatEther(balance)} ETH`)
    if (balance === 0n) this.logger.warn('the keeper wallet is empty — every send will fail')

    void this.tick()
  }

  onModuleDestroy() {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async tick() {
    let delay = this.config.keeper.sweepMs
    try {
      delay = await this.runSweep()
      this.state.lastError = null
    } catch (error) {
      /*
       * A sweep that throws must not end the daemon. An RPC blip is the
       * likeliest cause, the next sweep is seconds away, and a keeper that
       * dies on the first bad response is worse than no keeper at all — it
       * looks like it is running.
       */
      this.state.lastError = reason(error)
      this.logger.warn(`sweep failed: ${this.state.lastError}`)
      delay = this.config.keeper.retryMs
    } finally {
      if (this.running) {
        this.state.nextSweepAt = Date.now() + delay
        this.timer = setTimeout(() => void this.tick(), delay)
      }
    }
  }

  private runSweep(): Promise<number> {
    if (this.sweeping) return this.sweeping
    const job = this.sweep().finally(() => {
      this.sweeping = null
    })
    this.sweeping = job
    // Every caller that awaits `job` sees the rejection; this is only so
    // that a sweep nobody happened to be awaiting is not an unhandled one.
    job.catch(() => undefined)
    return job
  }

  /**
   * Advance one operation, off the sweep's schedule.
   *
   * Deduplicated per lobby rather than globally: two players pressing Reveal
   * on the same round share one job, while two different rounds finishing at
   * once do not queue behind each other.
   */
  private runLobby(lobbyId: string): Promise<void> {
    const existing = this.lobbyJobs.get(lobbyId)
    if (existing) return existing
    const job = (async () => {
      const key = this.config.keeper.privateKey!
      const block = await this.chain.blockNumber()
      await this.advance(key, lobbyId, block)
    })().finally(() => this.lobbyJobs.delete(lobbyId))
    this.lobbyJobs.set(lobbyId, job)
    return job
  }

  /**
   * One pass over everything, ending in the time until the next one.
   *
   * Every branch reports the block at which its operation next needs
   * attention — a future block to sleep until, or `DUE_NOW` for work that
   * was due and did not go through. `nextDelay` turns the collection into a
   * timer.
   */
  private async sweep(): Promise<number> {
    const key = this.config.keeper.privateKey!
    const block = await this.chain.blockNumber()
    const wake: bigint[] = []

    for (const lobbyId of await this.chain.allLobbyIds()) {
      wake.push(await this.advance(key, lobbyId, block))
    }

    /*
     * Opening the next Global Defense draw is permissionless too, and it is
     * the one transition with no operation to hang it off. It is also what
     * mints the jackpot round on every epoch divisible by the interval, and
     * closing a leftover under-filled draw — returning its bounty to the
     * pool — happens inside the same call.
     *
     * Its deadline is the epoch boundary, which is why the boundary joins
     * the schedule even when no operation is running: an empty protocol
     * still has a draw to open on time.
     */
    await this.send(key, 'openGlobalDefense', [], 'open Global Defense')
    wake.push(await this.nextEpochBoundary(block))

    this.state.lastSweepAt = Date.now()
    this.state.lastSweepBlock = Number(block)
    this.state.lastError = null

    return this.nextDelay(wake, block)
  }

  /**
   * Every transition one operation might owe the protocol right now.
   *
   * Returns when to look at it again: a block in the future, `DUE_NOW` if
   * something was due and did not complete, or `NEVER` if this operation has
   * nothing left to ask for.
   */
  private async advance(key: `0x${string}`, lobbyId: string, block: bigint): Promise<bigint> {
    const [lobby, config] = await this.chain.read<[any, any, any]>('getLobby', [lobbyId])
    if (lobby.status === LobbyStatus.NONE) return NEVER

    /*
     * OPEN is taking applications; READY filled and waits to start. Both
     * are the same question — has the deadline passed, and did enough
     * people join — and the contract answers it, so both are offered the
     * same two calls. The wrong one simply does not simulate, which is
     * cheaper and more honest than reimplementing the minimum-players rule
     * out here where it could drift from the contract's copy.
     */
    if (lobby.status === LobbyStatus.OPEN || lobby.status === LobbyStatus.READY) {
      const deadline = BigInt(config.registrationDeadlineBlock ?? 0)
      // Before the deadline neither call can simulate. Sleeping until it is
      // the whole point of reading it: the alternative is asking the chain
      // the same question every interval for however long the creator chose.
      if (block < deadline) return deadline

      const started = await this.send(key, 'startOperation', [lobbyId], `start ${short(lobbyId)}`)
      if (started) return DUE_NOW
      const cancelled = await this.send(key, 'cancelLobby', [lobbyId], `cancel under-filled ${short(lobbyId)}`)
      // Neither went through on a lobby whose deadline has passed: the
      // contract is refusing for a reason this pass cannot see. Come back
      // on the retry interval rather than the idle cap.
      return cancelled ? NEVER : DUE_NOW
    }

    if (lobby.status !== LobbyStatus.ACTIVE) return NEVER

    let [attack] = await this.chain.read<[any]>('getAttack', [lobby.attackId])
    const impact = BigInt(attack.impactBlock ?? 0)

    /*
     * Unlock only what is still locked.
     *
     * `unlockRound` does not revert on a round that is already open — it
     * succeeds and charges for it — so simulating is not a filter here the
     * way it is everywhere else. Without this the keeper re-sent it on
     * every pass between the unlock and the reveal, which on a
     * fifteen-second sweep is a transaction every fifteen seconds.
     * Observed, not theorised.
     */
    if (!attack.decryptionUnlocked) {
      // Nothing to unlock until the threat has landed.
      if (block < impact) return impact
      if (!(await this.send(key, 'unlockRound', [lobbyId], `unlock ${short(lobbyId)}`))) return DUE_NOW

      /*
       * Straight on to the reveal, in this same pass.
       *
       * This used to return here and let the next sweep do the reveal,
       * because the confidential network needs to see the unlock before it
       * will hand over the plaintexts. That is true, and it takes a few
       * seconds — but the cost of expressing "a few seconds" as "one whole
       * sweep" was paid by every player staring at an unrevealed round for
       * the full interval. `attested` waits for the quorum here instead,
       * polling for as long as `attestMs` allows.
       */
      ;[attack] = await this.chain.read<[any]>('getAttack', [lobby.attackId])
      if (!attack.decryptionUnlocked) return DUE_NOW
    }

    /*
     * Come back promptly only if this pass actually did something — sent a
     * publish that still owes its scoring batches, or failed on a
     * confidential network that is likely to answer shortly.
     *
     * The action counter rather than a flag, because "did anything go
     * through" is the only honest test: a round that is already revealed and
     * scored sends nothing and must not hold the keeper on the retry
     * interval for the rest of its life. That is the whole difference
     * between a scheduler and a busy-wait.
     */
    let due = false
    if (this.config.keeper.reveal) {
      const sent = this.state.actions
      try {
        await this.revealAndScore(key, lobbyId, lobby, attack)
        due = this.state.actions !== sent
      } catch (error) {
        // The confidential network being slow is the expected failure, and
        // the next attempt is seconds away. Nothing is lost by waiting.
        this.logger.warn(`reveal ${short(lobbyId)}: ${reason(error)}`)
        due = true
      }
    }

    /*
     * Past the grace window an unrevealed round refunds instead of scoring.
     *
     * Reached whether or not the reveal worked, and that is the point: a
     * confidential network that is down for good is exactly the case this
     * call exists for, so returning early on a failed reveal would have
     * skipped it in the one situation it is needed.
     */
    await this.send(key, 'expireAttack', [lobbyId], `expire ${short(lobbyId)}`)
    return due ? DUE_NOW : NEVER
  }

  /**
   * When to wake up next.
   *
   * The earliest future deadline anything asked for, plus a second, clamped
   * between "soon enough to be punctual" and the configured idle cap.
   * Anything already due short-circuits to the retry interval — that is work
   * the contract refused or the confidential network has not finished, and
   * both want another attempt shortly rather than a nap.
   */
  private async nextDelay(wake: bigint[], block: bigint): Promise<number> {
    const { retryMs, sweepMs } = this.config.keeper
    if (wake.some((at) => at <= block && at !== NEVER)) return retryMs

    const future = wake.filter((at) => at !== NEVER && at > block)
    if (future.length === 0) return sweepMs

    const nearest = future.reduce((soonest, at) => (at < soonest ? at : soonest))
    const blockMs = await this.chain.blockTimeMs()
    const ms = Number(nearest - block) * blockMs + DEADLINE_LEAD_MS
    return Math.min(Math.max(ms, MIN_DELAY_MS), sweepMs)
  }

  /**
   * The block the next epoch starts on.
   *
   * Read rather than assumed: `epochBlocks` is governed, and a schedule
   * anchored to a stale copy of it drifts further from the real boundary
   * with every epoch. Genesis is immutable, so it is read once.
   */
  private async nextEpochBoundary(block: bigint): Promise<bigint> {
    try {
      if (this.genesisBlock === null) this.genesisBlock = BigInt(await this.chain.read<bigint>('genesisBlock'))
      const [params] = await this.chain.read<[any, number]>('getParams')
      const epochBlocks = BigInt(params.epochBlocks ?? 0)
      if (epochBlocks <= 0n) return NEVER
      if (block < this.genesisBlock) return this.genesisBlock
      const elapsed = block - this.genesisBlock
      return this.genesisBlock + (elapsed / epochBlocks + 1n) * epochBlocks
    } catch (error) {
      // A schedule hint, not a transition. Losing it costs punctuality on
      // the draw, and the idle cap still bounds the wait.
      this.logger.warn(`epoch boundary unreadable: ${reason(error)}`)
      return NEVER
    }
  }

  private async send(key: `0x${string}`, fn: string, args: unknown[], label: string): Promise<boolean> {
    const hash = await this.chain.trySend(key, fn, args, label)
    if (hash) this.state.actions += 1
    return hash !== null
  }

  /**
   * Finish a round: fetch the attested plaintexts, then reveal and score.
   *
   * This is the one background job that needs more than an RPC — it holds
   * the confidential client — and that is exactly why it belongs on a server
   * rather than in whichever tab happens to be open.
   *
   * The client is loaded on first use and kept: it is ESM under `tools/`,
   * which is why this reaches for it with a dynamic import rather than a
   * top-level one.
   */
  private async revealAndScore(key: `0x${string}`, lobbyId: string, lobby: any, attack: any): Promise<void> {
    const [alreadyRevealed] = await this.chain.read<[boolean, any]>('getTrajectory', [lobby.attackId])
    const attempts = await this.chain.read<any[]>('getDefenseAttempts', [lobbyId])
    // A revealed epoch can still hold an unscored team: the trajectory is the
    // epoch's, the scoring is each operation's.
    if (alreadyRevealed && attempts.every((attempt) => attempt.revealed)) return

    if (!this.confidential) {
      const { connectConfidential } = await importEsm<typeof import('../../tools/chain/confidential-client.mjs')>(
        'tools/chain/confidential-client.mjs',
      )
      this.confidential = await connectConfidential({
        manifest: this.config.chain.manifest,
        chainId: this.config.chain.id,
        rpcUrl: this.config.chain.rpcUrl,
        publicClient: this.chain.publicClient,
      })
    }

    const handles = [
      attack.bearingHandle,
      attack.deltaHandle,
      attack.maskKeyHandle,
      ...attempts.map((entry) => entry.maskedHandle),
    ]
    const [bearing, delta, mask, ...defenses] = await this.attested(handles)

    const pending = attempts
      .map((attempt, index) => ({ attempt, index }))
      .filter(({ attempt }) => !attempt.revealed)
    const batch = 32

    if (!alreadyRevealed && pending.length === attempts.length && attempts.length <= batch) {
      await this.send(key, 'revealAndResolve', [lobbyId, bearing, delta, mask, defenses], `reveal ${short(lobbyId)}`)
      return
    }

    if (!alreadyRevealed) {
      await this.send(key, 'revealAndResolve', [lobbyId, bearing, delta, mask, []], `publish ${short(lobbyId)}`)
    }

    for (let offset = 0; offset < pending.length; offset += batch) {
      const chunk = pending.slice(offset, offset + batch)
      await this.send(
        key,
        'proveDefenses',
        [lobbyId, chunk.map(({ index }) => index), chunk.map(({ index }) => defenses[index])],
        `score ${short(lobbyId)} ${offset / batch + 1}`,
      )
    }

    await this.send(key, 'finalizeScoring', [lobbyId], `finalize ${short(lobbyId)}`)
  }

  /**
   * The plaintexts, waited for rather than asked for once.
   *
   * The covalidator quorum learns that a round was unlocked by watching the
   * chain, so for the first few seconds after `unlockRound` is mined the
   * honest answer to this request is "not yet" — a rejection, not an empty
   * result. Treating that as a failed sweep is what used to cost a whole
   * interval; polling through it is what lets one pass unlock and reveal.
   *
   * Bounded by `attestMs`, because a quorum that is genuinely down must not
   * hold the sweep forever while other operations wait behind it.
   */
  private async attested(handles: string[]): Promise<bigint[]> {
    const deadline = Date.now() + this.config.keeper.attestMs
    let lastError: unknown
    for (;;) {
      try {
        return await this.confidential.fetchAttested(handles)
      } catch (error) {
        lastError = error
      }
      if (Date.now() >= deadline) throw lastError
      await sleep(ATTEST_POLL_MS)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

function short(id: string): string {
  return `${id.slice(0, 10)}…`
}

function reason(error: unknown): string {
  return String((error as Error)?.message ?? error).split('\n')[0]
}

/**
 * A real dynamic import, kept out of TypeScript's reach.
 *
 * This file compiles to CommonJS, and `tsc` rewrites `await import(x)` into
 * `require(x)` when it does — which cannot load an ESM module on Node 20,
 * and the chain tooling under `tools/` is ESM. The failure is the worst
 * shape available: it compiles, it passes every sweep that has no round to
 * reveal, and it throws the first time a real one needs finishing. Newer
 * Node can `require()` some ESM, so it would also have worked on a developer
 * machine and broken on the deploy.
 *
 * `new Function` produces the import at runtime, where `tsc` has no opinion
 * about it. The specifier is relative to this file, so it is resolved
 * against `__filename` rather than against the caller's cwd.
 */
function importEsm<T>(fromRoot: string): Promise<T> {
  // Resolved against the repository root, not against this file. `tools/` is
  // never compiled — it stays where it is, as ESM — so a path relative to
  // the *built* location points into `dist-server/tools`, which does not
  // exist. That failure survives every sweep with no round to reveal and
  // appears only when a real one needs finishing.
  const url = pathToFileURL(resolve(ROOT, fromRoot)).href
  return (new Function('specifier', 'return import(specifier)') as (s: string) => Promise<T>)(url)
}
