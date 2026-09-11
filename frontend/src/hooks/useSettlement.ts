import { useCallback, useRef, useState } from 'react'
import type { BlockchainClient } from '../blockchain'
import type { ClaimItem, ClaimPart } from '../components/command/SettlementPanel'
import { claimRefund, claimReward, getLobby, settleCreator } from '../game/gameService'
import { refundCause } from '../game/lobbyPhase'
import type { Address, Lobby, LobbyEnding, Participant } from '../game/types'
import { formatClaimEth } from '../utils/format'
import { useBlockchainClient } from './useBlockchainClient'
import { useWallet } from './useWallet'

/**
 * Everything an operation still owes the wallet looking at it (ТЗ §14.6,
 * §17, §18), as a list the screen renders and nothing more.
 *
 * It decides no entitlements. Whether this wallet won, whether the refund is
 * still unclaimed and how much any of it is worth are settled by the
 * protocol when each transaction lands — this reads the protocol's own
 * record back (`payoutState`, `refunded`, `outcome`) and turns it into
 * controls. Reading it rather than remembering what this session did is what
 * makes "claimed" survive a reload and makes a second claim impossible to
 * stage from the UI.
 *
 * Two claims, never stacked: a refund from an operation that never ran, and
 * a claim from one that did. The author's claim is the prize share plus the
 * Creator Fee in one sum; everyone else is owed the prize share alone.
 */

/**
 * The two endings that owe money back (ТЗ §18): the round never ran, either
 * because nobody played it or because the protocol could not complete it.
 * A COMPLETED round owes nothing — it was delivered, win or lose.
 */
function isRefundable(ending: LobbyEnding): boolean {
  return ending === 'UNPLAYED' || ending === 'CANCELLED'
}

export function useSettlement(
  lobby: Lobby | null,
  participant: Participant | null,
  /** Re-read the operation once money has moved, so the claim re-renders as paid. */
  onSettled: () => void | Promise<void>,
): ClaimItem[] {
  const client = useBlockchainClient()
  const { address } = useWallet()
  const [busy, setBusy] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string | null>>({})
  const [paid, setPaid] = useState<Record<string, number>>({})
  const inflight = useRef<string | null>(null)

  const run = useCallback(
    async (key: string, action: () => Promise<{ amount: number | null }>) => {
      if (inflight.current) return
      inflight.current = key
      setBusy(key)
      setErrors((current) => ({ ...current, [key]: null }))
      try {
        const { amount } = await action()
        if (amount !== null) setPaid((current) => ({ ...current, [key]: amount }))
        // Stay locked until the lobby re-read lands as paid. Clearing `busy`
        // on the write returning left Claim pressable for the whole RPC
        // round-trip — the same couple of seconds the player just waited
        // through a wallet confirmation to be done with.
        await onSettled()
      } catch (err) {
        setErrors((current) => ({ ...current, [key]: err instanceof Error ? err.message : String(err) }))
      } finally {
        inflight.current = null
        setBusy(null)
      }
    },
    [onSettled],
  )

  if (!lobby || !address) return []

  const claims: ClaimItem[] = []
  const outcome = lobby.outcome
  const isCreator = lobby.creator.toLowerCase() === address.toLowerCase()

  /*
   * ТЗ §18 — the refund, and the reason this list exists at all.
   *
   * A cancelled operation holds everything paid into it. Under-filled rooms
   * are paid in `cancelLobby` itself; `expireAttack` records the debt and
   * each owner comes and takes it. Defenders and the creator are on the
   * same call — entry, author commission, probes, and the bounty the
   * creator funded — so the author is not left on a second button after
   * every defender has already been paid. The protocol creation fee stays.
   */
  const participantShare =
    participant && isRefundable(lobby.ending) && participant.paidIn > 0 ? participant.paidIn : 0
  const creatorShare =
    isCreator && isRefundable(lobby.ending) && (lobby.creatorSettlement > 0 || lobby.creatorSettled)
      ? lobby.creatorSettlement
      : 0
  const refundAmount = participantShare + creatorShare
  const refundClaimed =
    (participantShare === 0 || Boolean(participant?.refunded)) && (!isCreator || creatorShare === 0 || lobby.creatorSettled)

  if (refundAmount > 0) {
    claims.push({
      key: 'refund',
      parts: claimParts([
        ['entry', participantShare],
        ['pool', creatorShare],
      ]),
      note: refundClaimNote(isCreator, lobby),
      amount: paid.refund ?? refundAmount,
      claimed: refundClaimed,
      busy: busy === 'refund',
      error: errors.refund ?? null,
      onClaim: () =>
        void run('refund', () => collectCancelledRefund(client, address, lobby, participant, isCreator)),
    })
  }

  /*
   * ТЗ §17 / §14.6 — one claim on a round that ran.
   *
   * A winner takes their prize-pool share. The author takes the Creator Fee
   * on the same button, and if they also intercepted, the two figures add
   * into one sum with the split written under it.
   */
  const prizeDue =
    participant && outcome?.intercepted && participant.payoutState !== 'NONE' ? outcome.rewardPerWinner : 0
  const feeDue =
    isCreator && !isRefundable(lobby.ending) && (lobby.creatorSettlement > 0 || lobby.creatorSettled)
      ? lobby.creatorSettlement
      : 0
  const payoutAmount = prizeDue + feeDue
  const payoutClaimed =
    (prizeDue === 0 || participant?.payoutState === 'PAID') && (!isCreator || feeDue === 0 || lobby.creatorSettled)

  if (payoutAmount > 0) {
    claims.push({
      key: 'reward',
      parts: claimParts([
        ['prize', prizeDue],
        ['fee', feeDue],
      ]),
      note: completedClaimNote(isCreator, prizeDue, feeDue, lobby.config.economics.creatorFeePercent),
      amount: paid.reward ?? payoutAmount,
      claimed: payoutClaimed,
      busy: busy === 'reward',
      error: errors.reward ?? null,
      onClaim: () =>
        void run('reward', () =>
          collectCompletedPayout(client, address, lobby, isCreator, participant?.payoutState === 'PENDING')),
    })
  }

  return claims
}

/**
 * The pieces that are actually in the sum, in the order they are named.
 *
 * A part with nothing in it is not named: this is the difference between
 * "Reward + Fee" on a creator who won and "Fee" on a creator who did not,
 * and getting it wrong is how a lost round came to be labelled a reward.
 */
function claimParts(entries: ReadonlyArray<readonly [ClaimPart, number]>): ClaimPart[] {
  return entries.filter(([, amount]) => amount > 0).map(([part]) => part)
}

function refundClaimNote(isCreator: boolean, lobby: Lobby): string {
  const cause = refundCause(lobby)
  const why =
    cause === 'protocol'
      ? 'The protocol could not complete this round'
      : cause === 'undersubscribed'
        ? 'Not enough defenders joined'
        : 'Nobody sent a probe or intercept'
  return isCreator
    ? `${why}, so the operation is being unwound. The prize pool you funded comes back to you in full — the protocol keeps only the fee you paid to create it.`
    : `${why}, so the operation is being unwound. Everything you paid to enter comes back to you.`
}

/**
 * The long form of the label, and the place every question about the figure
 * gets answered — the rail's caption is three words on an eight-pixel line,
 * so this is what a reader falls back to.
 *
 * Each says the same three things: what the money is, where it came from,
 * and that it is moving *towards* this wallet. "Creator Fee (5%) for
 * filling this operation" said the first two and left the third to be
 * guessed, which on a round the wallet had just lost is the wrong guess to
 * invite.
 */
function completedClaimNote(isCreator: boolean, prize: number, fee: number, creatorFeePercent: number): string {
  if (isCreator && prize > 0 && fee > 0) {
    return `You are paid ${formatClaimEth(prize)} as your share of the prize pool for intercepting the attack, plus ${formatClaimEth(fee)} — the ${creatorFeePercent}% of the entry fees this operation pays whoever created it.`
  }
  if (isCreator && fee > 0) {
    return `You are paid ${creatorFeePercent}% of the entry fees for creating this operation. This is a payout, not a charge: it is owed to you whether or not you intercepted the attack.`
  }
  return 'Your share of the prize pool, for intercepting the attack.'
}

/**
 * One refund for a round that never ran: the defender's `paidIn` and, if
 * this wallet created the operation, the bounty they funded at mint.
 * The protocol creation fee is never in this sum.
 *
 * New deployments pay both in `claimRefund`. An older contract still
 * splits them, so a creator who is also a defender may need `settleCreator`
 * after the refund — one button, not two, even then.
 */
async function collectCancelledRefund(
  client: BlockchainClient,
  address: Address,
  lobby: Lobby,
  participant: Participant | null,
  isCreator: boolean,
): Promise<{ amount: number | null }> {
  const needsParticipant = Boolean(participant && participant.paidIn > 0 && !participant.refunded)
  const needsCreator = isCreator && !lobby.creatorSettled

  let total = 0

  if (needsParticipant) {
    const result = await claimRefund(client, address, lobby.id)
    total += result.amount ?? 0
  } else if (needsCreator) {
    try {
      const result = await claimRefund(client, address, lobby.id)
      total += result.amount ?? 0
    } catch (err) {
      // Older deployments require `joined`, so a creator who never sat as a
      // defender (or who already took that refund) still needs settleCreator.
      if (!isClaimRefundMiss(err)) throw err
    }
  }

  if (needsCreator) {
    const latest = await getLobby(client, lobby.id)
    if (latest?.creatorSettled) return { amount: total }
    const result = await settleCreator(client, address, lobby.id)
    total += result.amount ?? 0
  }

  return { amount: total }
}

/**
 * One claim on a round that ran: the prize share, and for the author the
 * Creator Fee on the same click.
 *
 * New deployments fold the fee into `claimReward` when the author also
 * won. An older contract still splits them, and a creator who missed still
 * uses `settleCreator` — one button either way.
 */
async function collectCompletedPayout(
  client: BlockchainClient,
  address: Address,
  lobby: Lobby,
  isCreator: boolean,
  needsReward: boolean,
): Promise<{ amount: number | null }> {
  const needsCreator = isCreator && !lobby.creatorSettled
  const attackId = lobby.outcome?.attackId
  let total = 0

  if (needsReward && attackId) {
    const result = await claimReward(client, address, { lobbyId: lobby.id, attackId })
    total += result.amount ?? 0
  }

  if (needsCreator) {
    if (needsReward) {
      const latest = await getLobby(client, lobby.id)
      if (latest?.creatorSettled) return { amount: total }
    }
    const result = await settleCreator(client, address, lobby.id)
    total += result.amount ?? 0
  }

  return { amount: total }
}

function isClaimRefundMiss(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /notparticipant|has not joined|alreadyclaimed|already been claimed/i.test(message)
}
