import type { SealedEnvelope } from '../game/sealing'
import type {
  Address,
  ActivityCell,
  Attack,
  AttackEpoch,
  DefenseAttempt,
  DefenseResult,
  GameStats,
  GlobalDefenseDraw,
  Hash,
  Lobby,
  Participant,
  ReconProbeRecord,
} from '../game/types'
import { getEpochFromBlock } from '../game/epochs'
import { PROTOCOL_ESCROW_ADDRESS } from '../game/globalDefense'
import type { Block, EventLog, TransactionRecord } from './types'

/**
 * The protocol's own account — the emulator's stand-in for the deployed
 * contract's balance. Re-exported from `game/globalDefense` so the sentinel
 * the draw is minted under and the address money is held at cannot drift.
 *
 * Everything an operation is paid goes here and every payout comes back out
 * of here, which is the whole point: money that has left a player's balance
 * has to be *somewhere*, held by a party that can be asked for it. Deleting
 * it instead — which is what a bare `balance -= amount` does — makes a
 * refund unimplementable, because there is nothing left to refund from, and
 * hides accounting mistakes that a real chain would surface as a contract
 * that cannot pay its debts.
 *
 * It starts at zero rather than at the default balance: the protocol has no
 * money of its own, only what operations put into it.
 */
export { PROTOCOL_ESCROW_ADDRESS }

export const DEFAULT_EMULATOR_BALANCE_ETH = 100

/**
 * One operation's money, exactly as `AegylaxGame` accounts for it.
 *
 * Held apart from `Lobby` because it is protocol bookkeeping rather than
 * something the UI reads: the screen asks what it is owed, not how the pool
 * was assembled. Keeping the same field names as the contract's `Lobby`
 * struct is deliberate — the emulator and the deployment have to agree on
 * where every ETH goes, and divergence here is invisible until real money
 * is involved.
 */
export interface LobbyLedger {
  /** The creator's bounty, as funded at creation. The refund basis if the operation never runs. */
  startPrizePool: number
  /** Entry fees taken so far, before any fee is split off them. */
  entryFeesCollected: number
  /** What defenders have spent on extra Recon Probes; it stays in the operation. */
  probeFeesCollected: number
  /** Fixed when applications close, and payable to the creator whatever the outcome. */
  creatorFeeAccrued: number
  /** The protocol's flat per-join take. Refundable while the operation can still be cancelled. */
  protocolFeeAccrued: number
  /**
   * What winners share. It grows as probes are bought and, when applications
   * close, absorbs the entry fees left over after the Creator Fee — the only
   * destination that neither orphans them nor pays the creator twice.
   */
  rewardPool: number
  /** Paid out to winners so far, so the creator's dust settlement is exact. */
  rewardsClaimed: number
  creatorSettled: boolean
}

export interface EmulatorState {
  currentBlockNumber: number
  blocks: Map<number, Block>
  accounts: Map<Address, { balance: number }>
  transactions: Map<Hash, TransactionRecord>
  events: EventLog[]
  txCounter: number

  /**
   * The Global Defense Pool (ТЗ §18) — every pool a COMPLETED round the
   * threat won has forfeited.
   *
   * Accumulated here so the emulator's money adds up the same way the
   * contract's does. The periodic draw that plays it out is
   * `openGlobalDefense` — a permissionless write, same as on chain.
   */
  globalDefensePool: number
  /**
   * The protocol-owned draw lobby for each interval epoch, if one has been
   * opened. Mirrors `GameStorage.globalDefenseLobby`.
   */
  globalDefenseLobby: Map<number, Hash>
  /**
   * What each protocol draw was opened for, by lobby id.
   *
   * The bounty itself never enters an OPEN draw — `globalDefensePool` holds
   * it until the round activates — so a room that ended unplayed has no
   * record of the pile it was playing for anywhere in its own state. This is
   * that record, and it is the only reason a cancelled Global Defense row
   * can print anything but 0. Mirrors what `GlobalDefenseOpened` carries on
   * chain, which is where the indexer reads the same fact from.
   */
  globalDefenseBounty: Map<Hash, number>

  lobbies: Map<Hash, Lobby>
  /** Per-operation escrow accounting — see `LobbyLedger`. */
  lobbyLedgers: Map<Hash, LobbyLedger>
  lobbyActiveStartBlock: Map<Hash, number>
  participants: Map<string, Participant>
  attackEpochs: Map<string, AttackEpoch>
  attacks: Map<string, Attack>
  /**
   * The sealed half of every attack, keyed the same way as `attacks`
   * (ТЗ §4, §11) — and sealed in the literal sense: what this map holds is
   * an encrypted envelope, not an `AttackTrajectory`.
   *
   * Two separate things keep the geometry hidden, and the belt matters as
   * much as the braces. Structurally, it lives apart from the attack, so
   * the read path cannot return it by accident: `Attack` has no trajectory
   * field to leak, and the only read that reaches this map is
   * `getAttackReveal`, which answers nothing until somebody has revealed.
   * Cryptographically, the value here is ciphertext under the protocol's
   * key, so even the copy that lands in `localStorage` between reloads has
   * no startPoint and no targetPoint in it (ТЗ §11).
   *
   * The protocol opens it in exactly three places, all of them private
   * computation: generating a probe's answer, judging the Defense Points at
   * impact, and the Reveal — which is where the plaintext finally, and
   * permanently, becomes public state.
   */
  sealedTrajectories: Map<string, SealedEnvelope>
  /**
   * Every submitted Defense Point, sealed to the protocol (ТЗ §7, §11).
   *
   * Same reasoning one level down: `DefenseAttempt` carries no plaintext
   * coordinate, so the attempt can be handed to any reader safely, and the
   * point itself is only ever opened for resolution or resealed to its own
   * owner on request.
   */
  sealedDefensePoints: Map<string, SealedEnvelope>
  /**
   * Per-attempt resolution, computed once when the attack lands and kept
   * for the reveal (ТЗ §14.3-14.5). Stored rather than recomputed on read
   * so every viewer is handed the identical verdict the payout was decided
   * from — a second evaluation is a second source of truth.
   */
  defenseResults: Map<string, DefenseResult[]>
  activityMaps: Map<string, ActivityCell[]>
  /** Every probe answer the protocol has produced, by transaction hash (ТЗ §1). */
  reconProbes: Map<string, ReconProbeRecord>
  defenseAttempts: Map<string, DefenseAttempt>
}

export function participantKey(lobbyId: Hash, address: Address): string {
  return `${lobbyId}:${address}`
}

export function epochKey(lobbyId: Hash, epochId: number): string {
  return `${lobbyId}:${epochId}`
}

export function attackKey(lobbyId: Hash, attackId: string): string {
  return `${lobbyId}:${attackId}`
}

export function createEmulatorState(initialBlock: number, genesisHash: Hash): EmulatorState {
  const state: EmulatorState = {
    currentBlockNumber: initialBlock,
    blocks: new Map(),
    accounts: new Map(),
    transactions: new Map(),
    events: [],
    txCounter: 0,
    globalDefensePool: 0,
    globalDefenseLobby: new Map(),
    globalDefenseBounty: new Map(),
    lobbies: new Map(),
    lobbyLedgers: new Map(),
    lobbyActiveStartBlock: new Map(),
    participants: new Map(),
    attackEpochs: new Map(),
    attacks: new Map(),
    sealedTrajectories: new Map(),
    sealedDefensePoints: new Map(),
    defenseResults: new Map(),
    activityMaps: new Map(),
    reconProbes: new Map(),
    defenseAttempts: new Map(),
  }

  state.blocks.set(initialBlock, {
    number: initialBlock,
    hash: genesisHash,
    timestamp: Date.now(),
    parentHash: genesisHash,
  })

  return state
}

export function ensureAccount(state: EmulatorState, address: Address): { balance: number } {
  let account = state.accounts.get(address)
  if (!account) {
    // The protocol is funded by operations, not by the faucet every player
    // account starts on.
    account = { balance: address === PROTOCOL_ESCROW_ADDRESS ? 0 : DEFAULT_EMULATOR_BALANCE_ETH }
    state.accounts.set(address, account)
  }
  return account
}

export function createLobbyLedger(startPrizePool: number): LobbyLedger {
  return {
    startPrizePool,
    entryFeesCollected: 0,
    probeFeesCollected: 0,
    creatorFeeAccrued: 0,
    protocolFeeAccrued: 0,
    rewardPool: startPrizePool,
    rewardsClaimed: 0,
    creatorSettled: false,
  }
}

/** Protocol-level epoch reference: the chain's genesis block and the protocol's epoch length. */
export interface ProtocolEpochReference {
  epochBlocks: number
  genesisBlock: number
}

/**
 * Read-only aggregate statistics derived from emulator state (spec §47).
 * Nothing outside `EmulatorBlockchainClient` should read this directly —
 * the UI only ever sees it through `BlockchainClient.readContract`.
 */
export function computeGameStats(
  state: EmulatorState,
  epochReference: ProtocolEpochReference,
  interval = 0,
): GameStats {
  let activeLobbies = 0
  for (const lobby of state.lobbies.values()) {
    if (lobby.status === 'OPEN' || lobby.status === 'READY' || lobby.status === 'ACTIVE') {
      activeLobbies += 1
    }
  }

  // Interceptions are counted from resolved operations, since an operation
  // has exactly one attack and its outcome is the record of it (ТЗ §11.6).
  let interceptedAttacks = 0
  for (const lobby of state.lobbies.values()) {
    if (lobby.outcome?.intercepted) interceptedAttacks += 1
  }

  const currentEpoch = getEpochFromBlock(
    state.currentBlockNumber,
    epochReference.epochBlocks,
    epochReference.genesisBlock,
  )

  /*
   * ТЗ §7 — the protocol attacks Earth once an epoch, whether or not
   * anybody organised a defense against it.
   *
   * So the lifetime attack count is the number of epochs that have
   * *finished*, not the number of operations that happened to exist. An
   * epoch nobody defended still ends with a threat reaching the planet: it
   * counts as an attack and it counts as unintercepted, which is exactly
   * what §7 asks the status bar to show. Only an epoch somebody actually
   * stopped moves the intercepted counter.
   *
   * TODO (§57): the model gives every operation its own attack, so two
   * operations resolving inside one epoch can report two interceptions
   * against that epoch's single attack. The clamp below keeps the three
   * numbers consistent; the real fix is one protocol-wide attack per epoch
   * that operations subscribe to, which the current data model does not
   * have.
   */
  const totalAttacks = Math.max(0, currentEpoch)
  const cappedIntercepted = Math.min(interceptedAttacks, totalAttacks)

  /*
   * An attack still in the sky is not an impact.
   *
   * `missedAttacks` used to be everything left over once the interceptions
   * were subtracted, which quietly counted every unresolved attack as a hit
   * on Earth. The visible effect was the worst kind: the moment a round
   * *launched* — the epoch ticks over at exactly that block — the Impacts
   * counter went up by one, in front of players who were still flying
   * probes and had not placed a Defense Point yet. The protocol was
   * announcing the result of a round that had not happened.
   *
   * So the in-flight ones are held out of both outcome columns. They are
   * still counted as attacks — one has been detected, which is true and is
   * what the Attacks metric says — they simply have no verdict yet, and the
   * status bar says nothing about what it does not know.
   */
  let attacksInFlight = 0
  for (const attack of state.attacks.values()) {
    if (attack.status === 'LAUNCHED') attacksInFlight += 1
  }
  const undecided = Math.min(attacksInFlight, totalAttacks - cappedIntercepted)

  return {
    activeLobbies,
    // Lifetime counter: `lobbies` is only ever added to, so a resolved or
    // cancelled operation still counts as one that was created — once,
    // regardless of how many events, tabs or reloads observe it.
    totalLobbies: state.lobbies.size,
    totalAttacks,
    interceptedAttacks: cappedIntercepted,
    missedAttacks: totalAttacks - cappedIntercepted - undecided,
    currentBlock: state.currentBlockNumber,
    currentEpoch,
    globalDefensePool: state.globalDefensePool,
    globalDefenseLobbyId:
      interval > 0 ? (state.globalDefenseLobby.get((Math.floor(currentEpoch / interval) + 1) * interval) ?? null) : null,
  }
}

export function computeGlobalDefenseDraw(
  state: EmulatorState,
  epochReference: ProtocolEpochReference,
  interval: number,
): GlobalDefenseDraw {
  const currentEpoch = getEpochFromBlock(
    state.currentBlockNumber,
    epochReference.epochBlocks,
    epochReference.genesisBlock,
  )
  if (interval <= 0) {
    return { nextEpoch: 0, interval: 0, pool: state.globalDefensePool, lobbyId: null }
  }
  const nextEpoch = (Math.floor(currentEpoch / interval) + 1) * interval
  return {
    nextEpoch,
    interval,
    pool: state.globalDefensePool,
    lobbyId: state.globalDefenseLobby.get(nextEpoch) ?? null,
  }
}
