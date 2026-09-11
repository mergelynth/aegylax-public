import type { Hash } from './types'
import { deriveSeed } from './randomness'

/**
 * Epoch math is block-based, never wall-clock-based (spec §19): every
 * participant in a lobby derives the same epoch id from the same shared
 * block reference, so no client ever uses local time for authoritative
 * game state.
 */
export function getEpochFromBlock(blockNumber: number, epochBlocks: number, genesisBlock: number): number {
  return Math.floor((blockNumber - genesisBlock) / epochBlocks)
}

export function getEpochStartBlock(epochId: number, epochBlocks: number, genesisBlock: number): number {
  return genesisBlock + epochId * epochBlocks
}

export function getEpochEndBlock(epochId: number, epochBlocks: number, genesisBlock: number): number {
  return getEpochStartBlock(epochId, epochBlocks, genesisBlock) + epochBlocks - 1
}

/**
 * Share of an epoch that must still remain after applications close
 * before the threat may launch. Mirrors `Epochs.MIN_LAUNCH_REMAINING_*`
 * on chain — not a `GameParams` field, and the two copies have to agree
 * to the block.
 */
export const MIN_LAUNCH_REMAINING_NUM = 90
export const MIN_LAUNCH_REMAINING_DEN = 100

/**
 * Which epoch a player-created operation's attack flies in, given the
 * block applications close on.
 *
 * The naive answer is the epoch after the deadline's. That is still the
 * answer when that next boundary leaves at least 90% of an epoch to play
 * in; a deadline in the last 10% of an epoch skips that boundary so the
 * attack cannot fire one block after the join window closes. Mirrors
 * `Epochs.launchEpochOf`.
 */
export function launchEpochOf(deadlineBlock: number, epochBlocks: number, genesisBlock: number): number {
  const deadlineEpoch = getEpochFromBlock(deadlineBlock, epochBlocks, genesisBlock)
  let candidate = deadlineEpoch + 1
  const launchBlock = getEpochStartBlock(candidate, epochBlocks, genesisBlock)
  let minGap = Math.floor((epochBlocks * MIN_LAUNCH_REMAINING_NUM) / MIN_LAUNCH_REMAINING_DEN)
  if (minGap === 0) minGap = 1
  if (launchBlock <= deadlineBlock || launchBlock - deadlineBlock < minGap) {
    candidate += 1
  }
  return candidate
}

/**
 * The block at which the protocol's next automatic attack window opens.
 *
 * Attacks are generated per epoch (spec §21-22), so the nearest moment the
 * protocol can generate one is the start of the next epoch. This is
 * deliberately protocol-level: it is computed from the shared block
 * reference alone, with no lobby involved, which is what lets the Create
 * Defense Operation modal show the countdown before any operation exists.
 *
 * TODO: the exact launch block inside an epoch is drawn from that epoch's
 * seed (§23-24), so once the seed for the next epoch is known this should
 * target the actual launch block rather than the epoch boundary.
 */
export function getNextAttackBlock(blockNumber: number, epochBlocks: number, genesisBlock: number): number {
  const currentEpoch = getEpochFromBlock(blockNumber, epochBlocks, genesisBlock)
  return getEpochStartBlock(currentEpoch + 1, epochBlocks, genesisBlock)
}

/** Wall-clock estimate of `getNextAttackBlock`, for display only — never for game state. */
export function getMsUntilNextAttack(
  blockNumber: number,
  epochBlocks: number,
  genesisBlock: number,
  blockTimeMs: number,
): number {
  const blocksRemaining = getNextAttackBlock(blockNumber, epochBlocks, genesisBlock) - blockNumber
  return Math.max(0, blocksRemaining * blockTimeMs)
}

/**
 * The block applications close on, for a deadline the creator picked as a
 * wall-clock moment.
 *
 * The creator picks a moment; the contract closes applications on a block,
 * because a block is the only kind of deadline an epoch can be derived from
 * — and deriving it is what lets the attack be scheduled at creation and fly
 * with nobody in attendance. Only a client can bridge the two, and this is
 * the one place it is done, so the epoch the Create Operation timer counts
 * down to is the epoch pressing Launch would actually book.
 *
 * Never the current block: the contract requires a deadline strictly ahead
 * of the head, and a deadline that has already passed is not a window.
 *
 * `null` when the chain's head has not been read yet — never a guess.
 */
export function deadlineBlockOf(params: {
  /** Now, from the app's shared countdown clock. */
  nowMs: number
  deadlineMs: number
  blockNumber: number | null
  /** Measured, not nominal — see `useBlockRate`. */
  blockTimeMs: number
}): number | null {
  const { nowMs, deadlineMs, blockNumber, blockTimeMs } = params
  if (blockNumber === null) return null
  const blocksAway = Math.ceil(Math.max(0, deadlineMs - nowMs) / Math.max(1, blockTimeMs))
  return blockNumber + Math.max(1, blocksAway)
}

/**
 * Which epoch an operation's attack will fly in, for a client that has to
 * work it out for itself.
 *
 * On chain this is no longer a guess: `createLobby` derives the epoch from
 * the deadline *block* and writes it onto the lobby, so `currentEpochId` is
 * the chain's own answer from the moment the operation exists. This stays
 * for the two cases with no such answer to read — emulator mode, where the
 * deadline is a wall-clock time, and an operation created before the
 * protocol scheduled its own attacks.
 *
 * Deliberately an estimate rather than a promise, and the caller is
 * expected to mark it as one: block time is not a protocol guarantee (§20),
 * so a deadline that lands one block either side of a boundary can move the
 * epoch by one.
 *
 * `null` when the clock has not been read yet — never a guess from
 * `Date.now()`, which would put two clients on different epochs.
 */
export function predictAttackEpoch(params: {
  /** Now, from the app's shared countdown clock. */
  nowMs: number
  /** The operation's application deadline, in ms. */
  deadlineMs: number
  blockNumber: number | null
  epochBlocks: number
  genesisBlock: number
  blockTimeMs: number
}): number | null {
  const { nowMs, deadlineMs, blockNumber, epochBlocks, genesisBlock, blockTimeMs } = params
  if (blockNumber === null || epochBlocks <= 0 || blockTimeMs <= 0) return null

  const deadlineBlock = deadlineBlockOf({ nowMs, deadlineMs, blockNumber, blockTimeMs })
  if (deadlineBlock === null) return null
  return launchEpochOf(deadlineBlock, epochBlocks, genesisBlock)
}

/**
 * Epoch seed = f(lobbyId, epochId, block hash, salt). Production
 * randomness strategy (VRF / commit-reveal / other) is TODO (§23, §57) —
 * this derivation is the emulator/dev implementation only.
 */
export function generateEpochSeed(lobbyId: Hash, epochId: number, blockHash: Hash, salt: string): Hash {
  return deriveSeed([lobbyId, epochId, blockHash, salt])
}
