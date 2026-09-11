import {
  createPublicClient,
  decodeEventLog,
  encodeFunctionData,
  fallback,
  http,
  webSocket,
  type Log,
  type PublicClient,
  type WalletClient,
} from 'viem'
import type { AppConfig } from '../../config/env'
import { AEGYLAX_CONTRACT_ABI } from '../../config/deployment'
import { resolveActiveChain } from '../../config/networks'
import { isProtocolOwnedLobby } from '../../game/globalDefense'
import { buildWorld, sectorFromWorldPoint, type WorldGeometry } from '../../game/world'
import type {
  Address,
  Attack,
  AttackEpoch,
  AttackOutcome,
  AttackRevealData,
  DefenseAttempt,
  DefensePoint,
  GameStats,
  GlobalDefenseDraw,
  Hash,
  Lobby,
  LobbyReveal,
  Participant,
  ReconProbeRecord,
} from '../../game/types'
import { EventEmitter } from '../emitter'
import { describeRpcError, reportChainBlock, reportPrivacyDelay, reportRpcFailure } from '../protocolHealth'
import type {
  Block,
  BlockchainClient,
  ContractReadArgsMap,
  ContractReadFunctionName,
  ContractReadResultMap,
  ContractWriteArgsMap,
  ContractWriteFunctionName,
  EventLog,
  EventLogFilter,
  GameEventName,
  TransactionRecord,
  TxLifecycleStatus,
} from '../types'
import {
  ZERO_HASH,
  decodeChainParticipant,
  ethToWei,
  packDefensePoint,
  toActivityMap,
  toAttack,
  toDefenseAttempt,
  toDefenseResult,
  toLobby,
  toLobbyReveal,
  toOutcome,
  toParticipant,
  toTrajectory,
  weiToEth,
  type ChainAttack,
  type ChainDefenseAttempt,
  type ChainGameParams,
  type ChainLobby,
  type ChainLobbyConfig,
  type ChainOutcome,
  type ChainParticipant,
  type ChainTrajectory,
} from './codec'
import { accountAddressOf, createGateway, type AttestedValue, type ConfidentialGateway } from './confidential'
import { decodeProbeHint } from './recon'
import { flightProgress } from '../../game/attacks'
import { PROBE_DELAY_BLOCKS } from '../../game/recon'
import { shareJob } from '../../utils/shareJob'
import {
  addPendingProbe,
  ownPointKey,
  readOwnPoint,
  readPendingProbes,
  rememberUnlockedRound,
  removePendingProbe,
  wasRoundUnlocked,
  writeOwnPoint,
  writePendingProbes,
  type PendingProbe,
} from './ownSecrets'

/**
 * The real chain (ТЗ §10).
 *
 * Everything the UI knows comes from here: lobbies, players, fees, rewards,
 * probes, attack state, deadlines, defenses, the reveal, the winner and the
 * claims. There is no second source and no local simulation of any of it —
 * where the emulator interprets game rules in the browser, this client
 * reads the answers a contract already decided.
 *
 * Three things it does that a plain RPC wrapper would not, and each is a
 * requirement rather than a convenience:
 *
 *   - **it never derives hidden data.** A probe's answer arrives as a
 *     handle that only the probing wallet can open, and it is opened
 *     through the confidential network; the trajectory is not knowable here
 *     at all until the reveal has published it.
 *   - **it carries the reveal, rather than waiting for one.** Revealing is
 *     two chain transactions with an off-chain fetch between them; the UI
 *     asks for a reveal and this sequences it.
 *   - **it reports transactions as they actually go.** Every write moves
 *     through preparing → wallet confirmation → pending → confirmed or
 *     failed, and the state the UI shows is the state the chain is in.
 */
/** How hard a confirmed write insists on being visible to the read endpoint. */
const BLOCK_SYNC_ATTEMPTS = 12
const BLOCK_SYNC_POLL_MS = 250

/**
 * How long the transport gathers calls before flushing them as one request.
 *
 * A page like the Operation screen issues dozens of reads within a tick —
 * the lobby, its participants one by one, the attack, the trajectory, the
 * outcome — and a public endpoint counts every one of them. Everything below
 * is about making that number small enough that a shared RPC does not start
 * answering "over rate limit" (ТЗ §10):
 *
 *   - `batch.multicall` folds every `readContract` in the window into a
 *     single `multicall3` call, so N contract reads cost one request;
 *   - `batch.wait` on the HTTP transport packs whatever is left into one
 *     JSON-RPC batch;
 *   - the retry schedule below backs off instead of hammering, because a
 *     rate-limited endpoint answers a fast retry with another refusal.
 *
 * 16ms is roughly a frame: long enough that a render's worth of reads lands
 * in the same batch, short enough to be invisible.
 */
const RPC_BATCH_WAIT_MS = 16
/** Retries per request. Rate limits are transient, so they are worth waiting out. */
const RPC_RETRY_COUNT = 4
/** First backoff step; viem grows it exponentially from here. */
const RPC_RETRY_DELAY_MS = 400

/**
 * How far out from Earth an aimed sensor is placed, as a fraction of the
 * board's height. Far enough to be a different vantage point than the last
 * one, close enough to stay on the board for any legal bearing.
 */
const SENSOR_REACH_FRACTION = 0.7

/**
 * The order successive probes step through cells in — see `sensorCellFor`.
 *
 * A ring around the aim rather than a line: each step is a genuinely
 * different vantage point, and no two are the same cell.
 */
const SENSOR_WALK: ReadonlyArray<{ column: number; row: number }> = [
  { column: 0, row: 0 },
  { column: 1, row: 0 },
  { column: -1, row: 0 },
  { column: 0, row: 1 },
  { column: 0, row: -1 },
  { column: 1, row: 1 },
  { column: -1, row: -1 },
  { column: 1, row: -1 },
  { column: -1, row: 1 },
  { column: 2, row: 0 },
  { column: -2, row: 0 },
  { column: 0, row: 2 },
]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Whether `resolveLobby` has actually judged this operation.
 *
 * `getOutcome`'s own `revealed` flag answers a different question — it
 * reports the *epoch attack's* reveal, which is shared by every operation
 * playing that epoch and says nothing about whether this one's defenses
 * have been scored. `resolvedAtBlock` is the field `resolveLobby` writes,
 * and it is the only one that cannot be true before the scoring happened.
 */
function isOperationScored(outcome: ChainOutcome): boolean {
  return Number(outcome.resolvedAtBlock) > 0
}

/** Must match `AegylaxGame.MAX_SCORE_BATCH`. The contract is the authority. */
const MAX_SCORE_BATCH = 32

function asProof(entry: AttestedValue) {
  return { value: entry.value, signatures: entry.signatures }
}

/**
 * The read transport, over every endpoint this build was given.
 *
 * One endpoint is a single point of failure in the most literal way: a
 * public RPC answers a browser that reads on every block with `403` and no
 * CORS header, and from inside the page that is indistinguishable from the
 * protocol being empty — the lobby does not load, the countdown does not
 * move, and a control that depends on a read simply never becomes
 * pressable. Nothing in the app is wrong at that moment, and nothing in the
 * app can tell.
 *
 * So `VITE_RPC_URL` takes a *list*, and viem's `fallback` moves to the next
 * endpoint on a failure and ranks them by how they are actually behaving.
 * A single URL is the same code path with one entry, and an empty list
 * leaves the chain's own default in place, so nothing has to be configured
 * for this to be an improvement.
 */
function buildTransport(config: AppConfig) {
  // `config.rpcUrls` already ends with the manifest's own endpoint, so this
  // is the whole list in preference order.
  const transports = config.rpcUrls.map((url) =>
    /^wss?:\/\//i.test(url)
      ? webSocket(url, { retryCount: RPC_RETRY_COUNT, retryDelay: RPC_RETRY_DELAY_MS })
      : http(url, {
          batch: { wait: RPC_BATCH_WAIT_MS },
          retryCount: RPC_RETRY_COUNT,
          retryDelay: RPC_RETRY_DELAY_MS,
        }),
  )

  if (transports.length === 0) {
    return http(undefined, {
      batch: { wait: RPC_BATCH_WAIT_MS },
      retryCount: RPC_RETRY_COUNT,
      retryDelay: RPC_RETRY_DELAY_MS,
    })
  }
  if (transports.length === 1) return transports[0]

  /*
   * `rank` re-orders the list from measured latency and success rate, so an
   * endpoint that starts rate-limiting this browser stops being asked
   * first. It costs one sampling request per interval, which is why the
   * interval is generous.
   */
  return fallback(transports, { rank: { interval: 30_000, sampleCount: 3 } })
}

export class ContractBlockchainClient implements BlockchainClient {
  readonly mode = 'contract' as const

  private readonly publicClient: PublicClient | null
  private readonly address: Address | null
  private readonly world: WorldGeometry
  private readonly blockTimeMs: number
  private readonly deploymentBlock: bigint
  private walletClient: WalletClient | null = null
  private gateway: ConfidentialGateway | null = null
  private params: ChainGameParams | null = null

  private readonly events = new EventEmitter<GameEventName | 'all', EventLog>()
  private readonly blocks = new EventEmitter<'block', number>()
  private readonly transactions = new Map<Hash, TransactionRecord>()
  private eventWatcher: (() => void) | null = null
  private blockWatcher: (() => void) | null = null

  /**
   * A player's own Defense Point, remembered locally.
   *
   * The protocol will not hand a coordinate back before the reveal — not
   * even to the wallet that submitted it — so a defender's own marker has
   * to survive a reload some other way. This is the honest version of that:
   * the client keeps what *this browser* chose, and nothing about anybody
   * else's choice, which is the same thing the emulator achieved by
   * resealing a point to its owner.
   *
   * The in-memory map is a cache in front of `localStorage`, not the record
   * itself. As a `Map` alone it died with the tab, which made the marker a
   * lie by omission: a defender who reloaded — or who switched wallet and
   * switched back — saw an empty map, no pin, and a Defend control their
   * own submitted attempt had already locked. The point was on chain the
   * whole time, sealed; the only thing missing was this browser's copy of
   * what it had chosen.
   */
  private readonly ownDefensePoints = new Map<string, DefensePoint>()

  /** The account the confidential gateway's session currently belongs to. */
  private walletAddress: Address | null = null

  /**
   * A staged Defense Point, already encrypted, waiting for Defend.
   *
   * Encrypting a coordinate is the slowest thing this client does — a WASM
   * proof over an FHE public key and a CRS, then a round trip to the
   * network's verifier — and it used to happen *after* the player pressed
   * the button, which put seconds of silence between the click and the
   * wallet opening. That silence is the worst place to spend them: the
   * threat is in flight, the submit block is the bet, and a player who
   * cannot tell whether the click registered clicks again.
   *
   * So the encryption is started when the point is placed instead, and this
   * holds the promise until the point is sent. Keyed by wallet and packed
   * coordinate: moving the marker abandons the old blob (nothing on chain
   * ever saw it) and starts the new one, and a stale entry can never be
   * submitted as if it were the point on screen.
   */
  private preparedDefense: { key: string; ciphertext: Promise<`0x${string}`> } | null = null
  /** The point being encrypted right now, so a second one waits rather than races it. */
  private preparingKey: string | null = null
  /** The most recent point that arrived while one was already being encrypted. */
  private queuedDefense: { from: Address; defensePoint: DefensePoint } | null = null

  /**
   * Operations whose `unlockRound` already confirmed in this tab.
   *
   * The reveal is two transactions with a wait between them. A failed wait
   * used to send `unlockRound` again — a no-op on chain that still opened
   * the wallet — and the keeper retried that every twelve seconds. Remembering
   * the unlock here makes every retry a free fetch plus, if it succeeds, the
   * one scoring transaction that was always the remaining work.
   */
  private readonly unlockedRounds = new Set<string>()

  /**
   * Reveals currently in flight, keyed by lobby.
   *
   * `unlockRound` is only marked done *after* it confirms, so two callers
   * that both passed the check — the keeper and a click, or StrictMode's
   * remount — each sent it, then one of them sent `revealAndResolve`: three
   * wallet prompts for a two-transaction protocol. Sharing the promise
   * makes the second wait for the first.
   */
  private readonly revealJobs = new Map<string, Promise<TransactionRecord>>()

  /** `unlockRound` in flight, so a parallel reveal does not prompt for it twice. */
  private readonly unlockJobs = new Map<string, Promise<void>>()

  /**
   * `collectProbe` in flight, keyed by hint handle.
   *
   * Opening a pending probe is on the per-block poller. Without this, a
   * signature sitting in the wallet plus the next block each sent their own
   * `collectProbe` — two prompts to grant one hint.
   */
  private readonly collectJobs = new Map<string, Promise<void>>()

  /** The whole open-pending sequence, so a queued block tick joins rather than restarts. */
  private readonly openPendingJobs = new Map<string, Promise<ReconProbeRecord[]>>()

  constructor(private readonly config: AppConfig) {
    const chain = resolveActiveChain(config)
    const transport = buildTransport(config)
    this.publicClient = chain
      ? (createPublicClient({
          chain,
          transport,
          // See RPC_BATCH_WAIT_MS: this is what turns a screenful of
          // contract reads into one `multicall3` request.
          batch: { multicall: { wait: RPC_BATCH_WAIT_MS } },
          /*
           * Block polling drives every live figure on the page, and left at
           * viem's 4s default it is both the app's single busiest caller and
           * out of step with the chain. Matching it to the block time asks
           * the endpoint once per block, which is as often as there is
           * anything new to learn.
           */
          pollingInterval: Math.max(1_000, config.blockTimeMs),
        }) as PublicClient)
      : null
    this.address = config.deployment.address
    this.blockTimeMs = config.blockTimeMs
    this.deploymentBlock = BigInt(config.deployment.deploymentBlock)
    this.world = buildWorld(
      { columns: config.map.columns, rows: config.map.rows },
      config.protocol.sectorSpanKm,
    )
  }

  /**
   * The wallet is attached after construction because the client outlives
   * any particular connection: a visitor reads an operation before
   * connecting, and connects when they decide to play.
   */
  setWalletClient(wallet: WalletClient | null): void {
    this.walletClient = wallet

    /*
     * A different *account* is a different set of secrets. The gateway holds
     * an in-memory voucher and a flag that stands the session path down
     * after a refusal; both must not follow the player onto the next wallet.
     *
     * A reconnect of the *same* account — Privy restoring, a flicker through
     * `null` — must not reset. Reset used to wipe `sessionStorage` too, so
     * every lobby reload asked for Inco's leak-warning signature again.
     * Detach keeps the stored voucher; only a real switch drops memory.
     */
    const next = accountAddressOf(wallet) ?? null
    const prev = this.walletAddress
    if (next && prev && next.toLowerCase() !== prev.toLowerCase()) {
      this.gateway?.reset?.()
    }
    this.walletAddress = next
  }

  // -----------------------------------------------------------------
  // Chain primitives
  // -----------------------------------------------------------------

  async getBlockNumber(): Promise<number> {
    return Number(await this.client().getBlockNumber())
  }

  async getBlock(blockNumber?: number): Promise<Block> {
    const block = await this.client().getBlock(
      blockNumber !== undefined ? { blockNumber: BigInt(blockNumber) } : undefined,
    )
    return {
      number: Number(block.number),
      hash: block.hash,
      timestamp: Number(block.timestamp) * 1000,
      parentHash: block.parentHash,
    }
  }

  async getBalance(address: Address): Promise<number> {
    return weiToEth(await this.client().getBalance({ address }))
  }

  // -----------------------------------------------------------------
  // Reads
  // -----------------------------------------------------------------

  async readContract<TFn extends ContractReadFunctionName>(
    functionName: TFn,
    args: ContractReadArgsMap[TFn],
  ): Promise<ContractReadResultMap[TFn]> {
    switch (functionName) {
      case 'getGameStats':
        return (await this.readStats()) as ContractReadResultMap[TFn]
      case 'getLobby':
        return (await this.readLobby((args as ContractReadArgsMap['getLobby']).lobbyId)) as ContractReadResultMap[TFn]
      case 'getLobbyParticipants': {
        const typed = args as ContractReadArgsMap['getLobbyParticipants']
        return (await this.readParticipants(typed.lobbyId, typed.viewer)) as ContractReadResultMap[TFn]
      }
      case 'getParticipant': {
        const typed = args as ContractReadArgsMap['getParticipant']
        const all = await this.readParticipants(typed.lobbyId, typed.viewer)
        return (all.find((participant) => participant.address.toLowerCase() === typed.address.toLowerCase()) ??
          null) as ContractReadResultMap[TFn]
      }
      case 'getAttack': {
        const typed = args as ContractReadArgsMap['getAttack']
        return (await this.readAttack(typed.attackId as Hash, typed.lobbyId)) as ContractReadResultMap[TFn]
      }
      case 'getAttackReveal': {
        const typed = args as ContractReadArgsMap['getAttackReveal']
        return (await this.readReveal(typed.lobbyId, typed.attackId as Hash)) as ContractReadResultMap[TFn]
      }
      case 'getDefenseAttempts': {
        const typed = args as ContractReadArgsMap['getDefenseAttempts']
        return (await this.readAttempts(typed.lobbyId, typed.attackId as Hash, typed.viewer)) as ContractReadResultMap[TFn]
      }
      case 'getActivityMap': {
        const typed = args as ContractReadArgsMap['getActivityMap']
        const attempts = await this.readAttempts(typed.lobbyId, typed.attackId as Hash, null)
        return toActivityMap(attempts, this.config.map.columns, this.config.map.rows) as ContractReadResultMap[TFn]
      }
      case 'getAttackEpoch': {
        const typed = args as ContractReadArgsMap['getAttackEpoch']
        return (await this.readEpoch(typed.lobbyId, typed.epochId)) as ContractReadResultMap[TFn]
      }
      case 'getSealingKey':
        // The contract deployment has no symmetric protocol key: privacy is
        // the confidential network's, and the frontend holds no half of it.
        throw new Error('getSealingKey has no meaning in contract mode — confidentiality is provided by Inco.')
      case 'getGlobalDefenseDraw':
        return (await this.readDraw()) as ContractReadResultMap[TFn]
      default:
        throw new Error(`Unsupported read "${String(functionName)}"`)
    }
  }

  private async readParams(): Promise<ChainGameParams> {
    if (!this.params) {
      const [params] = (await this.call('getParams', [])) as [ChainGameParams, number]
      this.params = params
    }
    return this.params
  }

  private async readStats(): Promise<GameStats> {
    const [[totalLobbies, activeLobbies, totalAttacks, intercepted, missed, epoch], draw] = await Promise.all([
      this.call('getStats', []) as Promise<[bigint, bigint, bigint, bigint, bigint, bigint, bigint]>,
      this.readDraw(),
    ])

    return {
      activeLobbies: Number(activeLobbies),
      totalLobbies: Number(totalLobbies),
      totalAttacks: Number(totalAttacks),
      interceptedAttacks: Number(intercepted),
      missedAttacks: Number(missed),
      currentBlock: await this.getBlockNumber(),
      currentEpoch: Number(epoch),
      globalDefensePool: draw.pool,
      globalDefenseLobbyId: draw.lobbyId,
    }
  }

  private async readDraw(): Promise<GlobalDefenseDraw> {
    const result = (await this.call('getGlobalDefenseDraw', [])) as
      | [bigint | number, bigint | number, bigint, Hash]
      | { nextEpoch: bigint | number; interval: bigint | number; pool: bigint; lobbyId: Hash }
    const nextEpoch = Number(Array.isArray(result) ? result[0] : result.nextEpoch)
    const interval = Number(Array.isArray(result) ? result[1] : result.interval)
    const pool = Array.isArray(result) ? result[2] : result.pool
    const lobbyId = Array.isArray(result) ? result[3] : result.lobbyId
    return {
      nextEpoch,
      interval,
      pool: weiToEth(pool),
      lobbyId: !lobbyId || lobbyId === ZERO_HASH ? null : lobbyId,
    }
  }

  private async readLobbyRaw(lobbyId: Hash) {
    return (await this.call('getLobby', [lobbyId])) as [ChainLobby, ChainLobbyConfig, ChainGameParams]
  }

  private async readLobby(lobbyId: Hash): Promise<Lobby | null> {
    const [lobby, config, params] = await this.readLobbyRaw(lobbyId)
    if (lobby.status === 0) return null

    const participants = (await this.call('getParticipants', [lobbyId])) as Address[]

    let reveal: LobbyReveal | null = null
    let outcome: AttackOutcome | null = null
    if (lobby.attackId !== ZERO_HASH) {
      // The trajectory is the *epoch's*, so it is keyed by the attack; the
      // outcome is this *team's*, so it is keyed by the lobby. Reading the
      // second one by attack id — as this used to — asks about a lobby that
      // does not exist and gets a zeroed struct back, which is why a
      // resolved operation showed no winner and no reward.
      const [isRevealed, trajectory] = (await this.call('getTrajectory', [lobby.attackId])) as [boolean, ChainTrajectory]
      if (isRevealed) {
        const [, chainOutcome] = (await this.call('getOutcome', [lobbyId])) as [boolean, ChainOutcome]
        // The epoch's geometry being public does not mean *this* team has
        // been scored — see `isOperationScored`. An unscored operation has
        // no outcome to report, and reporting the zeroed struct as one is
        // how a live operation came to announce that everybody missed.
        if (isOperationScored(chainOutcome)) {
          const [attack] = (await this.call('getAttack', [lobby.attackId])) as [ChainAttack, number]
          reveal = toLobbyReveal(lobby.attackId, toTrajectory(trajectory), chainOutcome)
          outcome = toOutcome(lobby.attackId, chainOutcome, attack.flightBlocks, Number(attack.launchBlock))
        }
      }
    }

    /*
     * Recon terms overlay the live protocol params: `buyProbes` charges
     * `$.params`, not this operation's frozen snapshot. Attack geometry
     * still comes from `params` below — that *is* what the team is playing
     * under.
     */
    const liveParams = await this.readParams()
    return this.withDrawBounty(toLobby(lobby, config, params, participants, reveal, outcome, liveParams))
  }

  /**
   * The jackpot a protocol draw is playing for, which the lobby itself does
   * not hold.
   *
   * `openGlobalDefense` mints the room with `startPrizePool: 0` and leaves
   * every wei in `globalDefensePool` — `topUpDraw` explicitly refuses to
   * move it into an OPEN draw — so the lobby reads 0 for the whole
   * application window. `commitDrawBounty` escrows it at activation, and
   * from then on the lobby's own figure is the whole of it; hence the
   * pre-launch guard rather than an unconditional add.
   *
   * One extra read, only for protocol-owned rooms. A failed one leaves the
   * lobby as it was rather than blanking the screen: `drawPrizePool` treats
   * a missing bounty as "nothing to fold in".
   */
  private async withDrawBounty(lobby: Lobby): Promise<Lobby> {
    if (!isProtocolOwnedLobby(lobby.creator, this.address)) return lobby
    if (lobby.status !== 'CREATED' && lobby.status !== 'OPEN' && lobby.status !== 'READY') return lobby
    try {
      const draw = await this.readDraw()
      return { ...lobby, drawBounty: draw.pool }
    } catch {
      return lobby
    }
  }

  /**
   * One page of operations, newest last in the contract's array.
   *
   * The directory prefers the backend index — one request, already filtered.
   * This is what the page falls back to when that index is not running: ids
   * from `getLobbyIds`, then one `getLobby` each, without the extra reads
   * an Operation screen needs (participants, trajectory, outcome). Sixty
   * rooms is the same ceiling the indexer uses; past it, the newest sixty.
   */
  async listDirectoryPage(
    offset: number,
    limit: number,
    includeMembers = false,
  ): Promise<{ lobbies: Lobby[]; total: number }> {
    const [page, total] = (await this.call('getLobbyIds', [BigInt(offset), BigInt(limit)])) as [
      Hash[],
      bigint,
    ]
    const liveParams = await this.readParams()
    const lobbies = await Promise.all(
      page.map(async (id) => {
        const [lobby, config, params] = await this.readLobbyRaw(id)
        if (lobby.status === 0) return null
        const members = includeMembers ? ((await this.call('getParticipants', [id])) as Address[]) : []
        return this.withDrawBounty(toLobby(lobby, config, params, members, null, null, liveParams))
      }),
    )
    return {
      lobbies: lobbies.filter((row): row is Lobby => row !== null),
      total: Number(total),
    }
  }

  private async readParticipants(lobbyId: Hash, viewer: Address | null): Promise<Participant[]> {
    const [lobby] = await this.readLobbyRaw(lobbyId)
    if (lobby.status === 0) return []

    /*
     * The probe allowance a participant is judged against is the protocol's
     * live one, not the operation's frozen snapshot — `buyProbes` reads
     * `$.params` on purpose, so that two teams facing the same epoch's
     * threat buy knowledge of it at the same price (ТЗ §3).
     */
    const params = await this.readParams()
    const addresses = (await this.call('getParticipants', [lobbyId])) as Address[]
    const revealed =
      lobby.attackId !== ZERO_HASH
        ? ((await this.call('getTrajectory', [lobby.attackId])) as [boolean, ChainTrajectory])[0]
        : false

    /*
     * Who won lives on the defense attempts, not on the participants — the
     * reveal writes `isWinner` onto the attempt it resolved. Reading them
     * here is what lets a participant record say "you are owed a reward",
     * which is the difference between a winner seeing a Claim control and a
     * winner seeing nothing at all.
     */
    const winners = new Set<string>()
    if (revealed) {
      // Attempts belong to the team, so they are keyed by the lobby.
      const attempts = (await this.call('getDefenseAttempts', [lobbyId])) as ChainDefenseAttempt[]
      for (const attempt of attempts) {
        if (attempt.isWinner) winners.add(attempt.participant.toLowerCase())
      }
    }

    const records = await Promise.all(
      addresses.map(async (address) => {
        const participant = await this.readParticipant(lobbyId, address)
        const isViewer = viewer !== null && viewer.toLowerCase() === address.toLowerCase()
        return toParticipant(lobbyId, address, participant, params, revealed, isViewer, winners.has(address.toLowerCase()))
      }),
    )
    return records
  }

  private async readAttack(attackId: Hash, lobbyId: Hash): Promise<Attack | null> {
    if (!attackId || attackId === ZERO_HASH) return null
    const [attack, derivedStatus] = (await this.call('getAttack', [attackId])) as [ChainAttack, number]
    if (attack.id === ZERO_HASH) return null

    const block = await this.getBlock()
    return toAttack(
      attack,
      derivedStatus,
      this.blockTimeMs,
      { blockNumber: block.number, timestamp: block.timestamp },
      lobbyId,
    )
  }

  /**
   * The epoch an operation's attack belongs to.
   *
   * Derived rather than stored: the protocol's epochs are a function of the
   * block number and the epoch length, so there is nothing for a contract to
   * remember and nothing that can disagree.
   */
  private async readEpoch(lobbyId: Hash, epochId: number): Promise<AttackEpoch | null> {
    const [lobby, , params] = await this.readLobbyRaw(lobbyId)
    if (lobby.status === 0 || lobby.attackId === ZERO_HASH) return null

    const [attack] = (await this.call('getAttack', [lobby.attackId])) as [ChainAttack, number]
    return {
      lobbyId,
      epochId,
      startBlock: Number(attack.launchBlock),
      endBlock: Number(attack.launchBlock) + params.epochBlocks - 1,
      // The seed is confidential by construction: the attack's randomness
      // lives inside the confidential network, not in a published value.
      seed: attack.bearingHandle,
      attackIds: [lobby.attackId],
    }
  }

  /**
   * One team's defenses.
   *
   * Keyed by the operation, because that is how the protocol stores them:
   * every team playing an epoch aims at the same threat but is scored on its
   * own defenders and paid out of its own pool, so a single attack-keyed
   * list would merge every team in the epoch into one contest. Asking
   * `getDefenseAttempts` for an attack id — which is what this used to do —
   * simply returned an empty array, so a submitted defense never came back
   * and the Command Center kept offering the button that had just been used.
   */
  private async readAttempts(lobbyId: Hash, attackId: Hash, viewer: Address | null): Promise<DefenseAttempt[]> {
    if (!attackId || attackId === ZERO_HASH) return []
    const raw = (await this.call('getDefenseAttempts', [lobbyId])) as ChainDefenseAttempt[]

    return raw.map((attempt, index) => {
      const mapped = toDefenseAttempt(lobbyId, attackId, index, attempt, this.world)
      if (mapped.defensePoint || !viewer) return mapped
      // Before the reveal the chain has no coordinate to give; this
      // browser's own choice is the one thing it may legitimately redraw.
      if (viewer.toLowerCase() !== attempt.participant.toLowerCase()) return mapped
      const remembered = this.rememberedPoint(attackId, viewer)
      return remembered ? { ...mapped, defensePoint: remembered } : mapped
    })
  }

  private async readReveal(lobbyId: Hash, attackId: Hash): Promise<AttackRevealData | null> {
    if (!attackId || attackId === ZERO_HASH) return null

    const [isRevealed, trajectory] = (await this.call('getTrajectory', [attackId])) as [boolean, ChainTrajectory]
    if (!isRevealed) return null

    // Trajectory by attack (the epoch's), outcome and attempts by lobby
    // (this team's) — see `readAttempts`.
    const [, chainOutcome] = (await this.call('getOutcome', [lobbyId])) as [boolean, ChainOutcome]

    /*
     * The epoch is revealed; this team may not be — and the two are answered
     * separately rather than folded together.
     *
     * This used to return `null` outright when the operation had no outcome
     * yet, which was the right call against the alternative it replaced (that
     * one announced TARGET REACHED, everybody MISS, 0 km off, off a zeroed
     * struct, for a round the protocol had not scored). But it threw the
     * trajectory away with the verdict, and the trajectory is exactly the part
     * that is already public: `revealEpochAttack` is one transaction for the
     * whole world, and from the block it lands in, `getTrajectory` answers for
     * every operation on that epoch at once. Refusing to draw it until this
     * particular team's scoring transaction confirmed meant the screen sat
     * empty — sealed sky, no flight path, "RESULT SEALED" — while the data it
     * was waiting for was sitting on chain, readable by anybody, sometimes for
     * minutes.
     *
     * So an unscored operation now gets its geometry and an honest `scored:
     * false`. Consumers that draw the flight path use it immediately; the ones
     * that announce a verdict, and `canRevealAttack`, branch on the flag. That
     * also keeps the property the old guard was protecting: a second team on
     * the same epoch still sees its Reveal control, because what that control
     * finishes is *its own scoring*, not the publication.
     */
    const scored = isOperationScored(chainOutcome)
    const [attack] = (await this.call('getAttack', [attackId])) as [ChainAttack, number]
    const raw = (await this.call('getDefenseAttempts', [lobbyId])) as ChainDefenseAttempt[]

    const outcome = toOutcome(attackId, chainOutcome, attack.flightBlocks, Number(attack.launchBlock))
    const attempts = raw.map((attempt, index) => toDefenseAttempt(lobbyId, attackId, index, attempt, this.world))
    const results = raw.map((attempt, index) =>
      toDefenseResult(
        `${lobbyId}-d${index}`,
        attempt,
        Number(attack.launchBlock),
        attack.flightBlocks,
        outcome.interceptionRadiusKm,
        toTrajectory(trajectory),
      ),
    )

    return {
      attackId,
      trajectory: toTrajectory(trajectory),
      outcome,
      attempts,
      results,
      revealedAtBlock: Number(chainOutcome.resolvedAtBlock),
      launchBlock: Number(attack.launchBlock),
      flightDurationBlocks: attack.flightBlocks,
      scored,
    }
  }

  // -----------------------------------------------------------------
  // Writes
  // -----------------------------------------------------------------

  async writeContract<TFn extends ContractWriteFunctionName>(
    functionName: TFn,
    args: ContractWriteArgsMap[TFn],
    from: Address,
  ): Promise<TransactionRecord> {
    switch (functionName) {
      case 'createLobby': {
        const typed = args as ContractWriteArgsMap['createLobby']
        /*
         * The bounty *and* the protocol's creation fee (ТЗ §17).
         *
         * The fee is charged once, at mint, so `createLobby` demands
         * `startPrizePool + protocolJoinFee` to the wei. It is read off the
         * chain's live params rather than taken from `appConfig`, for the
         * same reason `joinLobby` does: the contract compares integers, and
         * an ETH float that has been through wei -> ETH -> wei is not
         * guaranteed to land back on the one the protocol is holding.
         */
        const [params] = (await this.call('getParams', [])) as [ChainGameParams, number]
        const record = await this.send(
          functionName,
          'createLobby',
          [toChainLobbyConfig(typed.config)],
          from,
          ethToWei(typed.config.economics.prizePool) + params.protocolJoinFee,
          args,
        )
        // The chain's own LobbyCreated log carries the id; the config is
        // added here because this session is the one that submitted it.
        const created = record.events.find((event) => event.name === 'LobbyCreated')
        if (created) {
          ;(created.payload as { config?: unknown }).config = typed.config
        }
        return record
      }
      case 'joinLobby': {
        const typed = args as ContractWriteArgsMap['joinLobby']
        // The amount is taken from the chain's own numbers rather than from
        // the ETH figure the UI computed. The contract requires an exact
        // payment to the wei, and a float that has been through
        // wei -> ETH -> wei is not guaranteed to land back on the same
        // integer for every price a creator could set.
        const [, config] = await this.readLobbyRaw(typed.lobbyId)
        const commission = (config.entryPrice * BigInt(config.creatorFeeBps)) / 10_000n
        return this.send(
          functionName,
          'joinLobby',
          [typed.lobbyId],
          from,
          config.entryPrice + commission,
          args,
        )
      }
      case 'leaveLobby': {
        const typed = args as ContractWriteArgsMap['leaveLobby']
        return this.send(functionName, 'leaveLobby', [typed.lobbyId], from, 0n, args)
      }
      case 'buyDrone': {
        const typed = args as ContractWriteArgsMap['buyDrone']
        /*
         * Same reasoning as joining: the price the contract will check is
         * the one it holds, so that is the one that gets paid. It comes from
         * the *live* protocol params rather than the operation's frozen
         * snapshot, because `buyProbes` prices recon off `$.params` — an
         * operation created under an older, cheaper regime must not be able
         * to resell the epoch's intelligence at its own old price.
         *
         * Read fresh rather than from the cached copy: a governed price
         * change between page load and purchase would otherwise send the
         * wrong value and revert on `IncorrectPayment`.
         */
        const [params] = (await this.call('getParams', [])) as [ChainGameParams, number]
        this.params = params
        return this.send(functionName, 'buyProbes', [typed.lobbyId, 1], from, params.probePrice, args)
      }
      case 'claimReward': {
        const typed = args as ContractWriteArgsMap['claimReward']
        return this.send(functionName, 'claimReward', [typed.lobbyId], from, 0n, args)
      }
      case 'claimRefund': {
        const typed = args as ContractWriteArgsMap['claimRefund']
        return this.send(functionName, 'claimRefund', [typed.lobbyId], from, 0n, args)
      }
      case 'settleCreator': {
        const typed = args as ContractWriteArgsMap['settleCreator']
        return this.send(functionName, 'settleCreator', [typed.lobbyId], from, 0n, args)
      }
      case 'openGlobalDefense':
        return this.send(functionName, 'openGlobalDefense', [], from, 0n, args)
      case 'collectProbe': {
        const typed = args as ContractWriteArgsMap['collectProbe']
        return this.send(functionName, 'collectProbe', [typed.hintHandle], from, 0n, args)
      }
      case 'revealAttack': {
        const typed = args as ContractWriteArgsMap['revealAttack']
        return shareJob(this.revealJobs, typed.lobbyId, () =>
          this.performReveal(typed.lobbyId, typed.attackId as Hash, from, args),
        )
      }
      case 'submitPrivateAction':
        throw new Error(
          'submitPrivateAction is the emulator\'s sealed-envelope call. On chain, use sendReconProbe / submitDefense.',
        )
      default:
        throw new Error(`Unsupported write "${String(functionName)}"`)
    }
  }

  /**
   * Send Recon Probe.
   *
   * The transaction says only that a probe happened. What it answered comes
   * back as a handle on the log, and opening it takes this wallet's own
   * signature — so the result reaches the player who paid for it and nobody
   * else, including this code running in somebody else's tab.
   */
  async sendReconProbe(
    from: Address,
    params: { lobbyId: Hash; attackId: string; probeId: string; aimDegrees?: number | null },
  ): Promise<{ tx: TransactionRecord; probe: ReconProbeRecord | null }> {
    /*
     * The reading session, started now rather than after the receipt.
     *
     * Opening a hint needs this tab to hold an authorisation from the
     * player, and one is granted lazily inside `decryptForOwner` when it is
     * missing — which put a wallet prompt *after* the transaction confirmed,
     * in series with everything else the read waits on. A player who just
     * pressed Send Probe is asking for exactly this, so it starts here and
     * overlaps the signature they are about to give anyway. Not awaited: a
     * declined or unavailable session is `decryptForOwner`'s problem, and
     * `session` shares the grant rather than prompting twice.
     */
    void this.ensureConfidentialReads(from)

    const chainParams = await this.readParams()
    /*
     * Where the sensor stands is the whole of a probe's input (ТЗ §5), and
     * the call used to omit it entirely — `sendProbe` takes a cell, so the
     * transaction never encoded and the scan never happened.
     */
    const sensor = await this.sensorCellFor(params.lobbyId, from, params.aimDegrees ?? null, chainParams)

    const tx = await this.send(
      'submitPrivateAction',
      'sendProbe',
      [params.lobbyId, sensor.column, sensor.row],
      from,
      0n,
      params,
    )

    const event = tx.events.find((log) => log.name === 'ProbeSent')
    if (!event) return { tx, probe: null }

    const payload = event.payload as { hintHandle: Hash; probeIndex: number; readableAtBlock?: number }
    const sentBlock = tx.blockNumber ?? 0
    const pending: PendingProbe = {
      handle: payload.hintHandle,
      probeIndex: payload.probeIndex,
      lobbyId: params.lobbyId,
      attackId: params.attackId,
      probeId: params.probeId,
      requestedBy: from,
      txHash: tx.hash,
      generatedAtBlock: sentBlock,
      readableAtBlock: Number(payload.readableAtBlock ?? sentBlock + PROBE_DELAY_BLOCKS),
    }
    /*
     * Written *before* the read. The transaction is mined: the probe is
     * spent, the handle is this wallet's. If the confidential network then
     * hangs or the tab closes, the next visit can open the same handle for
     * free instead of showing an empty map over a consumed allowance.
     */
    addPendingProbe(pending)

    if (!readableOnArrival(pending)) {
      // An older engine: the hint is granted a delay after the send, so
      // there is nothing to open yet. The handle is saved;
      // `resolvePendingProbes` opens it once DELAY_BLOCKS have passed,
      // without asking the wallet to collect a probe the contract refuses.
      const now = await this.getBlockNumber()
      if (now < pending.readableAtBlock) return { tx, probe: null }
    }

    try {
      const probe = await this.openProbe(pending, chainParams, from)
      removePendingProbe(params.lobbyId, params.attackId as Hash, from, pending.handle)
      return { tx, probe }
    } catch (err) {
      if (isProbeInFlight(err)) return { tx, probe: null }
      throw err
    }
  }

  /**
   * Where this probe's sensor stands.
   *
   * A probe does not choose a sector to look at — it scans everything, and
   * what changes is where it stands (ТЗ §5). The contract keys the reading
   * off `keccak256(column, row)`, so the cell is not a label: it *is* the
   * probe's input, and two probes from the same cell get the same answer
   * back. That is the anti-Sybil property, and it is why this walks the
   * board instead of standing still.
   *
   * The aim decides the neighbourhood and the probe index decides the step
   * within it, so a player who has found the threat keeps sampling near it
   * while still getting an independent reading each time. Offsets wrap
   * rather than clamp: wrapping is a bijection on the grid, so distinct
   * indices are guaranteed distinct cells, where clamping would quietly
   * collapse two probes onto one board edge and hand back a duplicate
   * reading the player had already paid for.
   *
   * Past `SENSOR_WALK.length` the walk repeats, and so do the readings —
   * which is the protocol's own rule rather than a limitation here: a finite
   * lattice is what makes the total knowledge an epoch can yield finite.
   */
  private async sensorCellFor(
    lobbyId: Hash,
    from: Address,
    aimDegrees: number | null,
    params: ChainGameParams,
  ): Promise<{ column: number; row: number }> {
    const columns = Math.max(1, params.gridColumns)
    const rows = Math.max(1, params.gridRows)

    const participant = await this.readParticipant(lobbyId, from)
    const index = participant.probesUsed

    const world = buildWorld({ columns, rows }, params.sectorSpanKm)
    let base = { column: Math.floor(columns / 2), row: Math.floor(rows / 2) }

    if (aimDegrees !== null && Number.isFinite(aimDegrees)) {
      // The fix is a bearing measured at Earth, so the sensor goes out
      // along it — standing where the threat is thought to be coming from.
      const bearing = (aimDegrees * Math.PI) / 180
      const reach = world.heightKm * SENSOR_REACH_FRACTION
      base = sectorFromWorldPoint(
        {
          x: world.earth.center.x + Math.cos(bearing) * reach,
          y: world.earth.center.y + Math.sin(bearing) * reach,
        },
        world,
      )
    }

    const step = SENSOR_WALK[index % SENSOR_WALK.length]
    return {
      column: (((base.column + step.column) % columns) + columns) % columns,
      row: (((base.row + step.row) % rows) + rows) % rows,
    }
  }

  /**
   * Encrypt a Defense Point the player has staged but not yet sent.
   *
   * Called from the map as the marker is placed. It buys nothing on chain
   * and commits the player to nothing — a point that is moved, or never
   * sent, costs one abandoned ciphertext — and it is what makes Defend
   * open the wallet at once instead of after the proof. Failures are
   * swallowed here on purpose: this is speculative work, and the click
   * that follows will encrypt again and report the error itself.
   *
   * **One at a time, newest wins.** A proof is seconds of CPU and the
   * worker runs them in the order they arrive, so a player nudging the
   * marker four times could put the point they actually meant to send at
   * the back of a queue of three dead ones — the exact opposite of what
   * this is for. A request that arrives while one is running replaces
   * whatever else was waiting, and only it is started when the running one
   * is done.
   */
  async prepareDefense(from: Address, defensePoint: DefensePoint): Promise<void> {
    if (this.preparedDefense?.key === this.defenseKey(from, defensePoint)) return
    if (this.preparingKey !== null) {
      this.queuedDefense = { from, defensePoint }
      return
    }
    try {
      await this.encryptDefensePoint(from, defensePoint)
    } catch {
      // Left for `submitDefense`, which is the call a player is watching.
    }
  }

  /**
   * This wallet's ciphertext for this point — the prepared one when there
   * is one, a fresh one otherwise.
   *
   * A rejected promise is dropped rather than remembered: caching it would
   * hand the same failure to every later attempt without ever retrying,
   * which would turn one bad network moment into a Defense that can never
   * be sent.
   */
  private encryptDefensePoint(from: Address, defensePoint: DefensePoint): Promise<`0x${string}`> {
    const key = this.defenseKey(from, defensePoint)
    if (this.preparedDefense?.key === key) return this.preparedDefense.ciphertext

    const ciphertext = this.confidential().encrypt(packDefensePoint(defensePoint, this.world), from)
    this.preparedDefense = { key, ciphertext }
    this.preparingKey = key
    void ciphertext
      .catch(() => {
        if (this.preparedDefense?.key === key) this.preparedDefense = null
      })
      .finally(() => {
        if (this.preparingKey === key) this.preparingKey = null
        this.drainQueuedDefense()
      })
    return ciphertext
  }

  /** The one point still worth preparing, once the thread is free again. */
  private drainQueuedDefense(): void {
    const next = this.queuedDefense
    this.queuedDefense = null
    if (!next || this.preparingKey !== null) return
    void this.prepareDefense(next.from, next.defensePoint)
  }

  private defenseKey(from: Address, defensePoint: DefensePoint): string {
    return `${from.toLowerCase()}:${packDefensePoint(defensePoint, this.world).toString()}`
  }

  /**
   * Send Defense.
   *
   * The coordinate is encrypted in this tab, against the confidential
   * engine's address, before the transaction is built. What the contract
   * receives is a ciphertext, what it stores is a handle, and what any
   * observer sees is that a defense was submitted.
   */
  async submitDefense(
    from: Address,
    params: { lobbyId: Hash; attackId: string; defensePoint: DefensePoint },
  ): Promise<{ tx: TransactionRecord; attempt: DefenseAttempt | null; defensePoint: DefensePoint | null }> {
    // Usually already done: `prepareDefense` starts this when the point is
    // placed, and this awaits the blob rather than making one.
    const ciphertext = await this.encryptDefensePoint(from, params.defensePoint)

    const tx = await this.send('submitPrivateAction', 'submitDefense', [params.lobbyId, ciphertext], from, 0n, params)
    // Sent: this blob has been spent, and the next Defense is a new point.
    this.preparedDefense = null

    this.rememberPoint(params.attackId as Hash, from, params.defensePoint)

    const attempts = await this.readAttempts(params.lobbyId, params.attackId as Hash, from)
    const attempt = attempts.find((entry) => entry.participant.toLowerCase() === from.toLowerCase()) ?? null
    return { tx, attempt, defensePoint: params.defensePoint }
  }

  /**
   * Reveal, end to end (ТЗ §3) — two transactions for a room that fits in
   * one scoring batch, more only when the team itself is larger.
   *
   * `unlockRound` lands the attack and unlocks θ, δ and the one-time pad
   * `K`. Defense Points are not in that unlock: each one published its pad
   * `M = P + K` at submit, already globally readable. Fetching the three
   * epoch handles plus every `M` is therefore O(1) ACL work on chain and
   * O(n) decrypts off chain, which is the cheap half.
   *
   * `revealAndResolve` publishes the geometry and, when the team fits in
   * `MAX_SCORE_BATCH`, scores it. Larger rooms publish with an empty
   * defense list — the map is drawable from `K` and the pads — then
   * `proveDefenses` in chunks and `finalizeScoring`. Money still moves
   * only after on-chain geometry, never from a backend JSON.
   */
  private async performReveal(
    lobbyId: Hash,
    attackId: Hash,
    from: Address,
    args: unknown,
  ): Promise<TransactionRecord> {
    const [attack] = (await this.call('getAttack', [attackId])) as [ChainAttack, number]
    if (attack.id === ZERO_HASH) throw new Error('This operation has no attack to reveal.')

    const [, chainOutcome] = (await this.call('getOutcome', [lobbyId])) as [boolean, ChainOutcome]
    if (isOperationScored(chainOutcome)) return this.syntheticRecord('revealAttack', from, args)

    const attempts = (await this.call('getDefenseAttempts', [lobbyId])) as ChainDefenseAttempt[]
    const handles = [
      attack.bearingHandle,
      attack.deltaHandle,
      attack.maskKeyHandle,
      ...attempts.map((entry) => entry.maskedHandle),
    ]
    const alreadyUnlocked = this.unlockedRounds.has(lobbyId) || wasRoundUnlocked(lobbyId)

    /*
     * If this tab already unlocked, or another caller already landed the
     * epoch, try a cheap fetch before touching the wallet. Success means
     * the quorum has the plaintexts and the only transaction left is the
     * scoring one. Failure is ordinary — the unlock may not have been
     * ingested yet — and falls through to the wait below.
     */
    if (alreadyUnlocked || attack.decryptionUnlocked) {
      const ready = await this.confidential()
        .fetchAttested(handles, { attempts: 1, timeoutMs: 8_000 })
        .catch(() => null)
      if (ready) return this.finishReveal(lobbyId, from, args, ready)
    }

    await this.ensureRoundUnlocked(lobbyId, from, args)

    const attested = await this.confidential().fetchAttested(handles)
    return this.finishReveal(lobbyId, from, args, attested)
  }

  /**
   * `unlockRound`, once, no matter how many callers asked.
   *
   * Marked done only after the receipt: a user who rejects the prompt must
   * still be able to try again. While the prompt is open, later callers
   * wait on this promise rather than opening a second one.
   */
  private ensureRoundUnlocked(lobbyId: Hash, from: Address, args: unknown): Promise<void> {
    if (this.unlockedRounds.has(lobbyId) || wasRoundUnlocked(lobbyId)) return Promise.resolve()
    return shareJob(this.unlockJobs, lobbyId, async () => {
      if (this.unlockedRounds.has(lobbyId) || wasRoundUnlocked(lobbyId)) return
      await this.send('revealAttack', 'unlockRound', [lobbyId], from, 0n, args)
      this.unlockedRounds.add(lobbyId)
      rememberUnlockedRound(lobbyId)
      // The quorum learns about the unlock by watching the chain. Asking
      // in the same breath as the receipt is how "not processed yet" became
      // the first answer every time.
      await delay(2_000)
    })
  }

  private async finishReveal(
    lobbyId: Hash,
    from: Address,
    args: unknown,
    attested: AttestedValue[],
  ): Promise<TransactionRecord> {
    const [bearing, delta, mask, ...defenses] = attested
    const proofs = defenses.map(asProof)

    if (defenses.length <= MAX_SCORE_BATCH) {
      return this.send(
        'revealAttack',
        'revealAndResolve',
        [lobbyId, asProof(bearing), asProof(delta), asProof(mask), proofs],
        from,
        0n,
        args,
      )
    }

    await this.send(
      'revealAttack',
      'revealAndResolve',
      [lobbyId, asProof(bearing), asProof(delta), asProof(mask), []],
      from,
      0n,
      args,
    )

    for (let offset = 0; offset < proofs.length; offset += MAX_SCORE_BATCH) {
      const end = Math.min(offset + MAX_SCORE_BATCH, proofs.length)
      const indices = Array.from({ length: end - offset }, (_, i) => offset + i)
      await this.send('revealAttack', 'proveDefenses', [lobbyId, indices, proofs.slice(offset, end)], from, 0n, args)
    }

    return this.send('revealAttack', 'finalizeScoring', [lobbyId], from, 0n, args)
  }

  /**
   * A record for a reveal that turned out to have nothing left to do.
   *
   * The caller is owed a `TransactionRecord`, and inventing a confirmed one
   * with no hash is more honest than reporting a failure: the state the
   * caller asked for is the state the chain is in, somebody else just paid
   * for it.
   */
  private syntheticRecord(
    functionName: ContractWriteFunctionName,
    from: Address,
    args: unknown,
  ): TransactionRecord {
    return {
      hash: ZERO_HASH,
      functionName,
      args,
      from,
      value: 0,
      status: 'confirmed',
      blockNumber: null,
      createdAt: Date.now(),
      confirmedAt: Date.now(),
      events: [],
      errorMessage: null,
    }
  }

  /**
   * Rehydrate a confidential reading session this tab already granted.
   *
   * Called when a joined player opens an operation. Restore only — a new
   * voucher is a wallet prompt with Inco's leak warning, and must not fire
   * because the page loaded. Join and the first probe call
   * `ensureConfidentialReads` when they actually need a grant.
   */
  async warmUpConfidentialReads(from: Address): Promise<void> {
    try {
      await this.confidential().warmUp?.(from)
    } catch {
      // Nothing downstream depends on this having happened.
    }
  }

  /**
   * Load the confidential provider's encryption side ahead of time.
   *
   * Called when a joined player opens a live operation. It signs nothing —
   * it is a dynamic import and a client handshake — so unlike
   * `ensureConfidentialReads` it may run because a page loaded.
   */
  async warmUpConfidentialWrites(from: Address): Promise<void> {
    try {
      await this.confidential().warmUpEncrypt?.(from)
    } catch {
      // Nothing downstream depends on this having happened.
    }
  }

  /**
   * Grant a confidential reading session if this tab does not have one.
   *
   * May open the wallet. Join awaits it after the seat is taken; a probe
   * that arrives first grants lazily inside `decryptForOwner`.
   */
  async ensureConfidentialReads(from: Address): Promise<void> {
    try {
      await this.confidential().ensureSession?.(from)
    } catch {
      // Nothing downstream depends on this having happened.
    }
  }

  /**
   * Whether the covalidator quorum will take work, from any page.
   *
   * Gameplay already reports Inco 500s into the same health lane, but
   * those calls only happen on an Operation. Home and Docs would stay
   * green through a total outage without this.
   */
  async probeConfidentialHealth(): Promise<void> {
    try {
      await this.confidential().probeHealth?.()
    } catch {
      reportPrivacyDelay()
    }
  }

  /**
   * The transitions nobody owns (ТЗ §10).
   *
   * Closing applications, cancelling an under-filled operation and marking
   * an attack landed are facts about the clock rather than decisions, so the
   * contract lets anybody trigger them. With no backend, "anybody" is
   * whoever has the page open — so the client offers them as ordinary calls
   * and the UI makes them when it notices the chain is behind the clock.
   */
  async maintain(
    action: 'startOperation' | 'cancelLobby' | 'completeAttack',
    lobbyId: Hash,
    from: Address,
  ): Promise<TransactionRecord> {
    /*
     * `completeAttack` is the odd one out: it is keyed by the epoch, because
     * landing an attack is a fact about the world rather than about any one
     * team watching it. Passing a lobby id — which is what this used to do —
     * reinterpreted 32 bytes of hash as a uint32 epoch and asked the
     * protocol to land an attack that had never existed.
     */
    if (action === 'completeAttack') {
      const [lobby] = await this.readLobbyRaw(lobbyId)
      const [attack] = (await this.call('getAttack', [lobby.attackId])) as [ChainAttack, number]
      if (attack.id === ZERO_HASH) throw new Error('This operation has no attack to complete.')
      return this.send('revealAttack', action, [attack.epochId], from, 0n, { action, lobbyId })
    }
    return this.send('revealAttack', action, [lobbyId], from, 0n, { action, lobbyId })
  }

  // -----------------------------------------------------------------
  // Transaction plumbing
  // -----------------------------------------------------------------

  /**
   * One write, with the lifecycle the UI renders (ТЗ §10).
   *
   * The states are not cosmetic: `wallet_confirmation` is the window where
   * the transaction exists only in the user's wallet and can still be
   * rejected, `pending` is where it exists on the network and cannot, and
   * `confirmed` is the only state in which the app is allowed to believe
   * anything changed. Every state change is published so a subscriber sees
   * the same progression the caller does.
   */
  private async send(
    lifecycleName: ContractWriteFunctionName,
    functionName: string,
    args: unknown[],
    from: Address,
    value: bigint,
    callArgs: unknown,
  ): Promise<TransactionRecord> {
    const wallet = this.wallet()
    const publicClient = this.client()
    const address = this.contractAddress()

    const record: TransactionRecord = {
      hash: ZERO_HASH,
      functionName: lifecycleName,
      args: callArgs,
      from,
      value: Number(value) / 1e18,
      status: 'preparing',
      blockNumber: null,
      createdAt: Date.now(),
      confirmedAt: null,
      events: [],
      errorMessage: null,
    }

    try {
      // Simulated first: a revert surfaces here as the contract's own error
      // rather than as a failed transaction the player has already paid for.
      const { request } = await publicClient.simulateContract({
        address,
        abi: AEGYLAX_CONTRACT_ABI,
        functionName,
        args,
        account: from,
        value,
      })

      record.status = 'wallet_confirmation'
      const hash = await wallet.writeContract(request)
      record.hash = hash
      record.status = 'pending'
      this.transactions.set(hash, record)

      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      // Confirmed is not the same as readable — see `awaitReadableBlock`.
      await this.awaitReadableBlock(receipt.blockNumber)
      record.blockNumber = Number(receipt.blockNumber)
      record.confirmedAt = Date.now()
      record.events = receipt.logs
        .map((log, index) => this.decodeLog(log, index))
        .filter((log): log is EventLog => log !== null)
      record.status = receipt.status === 'success' ? 'confirmed' : 'failed'
      if (record.status === 'failed') record.errorMessage = 'Transaction reverted on chain.'

      for (const event of record.events) {
        this.events.emit(event.name, event)
        this.events.emit('all', event)
      }
      return record
    } catch (error) {
      record.status = classifyFailure(error)
      record.errorMessage = describeError(error)
      if (record.hash !== ZERO_HASH) this.transactions.set(record.hash, record)
      throw new Error(record.errorMessage)
    }
  }

  async waitForTransaction(hash: Hash): Promise<TransactionRecord> {
    const known = this.transactions.get(hash)
    if (known && (known.status === 'confirmed' || known.status === 'failed')) return known

    const receipt = await this.client().waitForTransactionReceipt({ hash })
    const record: TransactionRecord = known ?? {
      hash,
      functionName: 'claimReward',
      args: null,
      from: (receipt.from as Address) ?? ZERO_HASH,
      value: 0,
      status: 'pending',
      blockNumber: null,
      createdAt: Date.now(),
      confirmedAt: null,
      events: [],
      errorMessage: null,
    }
    record.blockNumber = Number(receipt.blockNumber)
    record.confirmedAt = Date.now()
    record.status = receipt.status === 'success' ? 'confirmed' : 'failed'
    record.events = receipt.logs.map((log, index) => this.decodeLog(log, index)).filter((log): log is EventLog => log !== null)
    this.transactions.set(hash, record)
    return record
  }

  // -----------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------

  async getLogs(filter: EventLogFilter): Promise<EventLog[]> {
    const logs = await this.client().getLogs({
      address: this.contractAddress(),
      fromBlock: filter.fromBlock !== undefined ? BigInt(filter.fromBlock) : this.deploymentBlock,
      toBlock: filter.toBlock !== undefined ? BigInt(filter.toBlock) : 'latest',
    })

    return logs
      .map((log, index) => this.decodeLog(log, index))
      .filter((log): log is EventLog => log !== null)
      .filter((log) => !filter.eventName || log.name === filter.eventName)
      .filter((log) => {
        if (!filter.lobbyId) return true
        return (log.payload as { lobbyId?: Hash }).lobbyId === filter.lobbyId
      })
  }

  subscribeToEvents(eventName: GameEventName | 'all', callback: (log: EventLog) => void): () => void {
    this.ensureEventWatcher()
    return this.events.on(eventName, callback)
  }

  subscribeToBlocks(callback: (blockNumber: number) => void): () => void {
    this.ensureBlockWatcher()
    return this.blocks.on('block', callback)
  }

  /**
   * One RPC subscription for the whole app, fanned out in memory.
   *
   * Every hook that follows the chain subscribes here, and a node would
   * otherwise see one filter per hook per mounted component.
   */
  private ensureEventWatcher(): void {
    if (this.eventWatcher || !this.publicClient || !this.address) return
    this.eventWatcher = this.publicClient.watchContractEvent({
      address: this.address,
      abi: AEGYLAX_CONTRACT_ABI,
      onLogs: (logs) => {
        logs.forEach((log, index) => {
          const decoded = this.decodeLog(log as Log, index)
          if (!decoded) return
          this.events.emit(decoded.name, decoded)
          this.events.emit('all', decoded)
        })
      },
    })
  }

  /**
   * Waits until the endpoint this client *reads* through has caught up to
   * the block a write landed in.
   *
   * An RPC URL is a load balancer over many nodes, and the node that
   * answers the next `eth_call` is not the node that answered
   * `eth_getTransactionReceipt`. Without this, a read issued the moment a
   * write confirms can be served a block early and come back empty — a
   * lobby that certainly exists reads as if it had never been created.
   *
   * Giving up after `BLOCK_SYNC_ATTEMPTS` is deliberate: the write itself
   * already succeeded, so a caller that still cannot see it is better off
   * reading a stale chain than being told its transaction failed.
   */
  private async awaitReadableBlock(blockNumber: bigint): Promise<void> {
    for (let attempt = 0; attempt < BLOCK_SYNC_ATTEMPTS; attempt++) {
      // `cacheTime: 0` because viem otherwise answers this from the block
      // number it already had, which is the one that is behind.
      const seen = await this.client().getBlockNumber({ cacheTime: 0 })
      if (seen >= blockNumber) return
      await delay(BLOCK_SYNC_POLL_MS)
    }
  }

  private ensureBlockWatcher(): void {
    if (this.blockWatcher || !this.publicClient) return
    this.blockWatcher = this.publicClient.watchBlockNumber({
      onBlockNumber: (blockNumber) => {
        reportChainBlock()
        this.blocks.emit('block', Number(blockNumber))
      },
      onError: (error) => reportRpcFailure(describeRpcError(error)),
      emitOnBegin: true,
    })
  }

  /**
   * A raw log as one of the events the app understands.
   *
   * Amounts are converted to ETH and block numbers to numbers here, so no
   * consumer ever meets a bigint; anything the ABI does not recognise is
   * dropped rather than guessed at.
   */
  private decodeLog(log: Log, index: number): EventLog | null {
    try {
      const decoded = decodeEventLog({ abi: AEGYLAX_CONTRACT_ABI, data: log.data, topics: log.topics })
      const args = (decoded.args ?? {}) as Record<string, unknown>
      const payload = normalizeEventArgs(args)

      return {
        name: decoded.eventName as unknown as GameEventName,
        payload: payload as never,
        blockNumber: Number(log.blockNumber ?? 0n),
        transactionHash: (log.transactionHash ?? ZERO_HASH) as Hash,
        logIndex: log.logIndex ?? index,
      }
    } catch {
      return null
    }
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  private ownPointKey(attackId: Hash, address: Address): string {
    return ownPointKey(attackId, address)
  }

  /**
   * This wallet's own Defense Point, from memory or from the last session.
   *
   * Scoped to the attack *and* the address, both in the key, because that is
   * exactly how private the fact is: nobody else's point is here, and a point
   * chosen in one operation must never redraw itself on another.
   */
  private rememberedPoint(attackId: Hash, address: Address): DefensePoint | null {
    const key = this.ownPointKey(attackId, address)
    const cached = this.ownDefensePoints.get(key)
    if (cached) return cached

    const stored = readOwnPoint(attackId, address)
    if (stored) this.ownDefensePoints.set(key, stored)
    return stored
  }

  private rememberPoint(attackId: Hash, address: Address, point: DefensePoint): void {
    this.ownDefensePoints.set(this.ownPointKey(attackId, address), point)
    writeOwnPoint(attackId, address, point)
  }

  // -----------------------------------------------------------------
  // Probes whose answer has not been read yet
  // -----------------------------------------------------------------

  /**
   * Where a probe waits when its transaction landed but its answer did not.
   *
   * The two halves of a Recon Probe fail independently, and the gap between
   * them is where a player's money used to disappear. `sendProbe` is a
   * transaction: once mined, the probe is spent, the allowance is consumed
   * and the hint handle is on chain with this wallet's name on it. *Reading*
   * that handle is a separate request to the confidential network, and it can
   * fail on its own — the network is catching up, the quorum is down, the
   * player closed the tab while it was in flight.
   *
   * Nothing recorded the handle, so any of those turned a paid probe into
   * nothing at all: no reading, no fog, no way back, and the allowance gone.
   * Writing the handle down before attempting the read is what makes the
   * failure recoverable — the probe stays the player's, and the read can be
   * retried for free, after a reload, whenever the network is answering
   * again.
   *
   * Keyed by wallet and attack, like the readings themselves, because a
   * handle is only meaningful to the one address the engine granted it to.
   */
  /** How many probes this wallet has paid for and not yet been able to read. */
  countPendingProbes(lobbyId: Hash, attackId: string, from: Address): number {
    return readPendingProbes(lobbyId, attackId as Hash, from).length
  }

  /**
   * Opens every probe answer this wallet is still owed.
   *
   * Safe to call whenever — on mount, on a wallet switch, or from a control
   * the player pressed. Each handle that opens is removed from the pending
   * list and returned as a reading; each that does not stays exactly where it
   * was, so nothing is consumed by an attempt that failed.
   *
   * It stops at the first failure rather than working through the list. The
   * realistic reason a handle will not open is that the confidential network
   * is unavailable, which is a fact about the network and not about the
   * handle — so the rest would fail identically, and on the per-call path
   * each of those failures costs the player another wallet signature.
   */
  async resolvePendingProbes(lobbyId: Hash, attackId: string, from: Address): Promise<ReconProbeRecord[]> {
    return shareJob(this.openPendingJobs, `${lobbyId}:${attackId}:${from.toLowerCase()}`, () =>
      this.openPendingProbes(lobbyId, attackId, from),
    )
  }

  private async openPendingProbes(lobbyId: Hash, attackId: string, from: Address): Promise<ReconProbeRecord[]> {
    const pending = readPendingProbes(lobbyId, attackId as Hash, from)
    if (pending.length === 0) return []

    const chainParams = await this.readParams()
    const opened: ReconProbeRecord[] = []
    const remaining = [...pending]

    while (remaining.length > 0) {
      const next = remaining[0]
      const readableAt = next.readableAtBlock ?? next.generatedAtBlock + PROBE_DELAY_BLOCKS
      if (!readableOnArrival(next) && (await this.getBlockNumber()) < readableAt) {
        remaining.shift()
        remaining.push(next)
        break
      }
      try {
        opened.push(await this.openProbe(next, chainParams, from))
        remaining.shift()
      } catch (err) {
        if (isProbeInFlight(err)) break
        throw err
      }
    }

    if (opened.length > 0) writePendingProbes(lobbyId, attackId as Hash, from, remaining)
    return opened
  }

  /** One pending handle, turned into the reading it stands for. */
  private async openProbe(
    pending: PendingProbe,
    chainParams: ChainGameParams,
    from?: Address,
  ): Promise<ReconProbeRecord> {
    await this.ensureHintGranted(pending, from ?? pending.requestedBy)
    const hint = await this.confidential().decryptForOwner(pending.handle, pending.requestedBy)
    const attack = await this.readAttack(pending.attackId as Hash, pending.lobbyId)
    const progress = attack ? flightProgress(attack, pending.generatedAtBlock) : 0.5
    return decodeProbeHint({
      hint,
      coneMicroRad: chainParams.probeConeMicroRad,
      flightProgress: progress,
      probeIndex: pending.probeIndex,
      lobbyId: pending.lobbyId,
      attackId: pending.attackId,
      probeId: pending.probeId,
      requestedBy: pending.requestedBy,
      txHash: pending.txHash,
      generatedAtBlock: pending.generatedAtBlock,
      world: this.world,
      grid: { columns: this.config.map.columns, rows: this.config.map.rows },
    })
  }

  /**
   * `sendProbe` computes the hint but does not grant it. Collecting is
   * permissionless and is what opens decryption; a probe still in flight
   * reverts, so this is also the clock.
   */
  private async ensureHintGranted(pending: PendingProbe, from: Address): Promise<void> {
    /*
     * Granted inside `sendProbe` — nothing to collect, and nothing to ask
     * the chain about before the read can start.
     *
     * This is the whole of the one-transaction probe on this side: no
     * second wallet signature, no `getProbeFlight` round trip, and above
     * all no second transaction for the confidential network to ingest
     * before the handle will open. `ReconRules.DELAY_BLOCKS` did not go
     * away — the contract now refuses a second probe *and* a Defense Point
     * for it — so what is skipped here is waiting, not a check.
     */
    if (readableOnArrival(pending)) return

    const now = await this.getBlockNumber()
    const pendingReadable = pending.readableAtBlock || pending.generatedAtBlock + PROBE_DELAY_BLOCKS
    if (now < pendingReadable) {
      throw probeInFlightError()
    }

    const flight = await this.readProbeFlight(pending.handle)
    if (flight?.granted) return
    const readableAt = flight?.readableAtBlock || pendingReadable
    if (now < readableAt) throw probeInFlightError()

    if (flight === null) {
      // Lens without `getProbeFlight` — an older deployment granted on send.
      return
    }

    await shareJob(this.collectJobs, pending.handle, async () => {
      try {
        await this.send('collectProbe', 'collectProbe', [pending.handle], from, 0n, {
          hintHandle: pending.handle,
        })
      } catch (err) {
        if (isProbeInFlight(err)) throw probeInFlightError()
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('ProbeAlreadyGranted')) return
        throw err
      }
    })
  }

  /**
   * `getProbeFlight` as named fields, whether viem handed back a struct or
   * a tuple. A missing selector (lens not yet upgraded) is null rather than
   * a crash — that path granted the hint inside `sendProbe`.
   */
  private async readProbeFlight(
    handle: Hash,
  ): Promise<{ granted: boolean; readableAtBlock: number } | null> {
    try {
      const raw = await this.call('getProbeFlight', [handle])
      if (Array.isArray(raw)) {
        return { readableAtBlock: Number(raw[2] ?? 0), granted: Boolean(raw[3]) }
      }
      const row = raw as { granted?: boolean; readableAtBlock?: bigint | number }
      return {
        granted: Boolean(row.granted),
        readableAtBlock: Number(row.readableAtBlock ?? 0),
      }
    } catch {
      return null
    }
  }

  private async call(functionName: string, args: unknown[]): Promise<unknown> {
    return this.client().readContract({
      address: this.contractAddress(),
      abi: AEGYLAX_CONTRACT_ABI,
      functionName,
      args,
    })
  }

  /**
   * `getParticipant` decoded from the raw return bytes.
   *
   * The ABI the frontend was built with may be one field ahead of the
   * proxy (see `decodeChainParticipant`). Going through `readContract`
   * would throw on that gap and take the whole Operation screen with it.
   */
  private async readParticipant(lobbyId: Hash, who: Address): Promise<ChainParticipant> {
    const data = encodeFunctionData({
      abi: AEGYLAX_CONTRACT_ABI,
      functionName: 'getParticipant',
      args: [lobbyId, who],
    })
    const { data: ret } = await this.client().call({ to: this.contractAddress(), data })
    if (!ret || ret === '0x') throw new Error('getParticipant returned empty data')
    return decodeChainParticipant(ret)
  }

  private client(): PublicClient {
    if (!this.publicClient) {
      throw new Error('Contract mode is not configured: set VITE_CHAIN_ID and VITE_RPC_URL.')
    }
    return this.publicClient
  }

  private wallet(): WalletClient {
    if (!this.walletClient) throw new Error('Sign in before sending this transaction.')
    return this.walletClient
  }

  private contractAddress(): Address {
    if (!this.address) {
      throw new Error(
        `No AEGYLAX deployment for chain ${this.config.chainId ?? '(unset)'}. Run "npm run chain:deploy" for it.`,
      )
    }
    return this.address
  }

  private confidential(): ConfidentialGateway {
    if (!this.gateway) {
      const engine = this.config.deployment.confidentialEngine
      if (!engine) throw new Error('The active deployment has no confidential engine recorded.')
      this.gateway = createGateway({
        kind: this.config.deployment.confidentialEngineKind,
        release: this.config.deployment.confidentialRelease,
        executor: this.config.deployment.confidentialExecutor,
        services: this.config.deployment.confidentialServices ?? undefined,
        // Optional: without it, confidential reads fall back to a wallet
        // signature per read. See `IncoGateway.decryptForOwner`.
        sessionVerifier: this.config.deployment.confidentialSessionVerifier,
        chainId: this.config.chainId ?? 0,
        engineAddress: engine,
        publicClient: this.client(),
        getWalletClient: () => this.walletClient,
        hostChainRpcUrls: this.config.rpcUrls,
      })
    }
    return this.gateway
  }
}

/**
 * Whether this probe's hint was granted by the transaction that sent it.
 *
 * `sendProbe` records `readableAtBlock == sentBlock` when it granted, and
 * `sentBlock + DELAY_BLOCKS` when a separate `collectProbe` still has to.
 * Comparing the two is therefore the deployment's own answer, which is what
 * lets one build talk to either: a probe saved by an older version of this
 * app, or one sent against an engine that has not been upgraded, keeps the
 * slower path it was made under.
 */
function readableOnArrival(pending: PendingProbe): boolean {
  return pending.readableAtBlock > 0 && pending.readableAtBlock <= pending.generatedAtBlock
}

/**
 * The creator's half of an operation's terms, as the contract takes them.
 *
 * Recon is deliberately absent: `GameTypes.LobbyConfig` stopped carrying
 * `freeProbes`/`maxProbes`/`probePrice` when the threat became the epoch's
 * rather than the operation's, and sending them made the encoded config a
 * different shape from the one `createLobby` expects.
 */
function toChainLobbyConfig(config: import('../../game/types').LobbyConfig): ChainLobbyConfig {
  return {
    name: config.name.trim(),
    minPlayers: config.participation.minPlayers,
    maxPlayers: config.participation.maxPlayers,
    entryPrice: ethToWei(config.participation.entryPrice),
    registrationDeadline: BigInt(Math.floor(config.participation.deadline / 1000)),
    // The deadline the protocol enforces, and the one the attack's epoch is
    // derived from. Computed by the creator's client from the block rate,
    // because only a client can turn "6pm" into a block.
    registrationDeadlineBlock: BigInt(Math.max(0, Math.floor(config.participation.deadlineBlock))),
    startPrizePool: ethToWei(config.economics.prizePool),
    creatorFeeBps: Math.round((config.economics.creatorFeePercent / 100) * 10_000),
  }
}

/** Bigints to numbers, wei to ETH — the shape every consumer above expects. */
function normalizeEventArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'bigint') {
      out[key] = isMoneyField(key) ? weiToEth(value) : Number(value)
    } else if (key === 'player') {
      out.participant = value
    } else {
      out[key] = value
    }
  }
  // The contract calls the actor `player`; the app's event shapes call it
  // `participant`. Both are kept so either name resolves.
  if ('player' in args) out.player = args.player
  return out
}

function isMoneyField(key: string): boolean {
  return /paid|amount|refunded|reward|prizePool|entryPrice|fee/i.test(key)
}

function classifyFailure(error: unknown): TxLifecycleStatus {
  const message = describeError(error).toLowerCase()
  if (message.includes('user rejected') || message.includes('denied')) return 'rejected'
  return 'failed'
}

function describeError(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { shortMessage?: string; details?: string; message?: string }
    return candidate.shortMessage ?? candidate.details ?? candidate.message ?? String(error)
  }
  return String(error)
}

function probeInFlightError(): Error {
  return Object.assign(new Error('The probe is still in flight'), { code: 'PROBE_IN_FLIGHT' })
}

function isProbeInFlight(err: unknown): boolean {
  const message = describeError(err)
  return (
    (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'PROBE_IN_FLIGHT') ||
    message.includes('still in flight') ||
    message.includes('ProbeNotReadable')
  )
}
