import type { BlockchainMode } from '../config/env'
import type { SealedEnvelope, SealingKey } from '../game/sealing'
import type {
  Address,
  ActivityCell,
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
  LobbyConfig,
  LobbyReveal,
  Participant,
  ReconProbeRecord,
} from '../game/types'

export type { BlockchainMode }

// ---------------------------------------------------------------------------
// Chain primitives (spec §45)
// ---------------------------------------------------------------------------

export interface Block {
  number: number
  hash: Hash
  timestamp: number
  parentHash: Hash
}

/**
 * Transaction lifecycle used identically by both the emulator and the
 * contract client (spec §44):
 *   idle -> preparing -> wallet_confirmation -> pending -> confirmed
 *   idle -> preparing -> wallet_confirmation -> rejected | failed
 */
export type TxLifecycleStatus =
  | 'idle'
  | 'preparing'
  | 'wallet_confirmation'
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'rejected'

export interface TransactionRecord {
  hash: Hash
  functionName: ContractWriteFunctionName
  args: unknown
  from: Address
  value: number
  status: TxLifecycleStatus
  blockNumber: number | null
  createdAt: number
  confirmedAt: number | null
  /** Populated once the transaction is confirmed. */
  events: EventLog[]
  errorMessage: string | null
}

// ---------------------------------------------------------------------------
// Game contract events (spec §48) — not exhaustive by design; the emulator
// and future contract adapter may add more without breaking this union
// since consumers should treat unknown event names as ignorable.
// ---------------------------------------------------------------------------

export interface GameEventPayloadMap {
  /**
   * `config` is present when the emitter had it to hand — the emulator
   * always does, and the contract client does for a lobby this session
   * created. Decoded from a log by another client it is absent, because the
   * contract's event carries the money and the deadline rather than the
   * whole configuration: consumers read the lobby for that.
   */
  LobbyCreated: { lobbyId: Hash; creator: Address; config?: LobbyConfig }
  LobbyJoined: { lobbyId: Hash; participant: Address }
  /** ТЗ §5 — a defender withdrew before the operation started; their funds went back. */
  LobbyLeft: { lobbyId: Hash; participant: Address; refunded: number }
  LobbyStarted: { lobbyId: Hash; epochId: number }
  AttackStarted: { lobbyId: Hash; attack: Attack }
  DronePurchased: { lobbyId: Hash; participant: Address; droneId: string; price: number }
  /**
   * ТЗ §4, §5 — a defender acted, and that is the entire public content of
   * this event.
   *
   * There is deliberately no `ReconProbeSent` and no `DefenseSubmitted`.
   * Separate events would name the operation type in the log even with
   * every argument encrypted, which is precisely what §4 rules out: an
   * observer must not be able to tell a probe from a Defense Submit. So one
   * event covers both, and what actually happened travels in `sealedResult`
   * — sealed to the acting wallet, unreadable by every other client, and
   * the private computation's answer to the private action that caused it.
   */
  PrivateActionSubmitted: { lobbyId: Hash; participant: Address; sealedResult: SealedEnvelope }
  /**
   * The attack landed and the protocol resolved it (ТЗ §12). The outcome
   * carries the verdict, the winner and the interception time; the sealed
   * geometry is *not* in it — that only comes back from `getAttackReveal`,
   * once a player asks for it (ТЗ §13.1).
   */
  AttackResolved: { lobbyId: Hash; attackId: string; outcome: AttackOutcome }
  /**
   * ТЗ §4 — the first Reveal on a finished operation, and the only one.
   * It moves the sealed geometry into public lobby state, after which every
   * client simply reads it.
   */
  AttackRevealed: { lobbyId: Hash; attackId: string; reveal: LobbyReveal }
  /** ТЗ §17.3 — the winner claimed. Emitted once per participant, ever. */
  RewardClaimed: { lobbyId: Hash; participant: Address; amount: number }
  PrizePaid: { lobbyId: Hash; participant: Address; amount: number; reason: 'reward' | 'creator_fee' }
  LobbyCancelled: { lobbyId: Hash; reason: string }
  /**
   * The protocol opened its own Global Defense operation (ТЗ §18). The
   * whole accumulated pool moved into that lobby as the bounty.
   */
  GlobalDefenseOpened: { epochId: number; lobbyId: Hash; pool: number }
  /**
   * Unwon COMPLETED pool (or an unplayed protocol draw's bounty) returned
   * to the Global Defense Pool.
   */
  DefensePoolFunded: { lobbyId: Hash; amount: number; pool: number }
}

/**
 * The contract's own events (ТЗ §11), added alongside the emulator's.
 *
 * The two sets overlap without being identical, and that is deliberate:
 * each implementation emits what it actually has. The emulator seals a
 * private result onto its event because both halves of the seal live in the
 * same tab; the contract cannot, because a probe's answer is a handle only
 * its owner may decrypt. Consumers subscribe to `'all'` and re-read state,
 * so neither shape is load-bearing for the UI.
 */
export interface ContractEventPayloadMap {
  /** A defender bought extra Recon Probes; the money went to the reward pool. */
  ProbesPurchased: { lobbyId: Hash; participant: Address; count: number; paid: number }
  /** Applications closed and the attack was scheduled. */
  OperationStarted: { lobbyId: Hash; epochId: number; startedAtBlock: number }
  /**
   * A probe was sent, and its answer exists as a confidential handle only
   * this player can open. No coordinate, no bearing, nothing an observer
   * can use — the event says that reconnaissance happened, and no more.
   */
  ProbeSent: {
    lobbyId: Hash
    participant: Address
    attackId: string
    probeIndex: number
    hintHandle: Hash
    readableAtBlock: number
  }
  ProbeHintGranted: { hintHandle: Hash; participant: Address; grantedAtBlock: number }
  /** A Defense Point was committed. The point itself is a confidential handle. */
  DefenseSubmitted: {
    lobbyId: Hash
    participant: Address
    attackId: string
    attemptIndex: number
    pointHandle: Hash
    maskedHandle: Hash
    submittedAtBlock: number
  }
  /** The flight is over and decryption has been unlocked; the reveal can now happen. */
  AttackCompleted: { lobbyId: Hash; attackId: string; completedAtBlock: number }
  /** ТЗ §11 — who won, and by what arrival time. */
  WinnerDetermined: {
    lobbyId: Hash
    attackId: string
    intercepted: boolean
    winners: Address[]
    rewardPerWinner: number
  }
  /** Nobody revealed within the grace window; the operation refunds instead. */
  AttackExpired: { lobbyId: Hash; attackId: string; reason: string }
  RefundClaimed: { lobbyId: Hash; participant: Address; amount: number }
  /**
   * The creator's settlement. The address field is `creator` rather than
   * `participant` because that is what the contract's own event calls it —
   * the `player`→`participant` rename the decoder applies does not reach
   * this one, and declaring a field the log never carries would make any
   * consumer that read it silently undefined.
   */
  CreatorSettled: { lobbyId: Hash; creator: Address; amount: number }
}

export type GameEventName = keyof GameEventPayloadMap | keyof ContractEventPayloadMap

/** Every event either implementation can emit, as one lookup. */
export type AllEventPayloadMap = GameEventPayloadMap & ContractEventPayloadMap

export interface EventLog<TName extends GameEventName = GameEventName> {
  name: TName
  payload: AllEventPayloadMap[TName]
  blockNumber: number
  transactionHash: Hash
  logIndex: number
}

export interface EventLogFilter {
  eventName?: GameEventName
  lobbyId?: Hash
  fromBlock?: number
  toBlock?: number
}

// ---------------------------------------------------------------------------
// Contract call surface — the same function names/args/results are used by
// EmulatorBlockchainClient (interpreted against in-memory state) and
// ContractBlockchainClient (forwarded to the real ABI). Nothing above this
// layer (game/gameService.ts, hooks, components) knows which one is active.
// ---------------------------------------------------------------------------

export interface ContractWriteArgsMap {
  createLobby: { config: LobbyConfig; value: number }
  joinLobby: { lobbyId: Hash; value: number }
  /**
   * ТЗ §5 — withdrawing before the operation starts. Legal only while the
   * lobby is still OPEN; once it goes ACTIVE the seat is committed.
   */
  leaveLobby: { lobbyId: Hash }
  buyDrone: { lobbyId: Hash; value: number }
  /**
   * Every in-round action a defender takes (ТЗ §4, §5) — Recon Probes and
   * the final Defense alike — as one indistinguishable call.
   *
   * The arguments are the whole privacy argument. `lobbyId` is public
   * because a chain has to know which operation a transaction is for;
   * everything else — which operation type this is, and any coordinate it
   * carries — is inside `envelope`, which is a fixed-size ciphertext. Two
   * transactions from the same wallet are byte-identical in shape whether
   * one was a probe and the other a Defense Submit.
   *
   * ТЗ §5 asks that these stay *separate* transactions rather than being
   * batched into one, and they do: a player sends three probes and a
   * Defense as four signatures, four blocks, four envelopes.
   */
  submitPrivateAction: { lobbyId: Hash; envelope: SealedEnvelope }
  /**
   * ТЗ §4 — publish the finished attack's real geometry into lobby state.
   * A write rather than a read because it *changes* the operation: the
   * first caller opens the trajectory for everyone, permanently, and every
   * later caller is rejected because there is nothing left to reveal.
   */
  revealAttack: { lobbyId: Hash; attackId: string }
  /**
   * ТЗ §15, §17.2-17.4. Deliberately a *write*: the reward moves only when
   * the protocol has re-checked the operation, the epoch, the submission,
   * the interception, the winner and the not-already-claimed flag. A
   * frontend that decides someone won changes nothing.
   */
  claimReward: { lobbyId: Hash; attackId: string }
  /**
   * ТЗ §18 — the money back out of an operation that never ran.
   *
   * Deliberately a transaction the participant sends, and deliberately not
   * something cancellation does to them. A cancellation is a status change
   * on one operation; paying every participant from inside it would put an
   * unbounded loop of transfers into a single call, make the last defender
   * to join pay the gas for everybody, and hand money to addresses that
   * never asked for it. So the protocol records what it owes and each owner
   * comes and takes it — the same shape as `claimReward`, for the same
   * reasons.
   */
  claimRefund: { lobbyId: Hash }
  /**
   * The creator's settlement (ТЗ §14.6): the Creator Fee whatever the
   * outcome, plus the bounty back when nothing was won — an operation that
   * was cancelled, or one whose attack reached Earth. One call, whichever
   * of those happened, and only ever to the creator.
   */
  settleCreator: { lobbyId: Hash }
  /**
   * Open the protocol's own Global Defense operation (ТЗ §18).
   *
   * Permissionless, like every other clock-owned transition: once the
   * interval says a draw is due and the pool has something in it, anybody
   * may send this. The first caller drains the whole pool into a free-to-
   * enter lobby named "Global Defense"; a second caller is refused because
   * that interval is already spoken for.
   */
  openGlobalDefense: Record<string, never>
  /**
   * Grant a probe hint after its delay. Permissionless: anybody may
   * collect, and the grant is always to the player who sent the probe.
   */
  collectProbe: { hintHandle: Hash }
}

export type ContractWriteFunctionName = keyof ContractWriteArgsMap

export interface ContractReadArgsMap {
  getGameStats: Record<string, never>
  /**
   * The protocol's published sealing key (ТЗ §4). Players read it to seal
   * their actions *to* the protocol; only the protocol can open what they
   * sealed. It is a public read because the sealing half is meant to be
   * public — that is what makes it a key everybody can send to.
   */
  getSealingKey: Record<string, never>
  getLobby: { lobbyId: Hash }
  /** `viewer` decides whose action breakdown comes back unredacted (ТЗ §4). */
  getLobbyParticipants: { lobbyId: Hash; viewer: Address | null }
  getParticipant: { lobbyId: Hash; address: Address; viewer: Address | null }
  /**
   * Where defenders committed, per sector (ТЗ §4, §11).
   *
   * Empty for the whole life of the round: a per-sector count is a coarse
   * coordinate, and publishing one mid-flight would let anybody watching
   * the map narrow down where the defenders — and by inference the
   * threat — are. It fills in at the reveal, along with everything else.
   */
  getActivityMap: { lobbyId: Hash; attackId: string }
  getAttackEpoch: { lobbyId: Hash; epochId: number }
  getAttack: { lobbyId: Hash; attackId: string }
  /**
   * The reveal (ТЗ §4). Returns null until somebody has actually *called*
   * `revealAttack` on a finished attack — resolution alone does not open
   * the geometry, and there is no argument a caller can pass to get it
   * early. That is what makes "the frontend cannot get the trajectory from
   * a public read" a property of the read surface rather than a promise
   * about the UI. After the first reveal it answers every caller, forever.
   */
  getAttackReveal: { lobbyId: Hash; attackId: string }
  /**
   * `viewer` is what decides whose Defense Point comes back openable at
   * all: your own, sealed to you, and nobody else's (ТЗ §7, §11). Nothing
   * here returns a plaintext coordinate before the reveal — not even to
   * the player who placed it — because the browser is not a place a
   * coordinate is allowed to exist in the clear until then.
   */
  getDefenseAttempts: { lobbyId: Hash; attackId: string; viewer: Address | null }
  /**
   * When the Global Defense Pool is next played for, and the operation for
   * it if one is already open (ТЗ §18).
   */
  getGlobalDefenseDraw: Record<string, never>
}

export type ContractReadFunctionName = keyof ContractReadArgsMap

export interface ContractReadResultMap {
  getGameStats: GameStats
  getSealingKey: SealingKey
  getLobby: Lobby | null
  getLobbyParticipants: Participant[]
  getParticipant: Participant | null
  getActivityMap: ActivityCell[]
  getAttackEpoch: AttackEpoch | null
  getAttack: Attack | null
  getAttackReveal: AttackRevealData | null
  getDefenseAttempts: DefenseAttempt[]
  getGlobalDefenseDraw: GlobalDefenseDraw
}

// ---------------------------------------------------------------------------
// BlockchainClient — the single interface the UI and game domain depend on
// (spec §7). Only `blockchain/index.ts`'s factory picks an implementation.
// ---------------------------------------------------------------------------

export interface BlockchainClient {
  readonly mode: BlockchainMode

  /**
   * Send Recon Probe (ТЗ §3) — a whole action rather than a raw write.
   *
   * How a probe stays private is a property of the *implementation*, not of
   * the game: the emulator seals the answer to the player's key and reads
   * it back off its own event, while the contract client sends a
   * transaction, takes the confidential handle out of the log and asks the
   * confidential network to re-encrypt it to this wallet. Neither mechanism
   * belongs in `game/`, so both live behind this one method and the domain
   * layer simply asks for a probe.
   */
  sendReconProbe(
    from: Address,
    params: {
      lobbyId: Hash
      attackId: string
      probeId: string
      /**
       * Where the player pointed this probe, in fix degrees — or null for
       * the opening sweep, which nobody can aim because there is nothing to
       * aim at yet (ТЗ §4).
       *
       * How much the aim is worth is decided where the truth lives, never
       * here: a client that sends a flattering number gets the same reading
       * as one that sends an honest one.
       */
      aimDegrees?: number | null
    },
  ): Promise<{ tx: TransactionRecord; probe: ReconProbeRecord | null }>

  /**
   * Encrypt a staged Defense Point before it is submitted, so pressing
   * Defend opens the wallet rather than starting a proof.
   *
   * Optional: the emulator encrypts nothing worth preparing. Contract mode
   * runs it as the marker is placed, and `submitDefense` reuses whatever it
   * produced. Speculative by nature — a point that is moved or never sent
   * simply wastes the blob — so it never throws and never signs.
   */
  prepareDefense?(from: Address, defensePoint: DefensePoint): Promise<void>

  /**
   * Send Defense (ТЗ §5). The coordinate is encrypted by the
   * implementation before it goes anywhere near a transaction argument,
   * for the same reason and with the same split.
   */
  submitDefense(
    from: Address,
    params: { lobbyId: Hash; attackId: string; defensePoint: DefensePoint },
  ): Promise<{ tx: TransactionRecord; attempt: DefenseAttempt | null; defensePoint: DefensePoint | null }>

  getBlockNumber(): Promise<number>
  getBlock(blockNumber?: number): Promise<Block>
  getBalance(address: Address): Promise<number>

  readContract<TFn extends ContractReadFunctionName>(
    functionName: TFn,
    args: ContractReadArgsMap[TFn],
  ): Promise<ContractReadResultMap[TFn]>

  writeContract<TFn extends ContractWriteFunctionName>(
    functionName: TFn,
    args: ContractWriteArgsMap[TFn],
    from: Address,
  ): Promise<TransactionRecord>

  waitForTransaction(hash: Hash): Promise<TransactionRecord>

  getLogs(filter: EventLogFilter): Promise<EventLog[]>

  subscribeToEvents(
    eventName: GameEventName | 'all',
    callback: (log: EventLog) => void,
  ): () => void

  /**
   * Pushes every new block number. This is the trigger for
   * lazy-settlement-driven state (deadlines passing, epoch rollovers) that
   * no discrete game event covers — nothing "happens" when a deadline
   * silently passes, only a new block does. Consumers use this instead of
   * polling `getBlockNumber` on a timer.
   */
  subscribeToBlocks(callback: (blockNumber: number) => void): () => void

  /**
   * Ping the confidential network from any page.
   *
   * Optional: the emulator has no quorum to ask. Contract mode uses this
   * from the header so an Inco outage is visible on Home, not only once
   * a player tries to open a probe.
   */
  probeConfidentialHealth?(): Promise<void>
}
