import { describe, expect, it } from 'vitest'
import {
  calculateCreatorFee,
  calculatePrizeBalance,
  calculateProtocolFee,
  calculateParticipantCost,
  calculateRewardPerWinner,
  leaveRefundPreview,
} from '../../game/economics'
import { buildTestLobbyConfig } from '../fixtures'

const config = buildTestLobbyConfig({
  participation: { minPlayers: 2, maxPlayers: 10, entryPrice: 0.01, deadline: Date.now() + 1000, deadlineBlock: 0 },
  economics: { prizePool: 1, creatorFeePercent: 10, protocolJoinFee: 0.001 },
})

describe('economics', () => {
  it('calculates creator fee as a percentage of collected entries', () => {
    expect(calculateCreatorFee(0.01, 10, 10)).toBeCloseTo(0.01)
  })

  it('calculates protocol creation fee once, not per participant', () => {
    expect(calculateProtocolFee(5, 0.001)).toBeCloseTo(0.001)
  })

  it('calculates the per-participant join cost as entry plus author commission', () => {
    expect(calculateParticipantCost(0.01, 10)).toBeCloseTo(0.011)
  })

  it('waives the author commission on the protocol\'s own draw', () => {
    expect(calculateParticipantCost(0, 5, true)).toBe(0)
    expect(calculateParticipantCost(0.01, 5, true)).toBeCloseTo(0.01)
  })

  it('advertises only probe spend when leaving a protocol-owned draw', () => {
    expect(
      leaveRefundPreview({ protocolOwned: true, paidIn: 0.0005, probesPaid: 0 }),
    ).toBe(0)
    expect(
      leaveRefundPreview({ protocolOwned: true, paidIn: 0.002, probesPaid: 0.002 }),
    ).toBeCloseTo(0.002)
    expect(
      leaveRefundPreview({ protocolOwned: false, paidIn: 0.012, probesPaid: 0 }),
    ).toBeCloseTo(0.012)
    // A governed price cut must not shrink the advertised refund: three
    // probes bought at 0.0002 still return 0.0006 even if the Buy control
    // now reads 0.002.
    expect(
      leaveRefundPreview({ protocolOwned: true, paidIn: 0.0006, probesPaid: 0.0006 }),
    ).toBeCloseTo(0.0006)
  })

  it('calculates a full prize balance breakdown', () => {
    const balance = calculatePrizeBalance(config, 10)
    expect(balance.startPrizePool).toBeCloseTo(1)
    expect(balance.entryFeesCollected).toBeCloseTo(0.01 * 10)
    expect(balance.creatorFeeReserved).toBeCloseTo(0.01 * 10 * 0.1)
    expect(balance.protocolFeeReserved).toBeCloseTo(0.001)
    expect(balance.entryFeeResidual).toBeCloseTo(balance.entryFeesCollected)
  })

  it('puts the whole of the entries into the reward pool', () => {
    const balance = calculatePrizeBalance(config, 10)
    expect(balance.distributable).toBeCloseTo(balance.startPrizePool + balance.entryFeesCollected)
  })

  it('pays the creator on participation, not on outcome (ТЗ §14.6-14.7)', () => {
    // The only variable is how many defenders joined, and the fee has to
    // rise with it — that is the whole incentive to fill an operation.
    const few = calculatePrizeBalance(config, 2).creatorFeeReserved
    const many = calculatePrizeBalance(config, 20).creatorFeeReserved
    expect(many).toBeGreaterThan(few)
  })

  it('never returns a negative residual', () => {
    const balance = calculatePrizeBalance({ ...config, economics: { ...config.economics, creatorFeePercent: 100 } }, 10)
    expect(balance.entryFeeResidual).toBeGreaterThanOrEqual(0)
  })
})

describe('reward distribution (ТЗ §12.9, §13.6)', () => {
  it('splits the reward pool evenly between everyone who intercepted', () => {
    expect(calculateRewardPerWinner(1, 4)).toBeCloseTo(0.25)
  })

  it('pays nothing when nobody intercepted', () => {
    expect(calculateRewardPerWinner(1, 0)).toBe(0)
  })
})
