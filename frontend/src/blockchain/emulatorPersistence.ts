import type { SealedEnvelope } from '../game/sealing'
import type {
  Address,
  ActivityCell,
  Attack,
  AttackEpoch,
  DefenseAttempt,
  DefenseResult,
  Hash,
  Lobby,
  Participant,
  ReconProbeRecord,
} from '../game/types'
import { getStorageItem, removeStorageItem, setStorageItem } from '../utils/storage'
import type { Block } from './types'
import { createEmulatorState, type EmulatorState, type LobbyLedger } from './emulatorState'

/**
 * Bumped when the persisted shape changes. A stale key is simply ignored
 * rather than migrated — the emulator is a development chain, and a
 * half-migrated operation is worse than a fresh one.
 */
const STORAGE_KEY = 'emulator-chain-state-v8'

/**
 * Persisted shape of `EmulatorState` (spec §9: emulator participation
 * state must survive a reload). Maps serialize as entry arrays. Full
 * block/transaction/event history is intentionally NOT persisted — it's
 * unbounded over a long session and nothing in the app looks up
 * historical blocks/tx/events after a reload, only the current game
 * state (lobbies, participants, epochs, attacks, activity, scans,
 * defense attempts) and enough chain metadata to keep mining forward
 * correctly.
 */
interface SerializedEmulatorState {
  currentBlockNumber: number
  latestBlock: Block
  accounts: [Address, { balance: number }][]
  txCounter: number
  /** ТЗ §18 — carried across reloads like any other escrowed balance. */
  globalDefensePool?: number
  globalDefenseLobby?: [number, Hash][]
  /** What each draw was opened for — see `EmulatorState.globalDefenseBounty`. */
  globalDefenseBounty?: [Hash, number][]
  lobbies: [Hash, Lobby][]
  /** Escrow accounting has to survive a reload or the operation cannot pay what it owes. */
  lobbyLedgers: [Hash, LobbyLedger][]
  lobbyActiveStartBlock: [Hash, number][]
  participants: [string, Participant][]
  attackEpochs: [string, AttackEpoch][]
  attacks: [string, Attack][]
  /**
   * Ciphertext, both of them (ТЗ §11). This file writes emulator state into
   * the same `localStorage` the player's own browser owns, so any plaintext
   * coordinate here would be a coordinate handed to the browser before the
   * Reveal — the exact thing §11 rules out. Sealing them upstream is what
   * makes persisting them harmless.
   */
  sealedTrajectories: [string, SealedEnvelope][]
  sealedDefensePoints: [string, SealedEnvelope][]
  defenseResults: [string, DefenseResult[]][]
  activityMaps: [string, ActivityCell[]][]
  reconProbes: [string, ReconProbeRecord][]
  defenseAttempts: [string, DefenseAttempt][]
}

export function saveEmulatorState(state: EmulatorState): void {
  const latestBlock = state.blocks.get(state.currentBlockNumber)
  if (!latestBlock) return

  const serialized: SerializedEmulatorState = {
    currentBlockNumber: state.currentBlockNumber,
    latestBlock,
    accounts: [...state.accounts.entries()],
    txCounter: state.txCounter,
    globalDefensePool: state.globalDefensePool,
    globalDefenseLobby: [...state.globalDefenseLobby.entries()],
    globalDefenseBounty: [...state.globalDefenseBounty.entries()],
    lobbies: [...state.lobbies.entries()],
    lobbyLedgers: [...state.lobbyLedgers.entries()],
    lobbyActiveStartBlock: [...state.lobbyActiveStartBlock.entries()],
    participants: [...state.participants.entries()],
    attackEpochs: [...state.attackEpochs.entries()],
    attacks: [...state.attacks.entries()],
    sealedTrajectories: [...state.sealedTrajectories.entries()],
    sealedDefensePoints: [...state.sealedDefensePoints.entries()],
    defenseResults: [...state.defenseResults.entries()],
    activityMaps: [...state.activityMaps.entries()],
    reconProbes: [...state.reconProbes.entries()],
    defenseAttempts: [...state.defenseAttempts.entries()],
  }
  setStorageItem(STORAGE_KEY, serialized)
}

/** Rehydrates emulator state from localStorage, or creates fresh state if none/invalid is found. */
export function loadOrCreateEmulatorState(initialBlock: number, genesisHash: Hash): EmulatorState {
  const data = getStorageItem<SerializedEmulatorState>(STORAGE_KEY)
  if (!data || typeof data.currentBlockNumber !== 'number' || !data.latestBlock) {
    return createEmulatorState(initialBlock, genesisHash)
  }

  const state: EmulatorState = {
    currentBlockNumber: data.currentBlockNumber,
    blocks: new Map([[data.latestBlock.number, data.latestBlock]]),
    accounts: new Map(data.accounts),
    transactions: new Map(),
    events: [],
    txCounter: data.txCounter,
    // Optional in the stored shape: state written before the pool existed
    // rehydrates with an empty one rather than failing to load at all.
    globalDefensePool: data.globalDefensePool ?? 0,
    globalDefenseLobby: new Map(data.globalDefenseLobby ?? []),
    globalDefenseBounty: new Map(data.globalDefenseBounty ?? []),
    lobbies: new Map(data.lobbies),
    lobbyLedgers: new Map(data.lobbyLedgers ?? []),
    lobbyActiveStartBlock: new Map(data.lobbyActiveStartBlock),
    participants: new Map(data.participants),
    attackEpochs: new Map(data.attackEpochs),
    attacks: new Map(data.attacks),
    sealedTrajectories: new Map(data.sealedTrajectories ?? []),
    sealedDefensePoints: new Map(data.sealedDefensePoints ?? []),
    defenseResults: new Map(data.defenseResults ?? []),
    activityMaps: new Map(data.activityMaps),
    reconProbes: new Map(data.reconProbes ?? []),
    defenseAttempts: new Map(data.defenseAttempts),
  }
  return state
}

export function clearEmulatorState(): void {
  removeStorageItem(STORAGE_KEY)
}
