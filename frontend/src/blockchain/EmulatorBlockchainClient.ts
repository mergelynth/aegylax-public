import { keccak256, toHex } from 'viem'
import { protocolLimits as defaultProtocolLimits, type ProtocolLimits } from '../config/env'
import { generateAttack, flightProgress, type ChainTimeReference } from '../game/attacks'
import { resolveAttackDefenses } from '../game/defense'
import { aimInsideFirstCloud, generateReconProbeResult, PROBE_DELAY_BLOCKS } from '../game/recon'
import { getEpochEndBlock, getEpochFromBlock, getEpochStartBlock, generateEpochSeed, launchEpochOf } from '../game/epochs'
import { globalDefenseSchedule } from '../game/globalDefense'
import { calculateAuthorCommission, calculateParticipantCost, calculateRewardPerWinner } from '../game/economics'
import { canJoinLobby, validateLobbyConfig } from '../game/lobby'
import { buildEmptyActivityMap, isValidSector } from '../game/map'
import { openPrivateResult, type PrivateActionRequest, type PrivateActionResult } from '../game/privateActions'
import {
  derivePlayerSealingKey,
  deriveProtocolSealingKey,
  seal,
  unseal,
  type SealedEnvelope,
  type SealingKey,
} from '../game/sealing'
import { buildWorld, type WorldGeometry } from '../game/world'
import type {
  Address,
  Attack,
  AttackEpoch,
  AttackOutcome,
  AttackRevealData,
  AttackTrajectory,
  DefenseAttempt,
  DefensePoint,
  Hash,
  Lobby,
  LobbyConfig,
  LobbyReveal,
  MapGridConfig,
  Participant,
  ReconProbeRecord,
} from '../game/types'
import {
  attackKey,
  computeGameStats,
  computeGlobalDefenseDraw,
  createEmulatorState,
  createLobbyLedger,
  ensureAccount,
  epochKey,
  participantKey,
  PROTOCOL_ESCROW_ADDRESS,
  type EmulatorState,
  type LobbyLedger,
  type ProtocolEpochReference,
} from './emulatorState'
import { loadOrCreateEmulatorState, saveEmulatorState } from './emulatorPersistence'
import { EventEmitter } from './emitter'
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
} from './types'

export interface EmulatorBlockchainClientConfig {
  initialBlock: number
  blockTimeMs: number
  mapGrid: MapGridConfig
  /** Protocol epoch length in blocks — the same value lobbies use for attack epochs. */
  epochBlocks: number
  /**
   * The protocol rules this "chain" enforces on every `createLobby` write.
   * Stands in for what a deployed contract would hold in storage: the
   * client re-validates each config against these, so a config that never
   * went through the Create Defense Operation form — or went through a
   * modified one — is rejected here (spec §15). Defaults to the build's
   * protocol config.
   */
  protocolLimits?: ProtocolLimits
  /**
   * How long a write takes to confirm, in ms.
   *
   * The default models a chain: a press, a moment, a receipt, which is what
   * every busy state in the product is built to narrate. A guided demo is
   * the one caller that must not have it — there the transaction is a
   * picture of a transaction, and 250ms of nothing per step reads as the
   * page being broken rather than as a chain being a chain.
   */
  txConfirmDelayMs?: number
  /**
   * Where this chain's state lives.
   *
   * `local` is the product: one chain per browser, surviving reloads.
   * `none` is a sandbox — nothing is read at startup and nothing is ever
   * written, so a second client can exist alongside the player's own
   * without the two ever seeing each other's rooms. There is exactly one
   * `localStorage` key, so a sandbox that persisted would not sit beside
   * the real chain, it would *be* the real chain.
   */
  persistence?: 'local' | 'none'
  /**
   * Whether blocks are mined on a timer.
   *
   * False freezes the clock: the chain advances only when `advanceBlocks`
   * asks it to. That is what a scripted demo needs — every countdown on
   * screen holds still, so stepping backwards shows the same numbers as
   * stepping forwards did, and nothing resolves while somebody is reading.
   */
  autoMine?: boolean
}

const GENESIS_SALT = 'aegylax-emulator-genesis'
const EPOCH_SALT = 'aegylax-emulator-epoch'
/**
 * The chain-level secret the protocol's sealing key is derived from
 * (ТЗ §4). Not part of `EmulatorState` and never persisted: a key written
 * into the same `localStorage` as the ciphertext it protects is not a key.
 * Deriving it from a constant is what lets it be the *same* key across
 * reloads without ever being stored.
 */
const PROTOCOL_SEALING_SALT = 'aegylax-emulator-protocol-seal'
/** Simulated wallet/chain latency so the UI has something real to show for "pending". */
const TX_CONFIRM_DELAY_MS = 250

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** ТЗ §8.2: the point has to be *inside* the sector the player chose, not merely labelled with it. */
function isInsideSector(point: DefensePoint): boolean {
  return (
    Number.isFinite(point.offsetX) &&
    Number.isFinite(point.offsetY) &&
    point.offsetX >= 0 &&
    point.offsetX <= 1 &&
    point.offsetY >= 0 &&
    point.offsetY <= 1
  )
}

/**
 * In-memory implementation of `BlockchainClient` (spec §45-47). It models
 * blocks/accounts/transactions/events like a real chain, and interprets
 * `writeContract` calls against an in-memory "game contract" state that
 * mirrors what a real Solidity contract would store. `ContractBlockchainClient`
 * implements the exact same interface against a real chain later.
 */
export class EmulatorBlockchainClient implements BlockchainClient {
  readonly mode = 'emulator' as const

  /**
   * Send Recon Probe (ТЗ §3, §5).
   *
   * The sealing lives here rather than in the game domain because it is
   * this implementation's answer to privacy, not the game's: the request is
   * sealed to the protocol's key, the answer comes back sealed to the
   * player's, and both keys are the emulator's own. A real deployment
   * replaces the whole mechanism without the domain layer noticing.
   */
  async sendReconProbe(
    from: Address,
    params: { lobbyId: Hash; attackId: string; probeId: string; aimDegrees?: number | null },
  ): Promise<{ tx: TransactionRecord; probe: ReconProbeRecord | null }> {
    const { tx, result } = await this.submitSealedAction(from, params.lobbyId, {
      op: 'RECON_PROBE',
      attackId: params.attackId,
      probeId: params.probeId,
      aimDegrees: params.aimDegrees ?? null,
    })
    // Handed back in the same call, the way the chain grants the hint in
    // the transaction that computes it. `PROBE_DELAY_BLOCKS` is still
    // charged — on the next probe and on Send Defense, in `runReconProbe`
    // and `runDefenseSubmit`.
    return { tx, probe: result?.op === 'RECON_PROBE' ? result.probe : null }
  }

  /**
   * Every probe this wallet has sent on this attack.
   *
   * Nothing is withheld: the emulator hands a reading back in the call that
   * paid for it, the way `sendProbe` grants the hint in its own
   * transaction. Safe to call whenever — already-seen probes are returned
   * again and the caller deduplicates.
   */
  async resolvePendingProbes(lobbyId: Hash, attackId: string, from: Address): Promise<ReconProbeRecord[]> {
    const who = from.toLowerCase()
    return [...this.state.reconProbes.values()].filter(
      (probe) =>
        probe.lobbyId === lobbyId &&
        probe.attackId === attackId &&
        probe.requestedBy.toLowerCase() === who,
    )
  }

  /**
   * Always zero.
   *
   * A pending probe is one that was paid for and could not be read, which
   * on chain is a handle waiting on the confidential network. The emulator
   * has no such gap — the reading comes back with the transaction — so
   * there is never one owed.
   */
  countPendingProbes(_lobbyId: Hash, _attackId: string, _from: Address): number {
    return 0
  }

  /** Send Defense (ТЗ §5). The coordinates go into the envelope and nowhere else. */
  async submitDefense(
    from: Address,
    params: { lobbyId: Hash; attackId: string; defensePoint: DefensePoint },
  ): Promise<{ tx: TransactionRecord; attempt: DefenseAttempt | null; defensePoint: DefensePoint | null }> {
    const { tx, result } = await this.submitSealedAction(from, params.lobbyId, {
      op: 'DEFENSE_SUBMIT',
      attackId: params.attackId,
      defensePoint: params.defensePoint,
    })
    const confirmed = result?.op === 'DEFENSE_SUBMIT' ? result : null
    return { tx, attempt: confirmed?.attempt ?? null, defensePoint: confirmed?.defensePoint ?? null }
  }

  /**
   * One private action, sealed and sent.
   *
   * Both in-round verbs go through here, and that is the point: everything
   * after the caller chooses what to put in the envelope — the function
   * name on the transaction, the size of its payload, the event it emits —
   * is identical whichever they chose.
   */
  private async submitSealedAction(
    from: Address,
    lobbyId: Hash,
    request: PrivateActionRequest,
  ): Promise<{ tx: TransactionRecord; result: PrivateActionResult | null }> {
    const sealingKey = await this.readContract('getSealingKey', {})
    const envelope = seal(request, sealingKey)
    const submitted = await this.writeContract('submitPrivateAction', { lobbyId, envelope }, from)
    const tx = await this.waitForTransaction(submitted.hash)
    if (tx.status !== 'confirmed') {
      throw new Error(tx.errorMessage ?? `Transaction ${tx.hash} did not confirm`)
    }
    const event = tx.events.find((log) => log.name === 'PrivateActionSubmitted')
    const sealedResult = event ? (event.payload as { sealedResult: SealedEnvelope }).sealedResult : null
    return { tx, result: sealedResult ? openPrivateResult(sealedResult, from) : null }
  }

  private readonly state: EmulatorState
  private readonly blockTimeMs: number
  private readonly txConfirmDelayMs: number
  private readonly persistence: 'local' | 'none'
  private readonly autoMine: boolean
  private readonly mapGrid: MapGridConfig
  private readonly genesisHash: Hash
  /**
   * Protocol-wide epoch reference. Per-lobby attack epochs count from the
   * block a lobby went ACTIVE; the protocol's own epoch counts from the
   * chain's genesis block, so it keeps advancing whether or not any lobby
   * exists. Both go through `getEpochFromBlock` — one epoch formula.
   */
  private readonly epochReference: ProtocolEpochReference
  private readonly protocolLimits: ProtocolLimits
  /**
   * The key everything private is sealed under (ТЗ §4, §11). Held on the
   * instance rather than in state so it is never serialized alongside the
   * envelopes it opens.
   */
  private readonly sealingKey: SealingKey
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private readonly waiters = new Map<Hash, Array<(record: TransactionRecord) => void>>()
  private readonly eventEmitter = new EventEmitter<GameEventName | 'all', EventLog>()
  private readonly blockEmitter = new EventEmitter<'block', number>()

  constructor(config: EmulatorBlockchainClientConfig) {
    this.blockTimeMs = config.blockTimeMs
    this.mapGrid = config.mapGrid
    this.genesisHash = keccak256(toHex(GENESIS_SALT))
    this.epochReference = { epochBlocks: config.epochBlocks, genesisBlock: config.initialBlock }
    this.protocolLimits = config.protocolLimits ?? defaultProtocolLimits
    this.sealingKey = deriveProtocolSealingKey(keccak256(toHex(PROTOCOL_SEALING_SALT)))
    this.txConfirmDelayMs = config.txConfirmDelayMs ?? TX_CONFIRM_DELAY_MS
    this.persistence = config.persistence ?? 'local'
    this.autoMine = config.autoMine ?? true
    // Rehydrate lobbies/participants/attacks/etc. from a previous session
    // in this browser so a page reload doesn't orphan an in-progress lobby
    // (spec §9). Falls back to fresh state if nothing was persisted — and a
    // sandbox never looks, so it always starts empty.
    this.state =
      this.persistence === 'none'
        ? createEmulatorState(config.initialBlock, this.genesisHash)
        : loadOrCreateEmulatorState(config.initialBlock, this.genesisHash)

    this.start()
  }

  /**
   * Starts mining blocks. Idempotent, and — crucially — callable again
   * after `dispose()`.
   *
   * React StrictMode mounts the provider, runs its effect cleanup, and
   * mounts it again against the same client instance. A ticker that could
   * only ever be started from the constructor was therefore stopped for
   * good on the first cleanup: the chain froze at its starting block, and
   * every block-derived readout in the app (the next-attack countdown, the
   * epoch, attack generation) froze with it.
   */
  start(): void {
    if (!this.autoMine) return
    if (this.tickTimer !== null || typeof window === 'undefined') return
    this.tickTimer = setInterval(() => {
      this.mineBlock()
      this.persist()
    }, this.blockTimeMs)
  }

  dispose(): void {
    if (this.tickTimer === null) return
    clearInterval(this.tickTimer)
    this.tickTimer = null
  }

  /** Synchronous, instant block advancement for tests (spec §45). */
  advanceBlocks(count: number): void {
    for (let i = 0; i < count; i++) this.mineBlock()
    this.persist()
  }

  private persist(): void {
    if (this.persistence === 'none') return
    saveEmulatorState(this.state)
  }

  /**
   * The tab's own directory: every operation this emulator has opened, after
   * lazy settlement. There is no indexer here — the list *is* the state —
   * and the wallet panel plus `/operations` both read from this rather than
   * from a backend that has never heard of these rooms.
   */
  inspect(): { lobbies: Lobby[]; participants: Participant[] } {
    for (const lobbyId of [...this.state.lobbies.keys()]) this.settleLobby(lobbyId)
    return {
      lobbies: [...this.state.lobbies.values()].map((lobby) => this.withSettlement(lobby)),
      participants: [...this.state.participants.values()],
    }
  }

  // -- Chain primitives -----------------------------------------------------

  async getBlockNumber(): Promise<number> {
    return this.state.currentBlockNumber
  }

  async getBlock(blockNumber?: number): Promise<Block> {
    const number = blockNumber ?? this.state.currentBlockNumber
    const block = this.state.blocks.get(number)
    if (!block) throw new Error(`Block ${number} has not been mined yet`)
    return block
  }

  async getBalance(address: Address): Promise<number> {
    return ensureAccount(this.state, address).balance
  }

  // -- Reads ------------------------------------------------------------------

  async readContract<TFn extends ContractReadFunctionName>(
    functionName: TFn,
    args: ContractReadArgsMap[TFn],
  ): Promise<ContractReadResultMap[TFn]> {
    return this.dispatchRead(functionName, args) as ContractReadResultMap[TFn]
  }

  private dispatchRead(
    functionName: ContractReadFunctionName,
    args: ContractReadArgsMap[ContractReadFunctionName],
  ): unknown {
    switch (functionName) {
      case 'getGameStats': {
        for (const lobbyId of this.state.lobbies.keys()) this.settleLobby(lobbyId)
        this.maybeSettleProtocolDraws()
        this.maybeTopUpGlobalDefense()
        this.maybeOpenGlobalDefense()
        return computeGameStats(
          this.state,
          this.epochReference,
          this.protocolLimits.globalDefenseEpochInterval,
        )
      }
      case 'getSealingKey':
        return this.sealingKey
      case 'getGlobalDefenseDraw': {
        for (const lobbyId of this.state.lobbies.keys()) this.settleLobby(lobbyId)
        this.maybeSettleProtocolDraws()
        this.maybeTopUpGlobalDefense()
        this.maybeOpenGlobalDefense()
        return computeGlobalDefenseDraw(
          this.state,
          this.epochReference,
          this.protocolLimits.globalDefenseEpochInterval,
        )
      }
      case 'getLobby': {
        const { lobbyId } = args as ContractReadArgsMap['getLobby']
        const lobby = this.settleLobby(lobbyId)
        return lobby ? this.withSettlement(lobby) : null
      }
      // Both participant reads settle first: `payoutState` is decided when
      // the attack resolves, and resolution is lazy, so reading a
      // participant without settling could report NONE to somebody the
      // protocol already owes a reward (ТЗ §17.2).
      case 'getLobbyParticipants': {
        const { lobbyId, viewer } = args as ContractReadArgsMap['getLobbyParticipants']
        const lobby = this.settleLobby(lobbyId)
        return [...this.state.participants.values()]
          .filter((p) => p.lobbyId === lobbyId)
          .map((p) => this.redactParticipant(p, viewer, lobby))
      }
      case 'getParticipant': {
        const { lobbyId, address, viewer } = args as ContractReadArgsMap['getParticipant']
        const lobby = this.settleLobby(lobbyId)
        const participant = this.state.participants.get(participantKey(lobbyId, address))
        return participant ? this.redactParticipant(participant, viewer, lobby) : null
      }
      case 'getActivityMap': {
        const { lobbyId, attackId } = args as ContractReadArgsMap['getActivityMap']
        const lobby = this.settleLobby(lobbyId)
        /*
         * ТЗ §4, §11 — nothing positional leaves the protocol before the
         * reveal, and a per-sector defender count is positional. Six
         * defenders showing up in one sector while the attack is in flight
         * would tell every onlooker where the good reconnaissance was
         * pointing, which is intelligence those onlookers did not pay for.
         *
         * So the map is empty until the operation opens, and then it is
         * complete. The grid still renders — the heatmap is part of the
         * screen's furniture, not a thing that appears — it simply has
         * nothing on it yet.
         */
        if (lobby?.reveal?.attackId !== attackId) return buildEmptyActivityMap(this.mapGrid)
        return this.state.activityMaps.get(attackKey(lobbyId, attackId)) ?? buildEmptyActivityMap(this.mapGrid)
      }
      case 'getAttackEpoch': {
        const { lobbyId, epochId } = args as ContractReadArgsMap['getAttackEpoch']
        this.settleLobby(lobbyId)
        return this.state.attackEpochs.get(epochKey(lobbyId, epochId)) ?? null
      }
      case 'getAttack': {
        const { lobbyId, attackId } = args as ContractReadArgsMap['getAttack']
        this.settleLobby(lobbyId)
        return this.state.attacks.get(attackKey(lobbyId, attackId)) ?? null
      }
      case 'getAttackReveal': {
        const { lobbyId, attackId } = args as ContractReadArgsMap['getAttackReveal']
        this.settleLobby(lobbyId)
        return this.buildReveal(lobbyId, attackId)
      }
      case 'getDefenseAttempts': {
        const { lobbyId, attackId, viewer } = args as ContractReadArgsMap['getDefenseAttempts']
        const lobby = this.settleLobby(lobbyId)
        /*
         * Two different answers, and the difference is the whole of ТЗ §7
         * and §11.
         *
         * Before the reveal *nobody* gets a plaintext coordinate — not even
         * the defender who placed it. Their own point comes back sealed to
         * their own key, which is enough for their screen to redraw the
         * locked marker after a reload and no use whatsoever to anyone
         * else. Everybody else's attempts come back with both fields null:
         * an attempt exists, and that is all.
         *
         * After the reveal the points are public protocol state, so they
         * arrive in the clear for every reader. Continuing to redact them
         * would be pretending they are still secret when the operation has
         * already published them.
         */
        const isRevealed = lobby?.reveal?.attackId === attackId
        return [...this.state.defenseAttempts.values()]
          .filter((attempt) => attempt.lobbyId === lobbyId && attempt.attackId === attackId)
          .map((attempt) => {
            if (isRevealed) return { ...attempt, defensePoint: this.openDefensePoint(attempt.id), sealedPoint: null }
            if (attempt.participant !== viewer) return attempt
            const point = this.openDefensePoint(attempt.id)
            return {
              ...attempt,
              sealedPoint: point ? seal(point, derivePlayerSealingKey(attempt.participant)) : null,
            }
          })
      }
      default:
        throw new Error(`Unknown read function: ${String(functionName)}`)
    }
  }

  // -- Writes -----------------------------------------------------------------

  async writeContract<TFn extends ContractWriteFunctionName>(
    functionName: TFn,
    args: ContractWriteArgsMap[TFn],
    from: Address,
  ): Promise<TransactionRecord> {
    const hash = this.generateTxHash(functionName, args, from)
    const value = 'value' in args ? (args as { value: number }).value : 0

    const record: TransactionRecord = {
      hash,
      functionName,
      args,
      from,
      value,
      status: 'pending',
      blockNumber: null,
      createdAt: Date.now(),
      confirmedAt: null,
      events: [],
      errorMessage: null,
    }
    this.state.transactions.set(hash, record)

    await delay(this.txConfirmDelayMs)

    try {
      const events = this.applyWrite(functionName, args, from, hash)
      record.status = 'confirmed'
      record.blockNumber = this.state.currentBlockNumber
      record.confirmedAt = Date.now()
      record.events = events
      events.forEach((event) => this.emitEvent(event))
    } catch (error) {
      record.status = 'failed'
      record.errorMessage = error instanceof Error ? error.message : String(error)
    }

    this.persist()
    this.resolveWaiters(record)
    return record
  }

  private applyWrite(
    functionName: ContractWriteFunctionName,
    args: ContractWriteArgsMap[ContractWriteFunctionName],
    from: Address,
    hash: Hash,
  ): EventLog[] {
    switch (functionName) {
      case 'createLobby':
        return this.applyCreateLobby(args as ContractWriteArgsMap['createLobby'], from, hash)
      case 'joinLobby':
        return this.applyJoinLobby(args as ContractWriteArgsMap['joinLobby'], from, hash)
      case 'leaveLobby':
        return this.applyLeaveLobby(args as ContractWriteArgsMap['leaveLobby'], from, hash)
      case 'buyDrone':
        return this.applyBuyDrone(args as ContractWriteArgsMap['buyDrone'], from, hash)
      case 'submitPrivateAction':
        return this.applyPrivateAction(args as ContractWriteArgsMap['submitPrivateAction'], from, hash)
      case 'revealAttack':
        return this.applyRevealAttack(args as ContractWriteArgsMap['revealAttack'], from, hash)
      case 'claimReward':
        return this.applyClaimReward(args as ContractWriteArgsMap['claimReward'], from, hash)
      case 'claimRefund':
        return this.applyClaimRefund(args as ContractWriteArgsMap['claimRefund'], from, hash)
      case 'settleCreator':
        return this.applySettleCreator(args as ContractWriteArgsMap['settleCreator'], from, hash)
      case 'openGlobalDefense':
        return this.applyOpenGlobalDefense(from, hash)
      case 'collectProbe':
        return []
      default:
        throw new Error(`Unknown write function: ${String(functionName)}`)
    }
  }

  private applyCreateLobby(args: ContractWriteArgsMap['createLobby'], from: Address, hash: Hash): EventLog[] {
    const nowMs = Date.now()
    // Layer 3 (spec §15): the form already validated this, but this is the
    // only path that can mint a lobby, so it validates again — against the
    // protocol's own limits, not anything the caller supplied.
    const errors = validateLobbyConfig(args.config, nowMs, this.protocolLimits)
    if (errors.length > 0) {
      throw new Error(`Invalid lobby config: ${errors.map((e) => e.message).join(' ')}`)
    }
    /*
     * ТЗ §17 — the bounty *and* the creator's own protocol fee. The fee is
     * charged once per seat and the creator holds the first one, so launching
     * an operation costs what joining one does on top of the pool being put
     * up. The contract enforces the same sum exactly.
     */
    const creationCost = args.config.economics.prizePool + args.config.economics.protocolJoinFee
    if (args.value < creationCost) {
      throw new Error('Deposited value is less than the prize pool plus the protocol fee')
    }
    // The bounty is escrowed by the protocol, not burned: an operation that
    // never runs has to be able to give it back (ТЗ §18).
    this.escrow(from, args.value)

    // Stored trimmed, so what the validator accepted is exactly what every
    // reader gets back — no lobby is ever named " Operation ".
    const config: LobbyConfig = { ...args.config, name: args.config.name.trim() }

    const lobby: Lobby = {
      id: hash,
      creationTxHash: hash,
      creator: from,
      createdAtBlock: this.state.currentBlockNumber,
      status: 'OPEN',
      // Nothing has ended yet — see `LobbyEnding`.
      ending: 'NONE',
      config,
      participantCount: 0,
      participantAddresses: [],
      // Bound at mint when the deadline is a block, the way the contract
      // schedules the threat — so a late settle cannot slide it forward and
      // a client can count down before anybody closes applications.
      currentEpochId: config.participation.deadlineBlock > 0 ? this.launchEpochForDeadline(config.participation.deadlineBlock) : null,
      activeAttackId: null,
      outcome: null,
      // Derived from the ledger on every read — see `withSettlement`.
      creatorSettlement: 0,
      creatorSettled: false,
      reveal: null,
    }
    this.state.lobbies.set(hash, lobby)
    const ledger = createLobbyLedger(config.economics.prizePool)
    // The protocol's creation fee, on the operation's books from mint.
    // Already in the treasury; never released if the room never fills.
    ledger.protocolFeeAccrued += config.economics.protocolJoinFee
    this.state.lobbyLedgers.set(hash, ledger)

    return [this.buildEvent(hash, 'LobbyCreated', { lobbyId: hash, creator: from, config })]
  }

  /**
   * Open the protocol's own Global Defense operation (ТЗ §18).
   *
   * Mirrors `Lobbies.openDraw`: the next interval epoch strictly after now,
   * the whole pool as the bounty, free to enter, no creator fee, owned by
   * the protocol. A draw nobody wins is an ordinary COMPLETED miss, so the
   * same forfeit line puts the money back; a draw nobody joins is UNPLAYED
   * and `settleCreator` returns it because this address is the creator.
   */
  private applyOpenGlobalDefense(from: Address, hash: Hash): EventLog[] {
    const interval = this.protocolLimits.globalDefenseEpochInterval
    if (interval <= 0) throw new Error('Global Defense draws are disabled')
    void from

    const current = this.protocolEpoch(this.state.currentBlockNumber)
    const epochId = (Math.floor(current / interval) + 1) * interval
    if (this.state.globalDefenseLobby.has(epochId)) throw new Error('A Global Defense draw is already open for this epoch')

    const pool = this.state.globalDefensePool
    if (pool <= 0) throw new Error('The Global Defense Pool is empty')

    const { epochBlocks, genesisBlock } = this.epochReference
    const schedule = globalDefenseSchedule({
      currentEpoch: current,
      intervalEpochs: interval,
      epochBlocks,
      genesisBlock,
      blockTimeMs: this.blockTimeMs,
      joinWindowMs: this.protocolLimits.globalDefenseJoinWindowMs,
    })
    if (!schedule) throw new Error('Global Defense draws are disabled')
    const deadlineBlock = schedule.deadlineBlock
    if (this.state.currentBlockNumber >= deadlineBlock) throw new Error('This draw epoch has already passed')
    if (this.state.currentBlockNumber < schedule.openFromBlock) {
      throw new Error('The Global Defense draw is not open yet')
    }

    const config: LobbyConfig = {
      name: 'Global Defense',
      participation: {
        minPlayers: this.protocolLimits.minPlayers,
        maxPlayers: this.protocolLimits.maxPlayers,
        entryPrice: 0,
        deadline: Date.now() + Math.max(1, deadlineBlock - this.state.currentBlockNumber) * this.blockTimeMs,
        deadlineBlock,
      },
      economics: {
        prizePool: 0,
        creatorFeePercent: 0,
        protocolJoinFee: this.protocolLimits.joinFee,
      },
      drones: {
        freeCount: this.protocolLimits.freeReconProbes,
        price: this.protocolLimits.reconProbePrice,
        maxCount: this.protocolLimits.maxReconProbes,
      },
      attack: {
        epochBlocks: this.protocolLimits.epochBlocks,
        sectorSpanKm: this.protocolLimits.sectorSpanKm,
        interceptionRadiusSectors: this.protocolLimits.interceptionRadiusSectors,
        defenseSpeedKmPerBlock: this.protocolLimits.defenseSpeedKmPerBlock,
      },
      payout: { rewardAsset: { kind: 'ETH' } },
    }

    const lobby: Lobby = {
      id: hash,
      creationTxHash: hash,
      creator: PROTOCOL_ESCROW_ADDRESS,
      createdAtBlock: this.state.currentBlockNumber,
      status: 'OPEN',
      ending: 'NONE',
      config,
      participantCount: 0,
      participantAddresses: [],
      // Bound at mint, the way the contract schedules the threat for the
      // epoch after the deadline — so a late settle cannot slide it forward.
      currentEpochId: epochId,
      activeAttackId: null,
      outcome: null,
      creatorSettlement: 0,
      creatorSettled: false,
      reveal: null,
    }
    this.state.lobbies.set(hash, lobby)
    // The pile stays in `globalDefensePool` until the round starts, same as
    // `Lobbies.openDraw`. A ledger funded at mint would double-count on
    // cancel: pay the bounty back into a pool that never left.
    this.state.lobbyLedgers.set(hash, createLobbyLedger(0))
    this.state.globalDefenseLobby.set(epochId, hash)
    /*
     * What the room is playing for, written down at mint.
     *
     * Nothing else records it: the pile is still `globalDefensePool`, and a
     * draw that ends unplayed hands it straight back without ever having
     * held it. Without this the row for that round can only say 0 — which
     * is arithmetically true of a lobby that never escrowed anything, and a
     * lie about the operation somebody was looking at.
     */
    this.state.globalDefenseBounty.set(hash, pool)

    return [
      this.buildEvent(hash, 'LobbyCreated', { lobbyId: hash, creator: PROTOCOL_ESCROW_ADDRESS, config }),
      this.buildEvent(hash, 'GlobalDefenseOpened', { epochId, lobbyId: hash, pool }),
    ]
  }

  private applyJoinLobby(args: ContractWriteArgsMap['joinLobby'], from: Address, hash: Hash): EventLog[] {
    const lobby = this.requireLobby(args.lobbyId)
    if (!canJoinLobby(lobby, Date.now(), this.state.currentBlockNumber)) {
      throw new Error('Lobby is not open for joining')
    }
    const protocolOwned = lobby.creator === PROTOCOL_ESCROW_ADDRESS
    const cost = calculateParticipantCost(
      lobby.config.participation.entryPrice,
      lobby.config.economics.creatorFeePercent,
      protocolOwned,
    )
    if (args.value < cost) {
      throw new Error(`Join value ${args.value} is below required entry cost ${cost}`)
    }
    this.escrow(from, cost)

    const ledger = this.requireLedger(lobby.id)
    const commission = protocolOwned
      ? 0
      : calculateAuthorCommission(
          lobby.config.participation.entryPrice,
          lobby.config.economics.creatorFeePercent,
        )
    ledger.entryFeesCollected += lobby.config.participation.entryPrice
    ledger.creatorFeeAccrued += commission

    const participant: Participant = {
      lobbyId: lobby.id,
      address: from,
      joinTxHash: hash,
      joinedAtBlock: this.state.currentBlockNumber,
      freeDronesRemaining: lobby.config.drones.freeCount,
      purchasedDrones: 0,
      actionCount: 0,
      probeIds: [],
      defenseAttemptIds: [],
      payoutState: 'NONE',
      paidIn: cost,
      probesPaid: 0,
      refunded: false,
      lastProbeBlock: 0,
    }
    this.state.participants.set(participantKey(lobby.id, from), participant)
    lobby.participantCount += 1
    lobby.participantAddresses.push(from)

    return [this.buildEvent(hash, 'LobbyJoined', { lobbyId: lobby.id, participant: from })]
  }

  /**
   * Leave Operation (ТЗ §5).
   *
   * The window is exactly the one the operation is still forming in: while
   * applications are OPEN, a seat is a reservation and giving it back costs
   * nobody anything. The moment the lobby goes ACTIVE the attack has been
   * scheduled against a defender count that is now part of the operation's
   * economics, so the seat is committed and this rejects.
   *
   * The refund is everything this address actually paid *into* the
   * operation — entry, the author's commission, and any Recon Probes
   * bought — because nothing it paid for was ever delivered.
   */
  private applyLeaveLobby(args: ContractWriteArgsMap['leaveLobby'], from: Address, hash: Hash): EventLog[] {
    const lobby = this.requireLobby(args.lobbyId)
    this.settleLobby(lobby.id)
    if (lobby.status !== 'OPEN') {
      throw new Error('This operation has already started — defenders are committed to it')
    }
    const participant = this.requireParticipant(lobby.id, from)

    // What they actually paid, rather than what the current config says a
    // seat costs — the two can only agree by luck once probes are involved.
    const refund = participant.paidIn
    const probeRefund = participant.probesPaid

    const ledger = this.requireLedger(lobby.id)
    const consumed = probeRefund + lobby.config.participation.entryPrice
    const commissionPaid = Math.max(0, refund - consumed)
    ledger.entryFeesCollected -= lobby.config.participation.entryPrice
    ledger.creatorFeeAccrued -= commissionPaid
    ledger.probeFeesCollected -= probeRefund
    ledger.rewardPool -= probeRefund

    this.state.participants.delete(participantKey(lobby.id, from))
    lobby.participantCount = Math.max(0, lobby.participantCount - 1)
    lobby.participantAddresses = lobby.participantAddresses.filter((address) => address !== from)
    this.payOut(from, refund)

    return [this.buildEvent(hash, 'LobbyLeft', { lobbyId: lobby.id, participant: from, refunded: refund })]
  }

  private applyBuyDrone(args: ContractWriteArgsMap['buyDrone'], from: Address, hash: Hash): EventLog[] {
    const lobby = this.requireLobby(args.lobbyId)
    this.settleLobby(lobby.id)
    if (lobby.status !== 'OPEN' && lobby.status !== 'READY' && lobby.status !== 'ACTIVE') {
      throw new Error('This operation has ended')
    }
    const participant = this.requireParticipant(lobby.id, from)
    // ТЗ §14.3 sells extra probes, and §5.3 makes them useful right up to
    // Send Defense — so the sale closes at the same moment reconnaissance
    // does, not at launch.
    if (participant.defenseAttemptIds.length > 0) {
      throw new Error('Defense has already been submitted — reconnaissance is closed')
    }
    const ownedTotal = lobby.config.drones.freeCount + participant.purchasedDrones
    if (ownedTotal >= lobby.config.drones.maxCount) {
      throw new Error('Maximum Recon Probe count reached for this operation')
    }
    if (args.value < lobby.config.drones.price) {
      throw new Error(`Probe purchase value ${args.value} is below price ${lobby.config.drones.price}`)
    }
    this.escrow(from, lobby.config.drones.price)

    participant.purchasedDrones += 1
    participant.paidIn += lobby.config.drones.price
    participant.probesPaid += lobby.config.drones.price
    // ТЗ §14.3 — money a defender spends on intelligence stays in the
    // operation and raises the bounty rather than becoming a protocol fee.
    const ledger = this.requireLedger(lobby.id)
    ledger.probeFeesCollected += lobby.config.drones.price
    ledger.rewardPool += lobby.config.drones.price

    return [
      this.buildEvent(hash, 'DronePurchased', {
        lobbyId: lobby.id,
        participant: from,
        droneId: hash,
        price: lobby.config.drones.price,
      }),
    ]
  }

  /**
   * The one in-round write (ТЗ §4, §5), and the shape of every private
   * computation in the game:
   *
   *   open the envelope -> run the action against sealed state ->
   *   seal the answer to the player who asked -> publish nothing else.
   *
   * The dispatch on `op` happens *after* decryption, which is the point. A
   * contract that branched on a public function selector would announce
   * which branch it took; this one takes an envelope every observer sees as
   * 512 bytes of noise, and emits an event whose only readable fields are
   * "this lobby" and "this address". Whether that was a Recon Probe or the
   * final Defense — and any coordinate either carried — never exists in the
   * clear outside this method.
   *
   * ТЗ §5's other half is structural rather than written down here: this is
   * one action per transaction, so three probes and a Defense are four
   * signatures. Nothing batches them.
   */
  private applyPrivateAction(
    args: ContractWriteArgsMap['submitPrivateAction'],
    from: Address,
    hash: Hash,
  ): EventLog[] {
    const lobby = this.requireLobby(args.lobbyId)
    this.settleLobby(lobby.id)

    const request = unseal<PrivateActionRequest>(args.envelope, this.sealingKey)
    const result =
      request.op === 'RECON_PROBE'
        ? this.runReconProbe(lobby, request, from, hash)
        : this.runDefenseSubmit(lobby, request, from, hash)

    const participant = this.requireParticipant(lobby.id, from)
    participant.actionCount += 1

    return [
      this.buildEvent(hash, 'PrivateActionSubmitted', {
        lobbyId: lobby.id,
        participant: from,
        // Sealed to the one wallet entitled to it (ТЗ §11). Every other
        // client sees this event and can read nothing out of it.
        sealedResult: seal(result, derivePlayerSealingKey(from)),
      }),
    ]
  }

  /**
   * Send Recon Probe (ТЗ §1.1, §3).
   *
   * There is no sector in the request and none in the answer. One probe
   * sweeps the whole working area, and what comes back is a search bearing
   * with an uncertainty cone around it — the private computation's output on
   * this player's own transaction, sealed to them and delivered once.
   *
   * The probe's index within *this participant's* own run is what seeds the
   * draw, so their second probe genuinely disagrees with their first and
   * the two fuse into something sharper (§3). It is deliberately not a
   * global counter: whether another defender has already scanned must not
   * change what this one is told.
   */
  private runReconProbe(
    lobby: Lobby,
    args: Extract<PrivateActionRequest, { op: 'RECON_PROBE' }>,
    from: Address,
    hash: Hash,
  ): PrivateActionResult {
    const participant = this.requireParticipant(lobby.id, from)
    const ownedTotal = lobby.config.drones.freeCount + participant.purchasedDrones
    if (participant.probeIds.length >= ownedTotal) {
      throw new Error('No Recon Probes remaining for this participant')
    }
    if (participant.lastProbeBlock > 0 && this.state.currentBlockNumber < participant.lastProbeBlock + PROBE_DELAY_BLOCKS) {
      throw new Error('The previous probe is still in flight')
    }
    // ТЗ §5.3: probes are spent up to the final Send Defense, not up to
    // launch — reconnaissance is the only channel a defender has, and
    // submitting is what closes it.
    if (participant.defenseAttemptIds.length > 0) {
      throw new Error('Defense has already been submitted — reconnaissance is closed')
    }
    const attack = this.state.attacks.get(attackKey(lobby.id, args.attackId))
    if (!attack) throw new Error('Attack not found')
    // ТЗ §4.4, §6.1: reconnaissance opens when the attack launches, not
    // when it is scheduled. There is nothing in flight to scan before that.
    if (attack.status === 'PENDING') throw new Error('The attack has not launched yet')
    if (attack.status === 'RESOLVED') throw new Error('The attack has already resolved')
    // The private computation, in the literal sense: the geometry is opened
    // here, used, and never returned. Nothing that leaves this method
    // carries a coordinate (ТЗ §3, §11).
    const trajectory = this.openTrajectory(lobby.id, args.attackId)

    const world = this.worldFor(lobby.config)
    const firstProbe = participant.probeIds[0] ? this.state.reconProbes.get(participant.probeIds[0]) : undefined
    const seed = this.epochSeedFor(lobby, attack.epochId)
    const aimInsideCloud =
      firstProbe && Number.isFinite(firstProbe.bearingDegrees)
        ? aimInsideFirstCloud(
            firstProbe.bearingDegrees,
            firstProbe.uncertaintyDegrees,
            seed,
            participant.probeIds.length,
          )
        : null

    const result = generateReconProbeResult(
      trajectory,
      attack.epochId,
      participant.probeIds.length,
      world,
      seed,
      this.state.currentBlockNumber,
      participant.probeIds.length === 0 ? null : (args.aimDegrees ?? aimInsideCloud),
      flightProgress(attack, this.state.currentBlockNumber),
    )

    const record: ReconProbeRecord = {
      ...result,
      id: hash,
      lobbyId: lobby.id,
      attackId: args.attackId,
      probeId: args.probeId,
      requestedBy: from,
      txHash: hash,
    }
    this.state.reconProbes.set(hash, record)
    participant.probeIds.push(hash)
    participant.lastProbeBlock = this.state.currentBlockNumber
    participant.freeDronesRemaining = Math.max(0, lobby.config.drones.freeCount - participant.probeIds.length)

    // Nothing goes on the public activity map: a probe has no sector, so
    // there is no cell it could be counted against (ТЗ §1.1).
    return { op: 'RECON_PROBE', probe: record }
  }

  /**
   * Send Defense (ТЗ §6). Every guard here has a twin in the UI's
   * `defenseBlockedReason`, and this is the one that counts: the button
   * only decides what the player sees, while a re-enabled control, a
   * modified bundle or a direct call all land in this method.
   *
   * ТЗ §6 is one rule seen from two sides — a participant gets exactly one
   * Defense Point, and once it is locked neither its sector nor its
   * coordinates can be touched again.
   */
  private runDefenseSubmit(
    lobby: Lobby,
    args: Extract<PrivateActionRequest, { op: 'DEFENSE_SUBMIT' }>,
    from: Address,
    hash: Hash,
  ): PrivateActionResult {
    if (!isValidSector(args.defensePoint.sector, this.mapGrid)) {
      throw new Error('Sector is outside the configured map grid')
    }
    if (!isInsideSector(args.defensePoint)) {
      throw new Error('Defense Point must lie inside the selected sector')
    }
    const participant = this.requireParticipant(lobby.id, from)
    if (participant.defenseAttemptIds.length > 0) {
      throw new Error('Defense has already been submitted and cannot be changed')
    }
    // The other half of `PROBE_DELAY_BLOCKS`, and the reason a reading is
    // handed over in the block that paid for it: reconnaissance costs time,
    // so a hint cannot be spent on a Defense Point until the delay is
    // served. Mirrors `AegylaxGame.submitDefense`.
    if (
      participant.lastProbeBlock > 0 &&
      this.state.currentBlockNumber < participant.lastProbeBlock + PROBE_DELAY_BLOCKS
    ) {
      throw new Error('The last Recon Probe is still in flight — Defense opens once it lands')
    }
    const attack = this.state.attacks.get(attackKey(lobby.id, args.attackId))
    if (!attack) throw new Error('Attack not found')
    // ТЗ §4.5, §8.1: the grid unlocks at launch, so a Defense Point placed
    // before the attack exists in the sky is not a defense of anything.
    if (attack.status === 'PENDING') throw new Error('The attack has not launched yet')
    if (attack.status === 'RESOLVED') throw new Error('The attack has already resolved')

    /*
     * The attempt the protocol stores carries no coordinate at all
     * (ТЗ §7, §11). The point goes into `sealedDefensePoints` as ciphertext
     * under the protocol's key, which is the only copy that exists: opened
     * for resolution, resealed to its owner on request, published at the
     * reveal.
     *
     * Keeping the record itself coordinate-free is what makes the read path
     * safe by construction rather than by remembering — there is no field
     * on this object for a future `getDefenseAttempts` variant to forget to
     * strip.
     */
    const attempt: DefenseAttempt = {
      id: hash,
      lobbyId: lobby.id,
      attackId: args.attackId,
      participant: from,
      defensePoint: null,
      sealedPoint: null,
      submittedAtBlock: this.state.currentBlockNumber,
      submittedAtTimestamp: Date.now(),
      txHash: hash,
    }
    this.state.defenseAttempts.set(hash, attempt)
    this.state.sealedDefensePoints.set(hash, seal(args.defensePoint, this.sealingKey))
    participant.defenseAttemptIds.push(hash)

    // Accumulated now, published only at the reveal — see `getActivityMap`.
    const mapKey = attackKey(lobby.id, args.attackId)
    const activity = this.state.activityMaps.get(mapKey) ?? buildEmptyActivityMap(this.mapGrid)
    const cell = activity.find(
      (c) =>
        c.sector.column === args.defensePoint.sector.column && c.sector.row === args.defensePoint.sector.row,
    )
    if (cell) cell.defenseAttemptCount += 1
    this.state.activityMaps.set(mapKey, activity)

    // The player's own coordinate handed back to the player, sealed on the
    // way out by `applyPrivateAction`. This is the only channel by which a
    // Defense Point travels before the reveal, and it reaches exactly one
    // wallet (ТЗ §11).
    return { op: 'DEFENSE_SUBMIT', attempt, defensePoint: args.defensePoint }
  }

  // -- Lazy lobby/epoch/attack settlement --------------------------------------

  /**
   * Brings a lobby's status/epoch/attack state up to date with the current
   * block. Called at the top of any read/write that touches a lobby —
   * there is no background scheduler (spec §58 forbids server-side
   * schedulers; this keeps everything driven by explicit block advancement).
   */
  private settleLobby(lobbyId: Hash): Lobby | undefined {
    const lobby = this.state.lobbies.get(lobbyId)
    if (!lobby) return undefined
    const nowMs = Date.now()

    if (lobby.status === 'OPEN') {
      const { deadline, deadlineBlock } = lobby.config.participation
      const deadlinePassed =
        deadlineBlock > 0 ? this.state.currentBlockNumber >= deadlineBlock : nowMs >= deadline
      if (deadlinePassed) {
        if (lobby.participantCount >= lobby.config.participation.minPlayers) {
          lobby.status = 'READY'
        } else {
          /*
           * Freeze what the draw was playing for before it hands the room
           * back. Later misses keep growing `globalDefensePool`, so the
           * figure recorded at mint is already stale by now, and after this
           * transition the pile is the *next* draw's.
           */
          if (lobby.creator === PROTOCOL_ESCROW_ADDRESS) {
            this.state.globalDefenseBounty.set(lobbyId, this.state.globalDefensePool)
          }
          lobby.status = 'CANCELLED'
          lobby.ending = 'UNPLAYED'
          this.payoutUnplayed(lobby)
          this.emitEvent(
            this.buildEvent(lobby.creationTxHash, 'LobbyCancelled', {
              lobbyId,
              reason: 'Minimum participants not met by deadline',
            }),
          )
        }
      }
    }

    // Applications close, and the protocol schedules the operation's one
    // attack at a future epoch boundary with the same 90% remaining-epoch
    // cushion the chain uses — so a deadline in the last tenth of an epoch
    // cannot fire the attack on the next block. The operation's epoch clock
    // is the protocol's, so every operation that closes in the same window
    // launches on the same boundary.
    if (lobby.status === 'READY') {
      const epochId = lobby.currentEpochId ?? this.launchEpochFor(lobby)
      /*
       * ТЗ §14.4-14.6 — the moment fees stop being refundable, and the only
       * one. Up to here every ETH in the operation belongs to whoever put it
       * in; from here the Creator Fee is the creator's whatever happens, and
       * what the entry fees leave behind becomes part of what the winner
       * takes. Entry fees are neither burned nor handed to the creator a
       * second time — the reward pool is the one destination that is true to
       * §14.11's "it never leaves this operation".
       */
      const ledger = this.requireLedger(lobbyId)
      if (lobby.creator === PROTOCOL_ESCROW_ADDRESS) {
        const pooled = this.state.globalDefensePool
        if (pooled > 0) {
          this.state.globalDefensePool = 0
          ledger.rewardPool += pooled
          ledger.startPrizePool += pooled
          lobby.config = {
            ...lobby.config,
            economics: { ...lobby.config.economics, prizePool: ledger.startPrizePool },
          }
        }
      }
      ledger.rewardPool += ledger.entryFeesCollected

      lobby.status = 'ACTIVE'
      lobby.currentEpochId = epochId
      this.state.lobbyActiveStartBlock.set(lobbyId, this.state.currentBlockNumber)
      this.scheduleAttack(lobby, epochId)
      this.emitEvent(this.buildEvent(lobby.creationTxHash, 'LobbyStarted', { lobbyId, epochId }))
    }

    if (lobby.status === 'ACTIVE') this.advanceAttack(lobby)

    return lobby
  }

  /**
   * Pays every defender `paidIn` and returns the bounty to the creator.
   * Mirrors `cancelLobby` on chain: the under-filled room's refunds move
   * in the same moment the status does. The protocol creation fee stays.
   */
  private payoutUnplayed(lobby: Lobby): void {
    for (const address of [...lobby.participantAddresses]) {
      const participant = this.state.participants.get(participantKey(lobby.id, address))
      if (!participant || participant.refunded || participant.paidIn <= 0) continue
      const due = participant.paidIn
      participant.refunded = true
      this.payOut(address, due)
      this.emitEvent(
        this.buildEvent(lobby.creationTxHash, 'RefundClaimed', {
          lobbyId: lobby.id,
          participant: address,
          amount: due,
        }),
      )
    }

    const ledger = this.requireLedger(lobby.id)
    if (ledger.creatorSettled) return
    const bounty = ledger.startPrizePool
    ledger.creatorSettled = true
    if (bounty <= 0) return

    if (lobby.creator === PROTOCOL_ESCROW_ADDRESS) {
      this.state.globalDefensePool += bounty
      this.emitEvent(
        this.buildEvent(lobby.creationTxHash, 'DefensePoolFunded', {
          lobbyId: lobby.id,
          amount: bounty,
          pool: this.state.globalDefensePool,
        }),
      )
      return
    }

    this.payOut(lobby.creator, bounty)
    this.emitEvent(
      this.buildEvent(lobby.creationTxHash, 'CreatorSettled', {
        lobbyId: lobby.id,
        creator: lobby.creator,
        amount: bounty,
      }),
    )
  }

  /**
   * The emulator's in-process keeper: when the join window opens, mint the
   * protocol's own lobby without a wallet and without a server.
   *
   * On chain the same moment is a side effect of an ordinary write
   * (`maybeOpenDraw`). Here there is no gas and no deployer key, so the
   * block ticker itself is enough.
   */
  private maybeOpenGlobalDefense(): void {
    if (!this.isGlobalDefenseDue()) return
    const hash = this.generateTxHash('openGlobalDefense', {}, PROTOCOL_ESCROW_ADDRESS)
    const events = this.applyOpenGlobalDefense(PROTOCOL_ESCROW_ADDRESS, hash)
    events.forEach((event) => this.emitEvent(event))
  }

  /**
   * Fold the idle pool into an already-minted draw that has not launched.
   *
   * Mirrors `Lobbies.topUpDraw`: a miss during the join window should grow
   * the bounty players are looking at, not wait for the next interval.
   */
  private maybeTopUpGlobalDefense(): void {
    const extra = this.state.globalDefensePool
    if (extra <= 0) return
    const interval = this.protocolLimits.globalDefenseEpochInterval
    if (interval <= 0) return
    const current = this.protocolEpoch(this.state.currentBlockNumber)
    const epochId = (Math.floor(current / interval) + 1) * interval
    const drawId = this.state.globalDefenseLobby.get(epochId)
    if (!drawId) return
    const draw = this.state.lobbies.get(drawId)
    if (!draw || draw.status === 'ACTIVE' || draw.status === 'RESOLVED' || draw.status === 'CANCELLED') return
    if (draw.creator === PROTOCOL_ESCROW_ADDRESS && draw.status === 'OPEN') return
    const ledger = this.state.lobbyLedgers.get(drawId)
    if (!ledger) return

    this.state.globalDefensePool = 0
    ledger.rewardPool += extra
    ledger.startPrizePool += extra
    draw.config = {
      ...draw.config,
      economics: { ...draw.config.economics, prizePool: ledger.startPrizePool },
    }
    this.emitEvent(
      this.buildEvent(draw.creationTxHash, 'DefensePoolFunded', {
        lobbyId: drawId,
        amount: extra,
        pool: 0,
      }),
    )
  }

  private isGlobalDefenseDue(): boolean {
    const interval = this.protocolLimits.globalDefenseEpochInterval
    if (interval <= 0 || this.state.globalDefensePool <= 0) return false
    const current = this.protocolEpoch(this.state.currentBlockNumber)
    const epochId = (Math.floor(current / interval) + 1) * interval
    if (this.state.globalDefenseLobby.has(epochId)) return false
    const schedule = globalDefenseSchedule({
      currentEpoch: current,
      intervalEpochs: interval,
      epochBlocks: this.epochReference.epochBlocks,
      genesisBlock: this.epochReference.genesisBlock,
      blockTimeMs: this.blockTimeMs,
      joinWindowMs: this.protocolLimits.globalDefenseJoinWindowMs,
    })
    if (!schedule) return false
    const block = this.state.currentBlockNumber
    return block >= schedule.openFromBlock && block < schedule.deadlineBlock
  }

  /**
   * An unplayed protocol-owned draw returns its bounty to the pool on read,
   * the way the emulator lazily settles every other clock transition.
   *
   * On chain this is a permissionless `settleCreator`; here there is no
   * wallet to prompt, and leaving the money stranded until somebody happened
   * to send that write would hide a rollover the contract performs as soon
   * as anyone notices.
   */
  private maybeSettleProtocolDraws(): void {
    for (const lobby of this.state.lobbies.values()) {
      if (lobby.creator !== PROTOCOL_ESCROW_ADDRESS) continue
      if (lobby.ending !== 'UNPLAYED' && lobby.ending !== 'CANCELLED') continue
      const ledger = this.state.lobbyLedgers.get(lobby.id)
      if (!ledger || ledger.creatorSettled) continue
      const amount = ledger.startPrizePool
      if (amount <= 0) continue
      ledger.creatorSettled = true
      this.state.globalDefensePool += amount
      this.emitEvent(
        this.buildEvent(lobby.creationTxHash, 'DefensePoolFunded', {
          lobbyId: lobby.id,
          amount,
          pool: this.state.globalDefensePool,
        }),
      )
    }
  }

  /**
   * Attaches the jackpot a protocol draw is playing for.
   *
   * While the room is still taking applications that is the live idle pile
   * — later misses grow it, and `topUpDraw` deliberately leaves it outside
   * an OPEN draw — so it is read here rather than copied onto the lobby at
   * mint. Once the round is over the frozen figure is what it advertised.
   * See `drawPrizePool`, which is what turns this into a printable pool.
   */
  private withDrawBounty(lobby: Lobby): Lobby {
    if (lobby.creator !== PROTOCOL_ESCROW_ADDRESS) return lobby
    const live = lobby.status === 'CREATED' || lobby.status === 'OPEN' || lobby.status === 'READY'
    const bounty = live
      ? this.state.globalDefensePool
      : (this.state.globalDefenseBounty.get(lobby.id) ?? 0)
    return { ...lobby, drawBounty: bounty }
  }

  /**
   * The creator's outstanding settlement, computed on read rather than
   * stored on the lobby (ТЗ §14.6).
   *
   * It is a function of the ledger and the outcome, both of which move —
   * probes bought, defenders leaving, a winner claiming — so a copy written
   * onto the lobby would be one more thing that can go stale. The figure is
   * what the settlement pays (or paid): zeroing it after `creatorSettled`
   * is how a reload printed "Paid out to your wallet — 0".
   */
  private withSettlement(lobby: Lobby): Lobby {
    const ledger = this.state.lobbyLedgers.get(lobby.id)
    if (!ledger) return this.withDrawBounty(lobby)

    let amount = 0
    if (lobby.status === 'CANCELLED' || lobby.ending === 'UNPLAYED' || lobby.ending === 'CANCELLED') {
      amount = ledger.startPrizePool
    } else if (lobby.status === 'RESOLVED') {
      const outcome = lobby.outcome
      const paidToWinners = outcome?.intercepted ? outcome.rewardPerWinner * outcome.winners.length : 0
      amount = ledger.creatorFeeAccrued + Math.max(0, ledger.rewardPool - paidToWinners)
    }
    return this.withDrawBounty({ ...lobby, creatorSettlement: amount, creatorSettled: ledger.creatorSettled })
  }

  private protocolEpoch(blockNumber: number): number {
    return getEpochFromBlock(blockNumber, this.epochReference.epochBlocks, this.epochReference.genesisBlock)
  }

  /**
   * Player-created operations use the same 90% remaining-epoch cushion as
   * the chain. Global Defense already names its epoch and is bound at mint.
   */
  private launchEpochFor(lobby: Lobby): number {
    const deadlineBlock = lobby.config.participation.deadlineBlock
    return this.launchEpochForDeadline(deadlineBlock > 0 ? deadlineBlock : this.state.currentBlockNumber)
  }

  private launchEpochForDeadline(deadlineBlock: number): number {
    return launchEpochOf(deadlineBlock, this.epochReference.epochBlocks, this.epochReference.genesisBlock)
  }

  /**
   * Generates the operation's single attack and files it under its launch
   * epoch. The trajectory goes into a separate map that no read path
   * touches while the attack is unresolved (ТЗ §3.3-3.5), so
   * "generated privately" is enforced by where the data lives rather than
   * by every reader remembering not to look.
   */
  private scheduleAttack(lobby: Lobby, epochId: number): void {
    const { epochBlocks } = this.epochReference
    const genesisBlock = this.epochReference.genesisBlock
    const startBlock = getEpochStartBlock(epochId, epochBlocks, genesisBlock)
    const endBlock = getEpochEndBlock(epochId, epochBlocks, genesisBlock)
    const seed = this.epochSeedFor(lobby, epochId)

    const chainRef: ChainTimeReference = {
      blockNumber: this.state.currentBlockNumber,
      timestamp: Date.now(),
      avgBlockTimeMs: this.blockTimeMs,
    }

    const { attack, trajectory } = generateAttack(
      lobby.id,
      { epochId, startBlock, seed },
      { epochBlocks: lobby.config.attack.epochBlocks },
      this.worldFor(lobby.config),
      chainRef,
    )

    const epoch: AttackEpoch = {
      lobbyId: lobby.id,
      epochId,
      startBlock,
      endBlock,
      seed,
      attackIds: [attack.id],
    }
    this.state.attackEpochs.set(epochKey(lobby.id, epochId), epoch)

    const key = attackKey(lobby.id, attack.id)
    this.state.attacks.set(key, attack)
    // ТЗ §4: startPoint and targetPoint are encrypted from the moment they
    // are generated. This is the only write of the geometry there is, and
    // what it writes is ciphertext.
    this.state.sealedTrajectories.set(key, seal(trajectory, this.sealingKey))
    this.state.activityMaps.set(key, buildEmptyActivityMap(this.mapGrid))
    lobby.activeAttackId = attack.id

    this.emitEvent(this.buildEvent(lobby.creationTxHash, 'AttackStarted', { lobbyId: lobby.id, attack }))
  }

  /** PENDING -> LAUNCHED at the launch block, LAUNCHED -> RESOLVED at impact. */
  private advanceAttack(lobby: Lobby): void {
    if (!lobby.activeAttackId) return
    const attack = this.state.attacks.get(attackKey(lobby.id, lobby.activeAttackId))
    if (!attack || attack.status === 'RESOLVED') return

    if (attack.status === 'PENDING' && this.state.currentBlockNumber >= attack.launchBlock) {
      attack.status = 'LAUNCHED'
    }
    if (attack.status === 'LAUNCHED' && this.state.currentBlockNumber >= attack.impactBlock) {
      this.resolveAttack(lobby, attack)
    }
  }

  /**
   * The end of an operation (ТЗ §12): the attack reaches its target, every
   * locked Defense Point is judged against the real trajectory, and the
   * lobby closes. An operation has one attack, so this runs exactly once.
   *
   * Two things this deliberately does *not* do. It does not publish the
   * trajectory — that waits for a player to ask (§13.1), and the geometry
   * stays in `attackTrajectories` until then. And it does not pay the
   * winner: rewards move only through `claimReward`, which re-checks every
   * condition §15 lists (§17.2). What resolution produces is the verdict
   * the claim will be checked against, nothing more.
   */
  private resolveAttack(lobby: Lobby, attack: Attack): void {
    const key = attackKey(lobby.id, attack.id)
    const trajectory = this.openTrajectory(lobby.id, attack.id)

    const world = this.worldFor(lobby.config)
    const interceptionRadiusKm = lobby.config.attack.interceptionRadiusSectors * world.sectorSpanKm
    const defenseSpeedKmPerBlock = lobby.config.attack.defenseSpeedKmPerBlock
    /*
     * Judging is the second private computation (ТЗ §11): both halves —
     * the trajectory and every Defense Point — are opened here, compared,
     * and closed again. What survives is `AttackOutcome` and the per-attempt
     * `DefenseResult`s, which say *whether* and *when* each defender
     * intercepted and never *where* anybody was.
     */
    const attempts = [...this.state.defenseAttempts.values()]
      .filter((attempt) => attempt.lobbyId === lobby.id && attempt.attackId === attack.id)
      .map((attempt) => ({ ...attempt, defensePoint: this.openDefensePoint(attempt.id) }))
    const resolution = resolveAttackDefenses(
      attempts,
      attack,
      trajectory,
      world,
      interceptionRadiusKm,
      defenseSpeedKmPerBlock,
    )

    // ТЗ §17.1: a failed defense pays no rewards at all, so the pool is
    // only ever split when the attack was actually stopped. What it splits
    // is the operation's own escrowed pool, not a figure recomputed from the
    // config — probes bought and defenders who left both move it.
    const ledger = this.requireLedger(lobby.id)
    const rewardPerWinner = resolution.intercepted
      ? calculateRewardPerWinner(ledger.rewardPool, resolution.winners.length)
      : 0

    attack.status = 'RESOLVED'
    this.state.defenseResults.set(key, resolution.results)

    const outcome: AttackOutcome = {
      attackId: attack.id,
      intercepted: resolution.intercepted,
      interceptionPoint: resolution.interceptionPoint,
      interceptionBlock: resolution.interceptionBlock,
      interceptionProgress: resolution.interceptionProgress,
      interceptionRadiusKm,
      winners: resolution.winners,
      rewardPerWinner,
      resolvedAtBlock: this.state.currentBlockNumber,
      // ТЗ §6 — the block's own timestamp, not `Date.now()`. This is the
      // number Earth's permanent orientation is computed from, so it has to
      // be chain state every client reads back identically rather than the
      // wall clock of whichever tab happened to observe the impact.
      resolvedAtTimestamp: this.blockTimestamp(),
    }
    lobby.outcome = outcome

    /*
     * ТЗ §18 — which of the three endings this was.
     *
     * A team where nobody sent a probe or submitted a defense is not a team
     * that lost; it is a room the attack flew over, with no contest for the
     * pool to have been the prize of. It ends UNPLAYED and every wei goes
     * back. Everything else is COMPLETED, interception or not — and a
     * COMPLETED round with no winner forfeits its pool to the Global Defense
     * Pool rather than returning it to the creator, because a bounty that
     * comes home on a miss is a bounty that costs nothing to advertise.
     */
    const played = [...this.state.participants.values()].some(
      (entry) => entry.lobbyId === lobby.id && entry.actionCount > 0,
    )
    if (!played) {
      lobby.ending = 'UNPLAYED'
      lobby.status = 'CANCELLED'
    } else {
      lobby.ending = 'COMPLETED'
      lobby.status = 'RESOLVED'
      if (!resolution.intercepted && ledger.rewardPool > 0) {
        this.state.globalDefensePool += ledger.rewardPool
        this.emitEvent(
          this.buildEvent(lobby.creationTxHash, 'DefensePoolFunded', {
            lobbyId: lobby.id,
            amount: ledger.rewardPool,
            pool: this.state.globalDefensePool,
          }),
        )
        ledger.rewardPool = 0
        this.maybeTopUpGlobalDefense()
      }
    }

    // The winner's entitlement, recorded where the claim will look for it.
    for (const winner of resolution.winners) {
      const participant = this.state.participants.get(participantKey(lobby.id, winner))
      if (participant) participant.payoutState = 'PENDING'
    }

    /*
     * Resolution moves no money at all — not the reward, and not the
     * Creator Fee either (ТЗ §17.2).
     *
     * The fee used to be credited straight to the creator's balance here,
     * which made an *impact block* pay somebody. That is a transfer nobody
     * signed, triggered by whichever client happened to read the lobby first
     * and settle it, and it has no counterpart on chain: `settleCreator` is
     * a transaction the creator sends. What resolution produces is the
     * verdict every later claim is checked against, and nothing more.
     */
    this.emitEvent(
      this.buildEvent(lobby.creationTxHash, 'AttackResolved', { lobbyId: lobby.id, attackId: attack.id, outcome }),
    )
  }

  /**
   * Claim Reward (ТЗ §15, §17).
   *
   * Every clause ТЗ §15 lists is a separate check here, in that order,
   * because this is the layer that decides whether money moves. The
   * Command Center's Claim button is a rendering of these conditions and
   * nothing else: a re-enabled control, an edited bundle or a direct call
   * all arrive here and are re-tested against chain state.
   */
  private applyClaimReward(args: ContractWriteArgsMap['claimReward'], from: Address, hash: Hash): EventLog[] {
    const lobby = this.requireLobby(args.lobbyId)
    this.settleLobby(lobby.id)

    // §15: the right Operation, and one that has actually finished.
    const outcome = lobby.outcome
    if (!outcome) throw new Error('This operation has not resolved yet')
    // §15: the right epoch — the claim has to name the attack it resolved.
    if (outcome.attackId !== args.attackId) {
      throw new Error('Reward claims must name the attack this operation resolved')
    }
    const attack = this.state.attacks.get(attackKey(lobby.id, args.attackId))
    if (!attack || attack.status !== 'RESOLVED') throw new Error('Attack has not resolved')

    // §15: the caller took part and submitted a Defense.
    const participant = this.requireParticipant(lobby.id, from)
    if (participant.defenseAttemptIds.length === 0) {
      throw new Error('No Defense was submitted for this operation')
    }
    // §15: the interception condition, and the winner behind it.
    if (!outcome.intercepted) throw new Error('The attack was not intercepted — there is no reward to claim')
    if (!outcome.winners.includes(from)) {
      throw new Error('Only the defender with the earliest interception can claim this reward')
    }
    // §15, §17.4: not already claimed.
    if (participant.payoutState === 'PAID') throw new Error('This reward has already been claimed')
    if (outcome.rewardPerWinner <= 0) throw new Error('There is nothing to claim')

    participant.payoutState = 'PAID'
    const ledger = this.requireLedger(lobby.id)
    const prize = outcome.rewardPerWinner
    ledger.rewardsClaimed += prize

    const events: EventLog[] = [
      this.buildEvent(hash, 'RewardClaimed', {
        lobbyId: lobby.id,
        participant: from,
        amount: prize,
      }),
      this.buildEvent(hash, 'PrizePaid', {
        lobbyId: lobby.id,
        participant: from,
        amount: prize,
        reason: 'reward',
      }),
    ]

    let paid = prize
    if (from === lobby.creator && !ledger.creatorSettled) {
      const fee = this.completedCreatorDue(lobby)
      if (fee > 0) {
        ledger.creatorSettled = true
        paid += fee
        events.push(this.buildEvent(hash, 'CreatorSettled', { lobbyId: lobby.id, creator: from, amount: fee }))
      }
    }

    this.payOut(from, paid)
    return events
  }

  /**
   * Claim Refund (ТЗ §18) — the way out of an operation that never ran.
   *
   * Under-filled rooms are already paid in `cancelLobby`. This path is for
   * `expireAttack` and an UNPLAYED round after activate: the protocol
   * records the debt and each owner comes and takes it.
   *
   * What comes back is everything this wallet put in. For a defender that
   * is `paidIn` (entry, author commission, every Recon Probe). For the
   * creator it is the bounty they funded at mint. The protocol creation
   * fee stays with the treasury.
   */
  private applyClaimRefund(args: ContractWriteArgsMap['claimRefund'], from: Address, hash: Hash): EventLog[] {
    const lobby = this.requireLobby(args.lobbyId)
    this.settleLobby(lobby.id)

    if (lobby.ending !== 'UNPLAYED' && lobby.ending !== 'CANCELLED') {
      throw new Error(
        lobby.status === 'OPEN'
          ? 'This operation is still open — leave it to get your money back'
          : 'This round was played — there is nothing to refund',
      )
    }

    const events: EventLog[] = []
    let amount = 0
    const participant = this.state.participants.get(participantKey(lobby.id, from))
    if (participant && !participant.refunded && participant.paidIn > 0) {
      amount += participant.paidIn
      participant.refunded = true
    }

    const ledger = this.requireLedger(lobby.id)
    if (from === lobby.creator && !ledger.creatorSettled) {
      const creatorLaunch = ledger.startPrizePool
      if (creatorLaunch > 0) {
        amount += creatorLaunch
        ledger.creatorSettled = true
        events.push(this.buildEvent(hash, 'CreatorSettled', { lobbyId: lobby.id, creator: from, amount: creatorLaunch }))
      }
    }

    if (amount <= 0) {
      if (from === lobby.creator && ledger.creatorSettled) {
        throw new Error('This refund has already been claimed')
      }
      if (!participant) throw new Error('Address has not joined this lobby')
      if (participant.refunded) throw new Error('This refund has already been claimed')
      throw new Error('There is nothing to refund')
    }

    this.payOut(from, amount)
    events.push(this.buildEvent(hash, 'RefundClaimed', { lobbyId: lobby.id, participant: from, amount }))
    return events
  }

  /**
   * The Creator Fee on a round that ran, plus rounding dust a tie could
   * not divide. Shared by `claimReward` (when the author also won) and
   * `settleCreator` (when they did not).
   */
  private completedCreatorDue(lobby: Lobby): number {
    const ledger = this.requireLedger(lobby.id)
    const outcome = lobby.outcome
    const paidToWinners = outcome?.intercepted ? outcome.rewardPerWinner * outcome.winners.length : 0
    const dust = outcome?.intercepted ? Math.max(0, ledger.rewardPool - paidToWinners) : 0
    return ledger.creatorFeeAccrued + dust
  }

  /**
   * The creator's settlement (ТЗ §14.6), in one call whatever happened.
   *
   * The Creator Fee is paid on a hit and on a miss alike — a creator is paid
   * for filling an operation, not for its outcome. The bounty comes back
   * only when nobody won it: an attack that reached Earth, or an operation
   * that never ran at all. On a win it stays where the winner's claim will
   * find it, and only the dust an exact tie could not divide comes here.
   */
  private applySettleCreator(args: ContractWriteArgsMap['settleCreator'], from: Address, hash: Hash): EventLog[] {
    const lobby = this.requireLobby(args.lobbyId)
    this.settleLobby(lobby.id)
    const protocolOwned = lobby.creator === PROTOCOL_ESCROW_ADDRESS
    if (!protocolOwned && from !== lobby.creator) throw new Error('Only the creator can settle an operation')

    const ledger = this.requireLedger(lobby.id)
    if (ledger.creatorSettled) throw new Error('This operation has already been settled')

    let amount: number
    if (lobby.ending === 'UNPLAYED' || lobby.ending === 'CANCELLED') {
      amount = ledger.startPrizePool
    } else if (lobby.ending === 'COMPLETED') {
      /*
       * The fee they earned for filling the room, and on an interception the
       * rounding dust an exact tie could not divide. The bounty does not come
       * back on a miss any more: `resolveLobby`'s counterpart above has
       * already moved the unwon pool to the Global Defense Pool.
       */
      amount = this.completedCreatorDue(lobby)
    } else {
      throw new Error('This operation has not finished yet')
    }

    ledger.creatorSettled = true
    if (amount <= 0) throw new Error('There is nothing to settle')

    /*
     * A protocol-owned draw settles back into the pool rather than paying
     * an address — there is nobody to send a bounty to, and the money came
     * from the pool in the first place (ТЗ §18). Permissionless for the
     * same reason: the money has to find its way home without the owner.
     */
    if (protocolOwned) {
      this.state.globalDefensePool += amount
      return [
        this.buildEvent(hash, 'DefensePoolFunded', {
          lobbyId: lobby.id,
          amount,
          pool: this.state.globalDefensePool,
        }),
      ]
    }

    this.payOut(lobby.creator, amount)

    return [
      this.buildEvent(hash, 'CreatorSettled', { lobbyId: lobby.id, creator: lobby.creator, amount }),
      this.buildEvent(hash, 'PrizePaid', {
        lobbyId: lobby.id,
        participant: lobby.creator,
        amount,
        reason: 'creator_fee',
      }),
    ]
  }

  /**
   * Reveal Attack (ТЗ §4) — the write that opens the sealed geometry, once,
   * for everybody.
   *
   * Anyone may call it, including someone who never joined: what it
   * publishes is a fact about a finished round, not a reward. It is legal
   * only on a round that actually happened and has resolved, and only while
   * there is still something to reveal — a second call has nothing to do
   * and says so rather than silently rewriting public state with a fresh
   * block number.
   */
  private applyRevealAttack(args: ContractWriteArgsMap['revealAttack'], from: Address, hash: Hash): EventLog[] {
    const lobby = this.requireLobby(args.lobbyId)
    this.settleLobby(lobby.id)

    if (lobby.reveal) throw new Error('This attack has already been revealed')

    const key = attackKey(lobby.id, args.attackId)
    const attack = this.state.attacks.get(key)
    // ТЗ §4: only a round that actually took place, and only once it is
    // over. A scheduled-but-never-launched attack has nothing to open.
    if (!attack) throw new Error('Attack not found')
    if (attack.status !== 'RESOLVED') throw new Error('This attack has not resolved yet')
    if (!lobby.outcome || lobby.outcome.attackId !== args.attackId) {
      throw new Error('This operation did not resolve that attack')
    }

    /*
     * ТЗ §7 — the decrypt. This single line is the whole difference between
     * before and after: the sealed geometry is opened and written into the
     * operation's own public state, where it stays permanently. From here
     * on `getAttackReveal` answers every client, no second Reveal is
     * possible or needed, and a visitor opening the operation next month
     * reads the trajectory without pressing anything.
     */
    const trajectory = this.openTrajectory(lobby.id, args.attackId)

    const reveal: LobbyReveal = {
      attackId: args.attackId,
      trajectory,
      revealedBy: from,
      revealedAtBlock: this.state.currentBlockNumber,
      revealedAtTimestamp: this.blockTimestamp(),
    }
    lobby.reveal = reveal

    return [this.buildEvent(hash, 'AttackRevealed', { lobbyId: lobby.id, attackId: args.attackId, reveal })]
  }

  /**
   * The reveal, read back (ТЗ §4). Null until somebody has called
   * `revealAttack` — resolution alone does not open anything, and there is
   * no partially-revealed state and no argument that produces one.
   *
   * Once it *is* open it answers everyone, so a client only has to read: no
   * second Reveal is needed by anyone, and the trajectory is available on
   * every later visit to the operation.
   */
  private buildReveal(lobbyId: Hash, attackId: string): AttackRevealData | null {
    const lobby = this.state.lobbies.get(lobbyId)
    if (!lobby?.reveal || lobby.reveal.attackId !== attackId) return null

    const key = attackKey(lobbyId, attackId)
    const outcome = lobby.outcome
    if (!outcome || outcome.attackId !== attackId) return null

    const attack = this.state.attacks.get(key)
    if (!attack) return null

    return {
      attackId,
      trajectory: lobby.reveal.trajectory,
      outcome,
      // ТЗ §7, §9 — every defender's point in the clear, the viewer's own
      // and everyone else's alike. Which of them is *yours* is a question
      // the screen answers, not the protocol.
      attempts: [...this.state.defenseAttempts.values()]
        .filter((attempt) => attempt.lobbyId === lobbyId && attempt.attackId === attackId)
        .map((attempt) => ({ ...attempt, defensePoint: this.openDefensePoint(attempt.id), sealedPoint: null })),
      results: this.state.defenseResults.get(key) ?? [],
      revealedAtBlock: lobby.reveal.revealedAtBlock,
      launchBlock: attack.launchBlock,
      flightDurationBlocks: attack.flightDurationBlocks,
      /*
       * Always true here, and the divergence is the emulator's rather than a
       * simplification: it opens the geometry and scores the team in the same
       * write, so there is no window in which one has happened and the other
       * has not. On chain those are separate transactions — one for the epoch,
       * one per team — and `scored` is what carries the difference. See
       * `ContractBlockchainClient.readReveal`.
       */
      scored: true,
    }
  }

  // -- Sealed state -------------------------------------------------------------

  /**
   * Opens an attack's geometry (ТЗ §4, §11).
   *
   * Private by convention *and* by encryption. Every caller is inside the
   * protocol — probe generation, resolution, the Reveal — and the plaintext
   * exists only for the duration of the call that asked for it. Nothing
   * that returns to a caller outside this class carries what this returns.
   */
  private openTrajectory(lobbyId: Hash, attackId: string): AttackTrajectory {
    const envelope = this.state.sealedTrajectories.get(attackKey(lobbyId, attackId))
    if (!envelope) throw new Error('Attack trajectory is missing')
    return unseal<AttackTrajectory>(envelope, this.sealingKey)
  }

  /** The same, one level down: a stored Defense Point, opened protocol-side only. */
  private openDefensePoint(attemptId: string): DefensePoint | null {
    const envelope = this.state.sealedDefensePoints.get(attemptId)
    return envelope ? unseal<DefensePoint>(envelope, this.sealingKey) : null
  }

  /**
   * What one reader may know about another defender's play (ТЗ §4).
   *
   * `actionCount` is public because a transaction is public — a chain
   * cannot hide that an address sent one. The *breakdown* is not: three
   * probes and a Defense against four probes are four actions either way,
   * and telling them apart is exactly what §4 says an observer must not be
   * able to do. So the id lists come back empty for everyone but the owner
   * until the operation reveals, after which the whole round is public and
   * there is nothing left to protect.
   */
  private redactParticipant(participant: Participant, viewer: Address | null, lobby: Lobby | undefined): Participant {
    if (participant.address === viewer || lobby?.reveal) return participant
    return { ...participant, probeIds: [], defenseAttemptIds: [] }
  }

  /** The current block's own timestamp — the chain's clock, not the tab's. */
  private blockTimestamp(): number {
    return this.state.blocks.get(this.state.currentBlockNumber)?.timestamp ?? Date.now()
  }

  private epochSeedFor(lobby: Lobby, epochId: number): Hash {
    const startBlock = getEpochStartBlock(epochId, this.epochReference.epochBlocks, this.epochReference.genesisBlock)
    const blockData = this.state.blocks.get(Math.min(startBlock, this.state.currentBlockNumber))
    return generateEpochSeed(lobby.id, epochId, blockData?.hash ?? this.genesisHash, EPOCH_SALT)
  }

  /** The playfield an operation is played on, at the sector scale its own config fixed. */
  private worldFor(config: LobbyConfig): WorldGeometry {
    return buildWorld(this.mapGrid, config.attack.sectorSpanKm)
  }

  // -- Events -----------------------------------------------------------------

  async getLogs(filter: EventLogFilter): Promise<EventLog[]> {
    return this.state.events.filter((log) => {
      if (filter.eventName && log.name !== filter.eventName) return false
      if (filter.fromBlock !== undefined && log.blockNumber < filter.fromBlock) return false
      if (filter.toBlock !== undefined && log.blockNumber > filter.toBlock) return false
      if (filter.lobbyId !== undefined) {
        const payload = log.payload as { lobbyId?: Hash }
        if (payload.lobbyId !== filter.lobbyId) return false
      }
      return true
    })
  }

  subscribeToEvents(eventName: GameEventName | 'all', callback: (log: EventLog) => void): () => void {
    return this.eventEmitter.on(eventName, callback)
  }

  private emitEvent(log: EventLog): void {
    this.state.events.push(log)
    this.eventEmitter.emit(log.name, log)
    this.eventEmitter.emit('all', log)
  }

  subscribeToBlocks(callback: (blockNumber: number) => void): () => void {
    return this.blockEmitter.on('block', callback)
  }

  private buildEvent<TName extends GameEventName>(
    txHash: Hash,
    name: TName,
    payload: EventLog<TName>['payload'],
  ): EventLog<TName> {
    return { name, payload, blockNumber: this.state.currentBlockNumber, transactionHash: txHash, logIndex: this.state.events.length }
  }

  // -- Transaction waiting ------------------------------------------------------

  async waitForTransaction(hash: Hash): Promise<TransactionRecord> {
    const existing = this.state.transactions.get(hash)
    if (existing && (existing.status === 'confirmed' || existing.status === 'failed')) {
      return existing
    }
    return new Promise((resolve) => {
      const list = this.waiters.get(hash) ?? []
      list.push(resolve)
      this.waiters.set(hash, list)
    })
  }

  private resolveWaiters(record: TransactionRecord): void {
    const list = this.waiters.get(record.hash)
    if (!list) return
    list.forEach((resolve) => resolve(record))
    this.waiters.delete(record.hash)
  }

  // -- Helpers ------------------------------------------------------------------

  private mineBlock(): Block {
    const number = this.state.currentBlockNumber + 1
    const parent = this.state.blocks.get(this.state.currentBlockNumber)
    const parentHash = parent ? parent.hash : this.genesisHash
    const hash = keccak256(toHex(`${parentHash}:${number}`))
    const block: Block = { number, hash, timestamp: Date.now(), parentHash }
    this.state.blocks.set(number, block)
    this.state.currentBlockNumber = number
    this.maybeTopUpGlobalDefense()
    this.maybeOpenGlobalDefense()
    this.blockEmitter.emit('block', number)
    return block
  }

  private generateTxHash(functionName: string, args: unknown, from: Address): Hash {
    this.state.txCounter += 1
    return keccak256(toHex(`${functionName}:${from}:${this.state.txCounter}:${JSON.stringify(args)}`))
  }

  /**
   * Money into the protocol.
   *
   * A transfer rather than a decrement, because the difference is the whole
   * of the refund story: what a player pays has to still exist somewhere
   * afterwards, held by the party that owes it back. It is also the only
   * thing that makes the accounting checkable — with escrow, the sum of
   * every balance is invariant, so an operation that pays out more or less
   * than it took in is a failing assertion rather than a slow leak.
   */
  private escrow(address: Address, amount: number): void {
    const account = ensureAccount(this.state, address)
    if (account.balance < amount) {
      throw new Error(`Insufficient balance: has ${account.balance}, needs ${amount}`)
    }
    account.balance -= amount
    ensureAccount(this.state, PROTOCOL_ESCROW_ADDRESS).balance += amount
  }

  /** Money out of the protocol — a reward, a refund, a leave, a settlement. */
  private payOut(address: Address, amount: number): void {
    if (amount <= 0) return
    const escrowAccount = ensureAccount(this.state, PROTOCOL_ESCROW_ADDRESS)
    if (escrowAccount.balance + 1e-12 < amount) {
      // Unreachable unless the ledger and the escrow have drifted apart,
      // which is a protocol bug rather than a user error — and one worth
      // failing loudly on rather than paying out money that is not there.
      throw new Error(`Protocol cannot pay ${amount}: escrow holds ${escrowAccount.balance}`)
    }
    escrowAccount.balance -= Math.min(amount, escrowAccount.balance)
    ensureAccount(this.state, address).balance += amount
  }

  private requireLedger(lobbyId: Hash): LobbyLedger {
    const ledger = this.state.lobbyLedgers.get(lobbyId)
    if (!ledger) throw new Error(`Lobby ${lobbyId} has no ledger`)
    return ledger
  }

  private requireLobby(lobbyId: Hash): Lobby {
    const lobby = this.state.lobbies.get(lobbyId)
    if (!lobby) throw new Error(`Lobby ${lobbyId} not found`)
    return lobby
  }

  private requireParticipant(lobbyId: Hash, address: Address): Participant {
    const participant = this.state.participants.get(participantKey(lobbyId, address))
    if (!participant) throw new Error('Address has not joined this lobby')
    return participant
  }
}
