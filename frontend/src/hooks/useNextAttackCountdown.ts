import { appConfig, protocolGenesisBlock } from '../config/env'
import { getNextAttackBlock } from '../game/epochs'
import { useEpochClock } from './useEpochClock'
import { useSmoothCountdown } from './useSmoothCountdown'

/**
 * Time remaining until the protocol's next automatically generated attack.
 * Never a lobby parameter and never editable: the value comes from the
 * shared block clock and the protocol's epoch schedule, through the same
 * `game/epochs` math the attack generator uses.
 *
 * The block number is the source of truth, not a local timer. Every block
 * push re-derives the countdown from chain state, which is why two clients
 * agree and why a page reload lands on the same value — nothing about it
 * is stored or accumulated locally.
 *
 * Turning blocks into moving digits is `useSmoothCountdown`'s job and only
 * its job. This hook used to carry its own anchor and its own 1s interval,
 * which is how the header's epoch readout and the operation screen's
 * countdown — counting to the very same block — could sit seconds apart:
 * two clocks, sampled at unrelated moments. There is one clock now, and
 * every countdown on the screen is a different target block read off it.
 *
 * How many milliseconds a block is worth is the configured rate. A
 * per-tab running average of poll gaps made two windows looking at the
 * same 142 blocks print clocks five seconds apart. The intra-block motion
 * comes from the head's `block.timestamp`, which both windows read off
 * the chain.
 */
export function useNextAttackCountdown(): number | null {
  const { blockNumber, timestampMs } = useEpochClock()
  const { epochBlocks } = appConfig.protocol
  const blockTimeMs = appConfig.blockTimeMs

  const blocksRemaining =
    blockNumber === null ? null : getNextAttackBlock(blockNumber, epochBlocks, protocolGenesisBlock()) - blockNumber

  return useSmoothCountdown(blocksRemaining, blockTimeMs, timestampMs)
}
