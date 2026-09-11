import { describe, expect, it } from 'vitest'
import {
  deadlineBlockOf,
  generateEpochSeed,
  getEpochEndBlock,
  getEpochFromBlock,
  getEpochStartBlock,
  getMsUntilNextAttack,
  getNextAttackBlock,
  launchEpochOf,
  predictAttackEpoch,
} from '../../game/epochs'
import type { Hash } from '../../game/types'

describe('epoch math', () => {
  it('derives epoch id from block number relative to genesis', () => {
    expect(getEpochFromBlock(100, 150, 100)).toBe(0)
    expect(getEpochFromBlock(249, 150, 100)).toBe(0)
    expect(getEpochFromBlock(250, 150, 100)).toBe(1)
    expect(getEpochFromBlock(400, 150, 100)).toBe(2)
  })

  it('computes matching start/end blocks for an epoch', () => {
    const start = getEpochStartBlock(2, 150, 100)
    const end = getEpochEndBlock(2, 150, 100)
    expect(start).toBe(400)
    expect(end).toBe(549)
    expect(getEpochFromBlock(start, 150, 100)).toBe(2)
    expect(getEpochFromBlock(end, 150, 100)).toBe(2)
  })

  it('points the next automatic attack at the start of the next epoch', () => {
    // Genesis 100, 150-block epochs: epoch 0 covers 100..249.
    expect(getNextAttackBlock(100, 150, 100)).toBe(250)
    expect(getNextAttackBlock(249, 150, 100)).toBe(250)
    expect(getNextAttackBlock(250, 150, 100)).toBe(400)
  })

  it('estimates the wall-clock time to the next attack from the block gap', () => {
    // 150 blocks away at 2s per block.
    expect(getMsUntilNextAttack(100, 150, 100, 2000)).toBe(300_000)
    // One block away.
    expect(getMsUntilNextAttack(249, 150, 100, 2000)).toBe(2000)
  })

  it('predicts the attack epoch from the deadline, before anybody schedules it', () => {
    // Genesis 100, 150-block epochs, 2s blocks. Block 250 is the start of
    // epoch 1; a deadline 300 blocks (600s) out lands in epoch 3, so the
    // protocol will schedule the attack for epoch 4 — one after the epoch
    // applications close in, with a full epoch remaining.
    expect(
      predictAttackEpoch({
        nowMs: 1_000_000,
        deadlineMs: 1_000_000 + 600_000,
        blockNumber: 250,
        epochBlocks: 150,
        genesisBlock: 100,
        blockTimeMs: 2000,
      }),
    ).toBe(4)
  })

  it('treats a deadline that has already passed as "starts now"', () => {
    // Nothing is owed to the past: the operation starts in this block, so
    // the attack is the next epoch's, not one measured from the deadline.
    expect(
      predictAttackEpoch({
        nowMs: 1_000_000,
        deadlineMs: 900_000,
        blockNumber: 250,
        epochBlocks: 150,
        genesisBlock: 100,
        blockTimeMs: 2000,
      }),
    ).toBe(2)
  })

  it('answers null rather than guessing when the block clock has not been read', () => {
    // A guess from `Date.now()` would put two clients on different epochs,
    // which is the one thing the epoch grid exists to prevent.
    expect(
      predictAttackEpoch({
        nowMs: 1_000_000,
        deadlineMs: 1_100_000,
        blockNumber: null,
        epochBlocks: 150,
        genesisBlock: 100,
        blockTimeMs: 2000,
      }),
    ).toBeNull()
  })

  it('keeps the next epoch when at least 90% of it remains after the deadline', () => {
    // Genesis 100, 150-block epochs. Epoch 0 is 100..249. Deadline at 110
    // leaves 140 blocks until 250, which is ≥ 135.
    expect(launchEpochOf(110, 150, 100)).toBe(1)
    expect(getEpochStartBlock(1, 150, 100) - 110).toBeGreaterThanOrEqual(135)
  })

  it('skips a launch boundary that would fire one block after applications close', () => {
    // Last block of epoch 0. Naive launch is 250 — one block later.
    expect(launchEpochOf(249, 150, 100)).toBe(2)
    expect(getEpochStartBlock(2, 150, 100) - 249).toBe(151)
  })

  it('skips when remaining time after the deadline drops under 90% of an epoch', () => {
    // Offset 16 of 150 leaves 134 blocks, under 135.
    expect(launchEpochOf(116, 150, 100)).toBe(2)
    expect(launchEpochOf(115, 150, 100)).toBe(1)
  })

  it('predicts a skipped epoch from a late wall-clock deadline', () => {
    // Block 250 is the start of epoch 1. 140 blocks out lands at 390, 10
    // blocks before epoch 2 starts — under the 90% cushion, so epoch 3.
    expect(
      predictAttackEpoch({
        nowMs: 1_000_000,
        deadlineMs: 1_000_000 + 140 * 2000,
        blockNumber: 250,
        epochBlocks: 150,
        genesisBlock: 100,
        blockTimeMs: 2000,
      }),
    ).toBe(3)
  })

  it('converts a wall-clock deadline to a block strictly ahead of the head', () => {
    // 300s out at 2s per block is 150 blocks.
    expect(deadlineBlockOf({ nowMs: 1_000_000, deadlineMs: 1_300_000, blockNumber: 250, blockTimeMs: 2000 })).toBe(400)
  })

  /*
   * The contract requires a deadline strictly ahead of the head, so a
   * deadline that has already passed — or one the creator set for this very
   * second — still has to name a block that has not been mined. Returning
   * the head would mint an operation whose join window was already over.
   */
  it('never names the current block, even for a deadline in the past', () => {
    expect(deadlineBlockOf({ nowMs: 1_000_000, deadlineMs: 900_000, blockNumber: 250, blockTimeMs: 2000 })).toBe(251)
    expect(deadlineBlockOf({ nowMs: 1_000_000, deadlineMs: 1_000_000, blockNumber: 250, blockTimeMs: 2000 })).toBe(251)
  })

  it('answers null rather than guessing a block before the chain has been read', () => {
    expect(deadlineBlockOf({ nowMs: 1_000_000, deadlineMs: 1_300_000, blockNumber: null, blockTimeMs: 2000 })).toBeNull()
  })

  /*
   * The floor the Create Operation countdown is built on: whatever deadline a
   * creator picks, the cushion leaves at least 90% of an epoch before the
   * threat launches. That is why that readout can never reach zero — and why
   * it no longer carries an "imminent" state calibrated on a value it cannot
   * reach.
   */
  it('always leaves at least 90% of an epoch between the deadline and the launch', () => {
    const epochBlocks = 150
    const genesis = 100
    const cushion = Math.floor((epochBlocks * 90) / 100)

    for (let deadlineBlock = genesis; deadlineBlock < genesis + epochBlocks * 3; deadlineBlock += 1) {
      const launchBlock = getEpochStartBlock(launchEpochOf(deadlineBlock, epochBlocks, genesis), epochBlocks, genesis)
      expect(launchBlock - deadlineBlock).toBeGreaterThanOrEqual(cushion)
    }
  })

  it('produces a deterministic seed for identical inputs', () => {
    const lobbyId = '0xabc' as Hash
    const blockHash = '0xdef' as Hash
    const seedA = generateEpochSeed(lobbyId, 3, blockHash, 'salt')
    const seedB = generateEpochSeed(lobbyId, 3, blockHash, 'salt')
    expect(seedA).toBe(seedB)
  })

  it('produces different seeds for different epoch ids', () => {
    const lobbyId = '0xabc' as Hash
    const blockHash = '0xdef' as Hash
    const seedA = generateEpochSeed(lobbyId, 3, blockHash, 'salt')
    const seedB = generateEpochSeed(lobbyId, 4, blockHash, 'salt')
    expect(seedA).not.toBe(seedB)
  })
})
