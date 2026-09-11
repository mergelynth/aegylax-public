import { appConfig, protocolGenesisBlock } from '../config/env'
import { deadlineBlockOf, getEpochStartBlock, launchEpochOf } from '../game/epochs'
import { useBlockRate } from './useBlockRate'
import { useEpochClock } from './useEpochClock'
import { useCountdownClock, useSmoothCountdown } from './useSmoothCountdown'

export interface OperationLaunch {
  /** ms until the attack of the operation this config would create, or null until the block clock answers. */
  msRemaining: number | null
  /** The epoch that attack flies in — an estimate, and the caller must mark it as one. */
  epochId: number | null
  /** First block of that epoch: the one thing here a creator can go and check. */
  launchBlock: number | null
}

/**
 * When the attack would arrive for an operation created *right now* with
 * this deadline — not when the protocol's next attack is.
 *
 * The distinction is the whole point of this hook, and Create Operation used
 * to get it wrong. It showed `useNextAttackCountdown`: the start of the next
 * epoch, which is a fact about the protocol and has nothing to do with the
 * operation being configured. A creator reading "00:02:48" while filling in
 * a form with a one-day deadline was being told their attack was three
 * minutes away, when in truth it was a day and a half.
 *
 * The real answer is three protocol facts composed in order, and every one
 * of them has to be in it:
 *
 *   1. the deadline is a moment, and the contract closes applications on a
 *      *block* — `deadlineBlockOf`, off the chain's head and a measured
 *      block rate;
 *   2. the attack flies in the epoch after that block's, unless that
 *      boundary is too close — `launchEpochOf`, which mirrors the chain's
 *      own 90% cushion;
 *   3. the attack window opens at that epoch's first block.
 *
 * Step 2 is why this countdown never reaches zero, and never can. The
 * cushion guarantees at least 90% of an epoch between applications closing
 * and the threat launching, so the smallest value this can ever show is
 * nine tenths of an epoch — a creator who sets the deadline to the earliest
 * moment the protocol allows still gets a full defense window, and the
 * readout says so instead of counting down to a launch nobody would be
 * ready for.
 *
 * Everything is derived from the shared block clock, so two clients
 * configuring the same deadline see the same answer and a reload lands on
 * the same value.
 */
export function useOperationLaunchCountdown(deadlineMs: number): OperationLaunch {
  const { blockNumber, timestampMs } = useEpochClock()
  const nowMs = useCountdownClock()
  // The same measured rate the submit path converts the deadline with, so
  // the epoch counted down to here is the epoch that press would book.
  const blockTimeMs = useBlockRate(appConfig.blockTimeMs)
  const { epochBlocks } = appConfig.protocol
  const genesisBlock = protocolGenesisBlock()

  const deadlineBlock = deadlineBlockOf({ nowMs, deadlineMs, blockNumber, blockTimeMs })
  const epochId =
    deadlineBlock === null || epochBlocks <= 0 ? null : launchEpochOf(deadlineBlock, epochBlocks, genesisBlock)
  const launchBlock = epochId === null ? null : getEpochStartBlock(epochId, epochBlocks, genesisBlock)
  const blocksRemaining = launchBlock === null || blockNumber === null ? null : launchBlock - blockNumber

  return { msRemaining: useSmoothCountdown(blocksRemaining, blockTimeMs, timestampMs), epochId, launchBlock }
}
