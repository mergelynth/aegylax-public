import type { LobbyConfig, PrizePool } from './types'

/**
 * Operation economics.
 *
 * Money enters an operation from three directions and leaves in three:
 *
 *   in   — the creator's Start Prize Pool, the protocol creation fee
 *          (paid by the author at mint, never refunded), the entry prices,
 *          and the author's commission on each join.
 *   out  — the protocol's creation fee (treasury), the author's commission
 *          (theirs if the round starts), and the reward the winner claims.
 *
 * Every wei of entry goes into the prize pool when the round starts. The
 * author's commission is a separate payment, not a cut of the entry.
 */

export function calculateCreatorFee(entryPrice: number, participantCount: number, creatorFeePercent: number): number {
  return entryPrice * participantCount * (creatorFeePercent / 100)
}

export function calculateAuthorCommission(entryPrice: number, creatorFeePercent: number): number {
  return entryPrice * (creatorFeePercent / 100)
}

/** Protocol creation fee — charged once, at mint, not per player. */
export function calculateProtocolFee(_participantCount: number, protocolJoinFee: number): number {
  return protocolJoinFee
}

/**
 * What joining costs. A player-created operation takes the entry plus the
 * author's commission (`creatorFeePercent` of the entry). The protocol's
 * own draw mints with a 0% commission, so sitting in the jackpot is free.
 */
export function calculateParticipantCost(
  entryPrice: number,
  creatorFeePercent: number,
  protocolOwned = false,
): number {
  return entryPrice + (protocolOwned ? 0 : calculateAuthorCommission(entryPrice, creatorFeePercent))
}

export function joinCostOf(
  config: Pick<LobbyConfig, 'participation' | 'economics'>,
  protocolOwned = false,
): number {
  return calculateParticipantCost(
    config.participation.entryPrice,
    config.economics.creatorFeePercent,
    protocolOwned,
  )
}

/**
 * What the Leave control should advertise.
 *
 * On a player operation that is everything `paidIn`. On the protocol's own
 * draw the seat was never supposed to cost anything, so the button only
 * names `probesPaid`.
 */
export function leaveRefundPreview(input: {
  protocolOwned: boolean
  paidIn: number
  probesPaid: number
}): number {
  if (!input.protocolOwned) return input.paidIn
  return input.probesPaid
}

export function calculatePrizeBalance(config: LobbyConfig, participantCount: number): Omit<PrizePool, 'lobbyId'> {
  const entryFeesCollected = config.participation.entryPrice * participantCount
  const creatorFeeReserved = calculateCreatorFee(
    config.participation.entryPrice,
    participantCount,
    config.economics.creatorFeePercent,
  )
  const protocolFeeReserved = config.economics.protocolJoinFee

  return {
    startPrizePool: config.economics.prizePool,
    entryFeesCollected,
    creatorFeeReserved,
    protocolFeeReserved,
    // Entries are no longer cut: the author's commission is a separate
    // payment, so the residual is the whole of the entry money.
    entryFeeResidual: entryFeesCollected,
    distributable: config.economics.prizePool + entryFeesCollected,
  }
}

/**
 * Splits the reward pool between the winners (ТЗ §17).
 *
 * There is normally exactly one winner — ТЗ §11.6 makes the earliest
 * entry along the path the victory — so the split only ever has work to
 * do in the exact-tie case, where two radii meet the live threat at the
 * same moment. On a failed defense nobody is paid at all (§17.1).
 *
 * TODO (§57): rounding and dust are not specified. `rewardPerWinner *
 * winnerCount` can therefore fall a wei short of `distributable`.
 */
export function calculateRewardPerWinner(distributable: number, winnerCount: number): number {
  if (winnerCount <= 0) return 0
  return distributable / winnerCount
}
