import { useEffect, useState } from 'react'
import { useCountdownClock, useSmoothCountdown } from '../../hooks/useSmoothCountdown'
import { appConfig } from '../../config/env'
import { useEpochClock } from '../../hooks/useEpochClock'
import type { ProtocolAdvance } from '../../hooks/useProtocolAdvance'
import { calculateParticipantCost } from '../../game/economics'
import { isProtocolOwnedLobby } from '../../game/globalDefense'
import { getConfiguredContractAddress } from '../../contracts/addresses'
import { operationStatusLabel, refundCause, type LobbyPhase, type RefundCause } from '../../game/lobbyPhase'
import type { Lobby, Participant } from '../../game/types'
import { formatEth, formatLongCountdown } from '../../utils/format'
import { DronePanel } from '../drones/DronePanel'
import { JoinLobbyButton } from './JoinLobbyButton'
import { LobbyHeader } from './LobbyHeader'
import styles from './LobbyIntro.module.css'

export interface LobbyIntroProps {
  lobby: Lobby
  /**
   * The derived phase, which is what the rest of the screen is showing.
   *
   * Passed in rather than re-derived here, because the one state this
   * component most needs to distinguish — the deadline having passed with
   * too few defenders — is invisible in `lobby.status` alone (ТЗ §18).
   */
  phase: LobbyPhase
  hasJoined: boolean
  onJoined: () => void
  /** ТЗ §5 — withdraw before the operation starts. */
  onLeave: () => void
  isLeaving: boolean
  /**
   * ТЗ §5 — what leaving would pay back. Zero on the protocol's own draw
   * unless Recon Probes were bought; then only those. Stated on the control
   * when it is above zero, because "do I lose my probes?" is the question.
   */
  refundable: number
  /** The amount the protocol actually paid back, once it has. */
  refunded: number | null
  /**
   * ТЗ §10 — the transition the chain is behind on, when there is one.
   *
   * With no backend, closing applications and cancelling an under-filled
   * operation are transactions somebody has to send, and the somebody is
   * whoever has the page open. It is offered here as an explicit control
   * rather than fired from an effect: a wallet should only ever open
   * because a player pressed something.
   */
  advance: ProtocolAdvance
  /**
   * This defender's seat, used to put their probe allotment on Buy.
   * Null until the roster has them — the free count still comes from the
   * operation's terms.
   */
  participant: Participant | null
  onBuyProbe: () => void
  isBuyingProbe: boolean
  probePurchaseBlocked: string | null
  probePurchaseError: string | null
}

/**
 * The Operation screen's counterpart to `SpaceHero` (spec §10) — same place
 * under the header, same four-part shape: title, the line that explains it,
 * the accented call, one primary action.
 *
 * It exists only *before* the operation runs. ТЗ §1.1 removes the hero
 * entirely once the lobby is ACTIVE and moves every control into the
 * Command Center, so this component has exactly two states to render —
 * applications open, and applications closed but not yet started — rather
 * than a third that tried to be a second console.
 *
 * Everything else about the operation — its full configuration, economics,
 * participants, activity — belongs in the details drawer, never here.
 */
export function LobbyIntro({
  lobby,
  phase,
  hasJoined,
  onJoined,
  onLeave,
  isLeaving,
  refundable,
  refunded,
  advance,
  participant,
  onBuyProbe,
  isBuyingProbe,
  probePurchaseBlocked,
  probePurchaseError,
}: LobbyIntroProps) {
  // The block deadline is the one the protocol enforces; the timestamp is
  // the fallback when an operation has no block deadline to read. Both
  // countdowns share the app clock so this figure and the details drawer
  // cannot disagree.
  const nowMs = useCountdownClock()
  const { blockNumber, timestampMs } = useEpochClock()
  const blockTimeMs = appConfig.blockTimeMs
  const blocksUntilDeadline =
    lobby.config.participation.deadlineBlock > 0 && blockNumber !== null
      ? Math.max(0, lobby.config.participation.deadlineBlock - blockNumber)
      : null
  const msFromBlocks = useSmoothCountdown(blocksUntilDeadline, blockTimeMs, timestampMs)
  const msUntilDeadline = msFromBlocks ?? Math.max(0, lobby.config.participation.deadline - nowMs)
  const isAcceptingApplications = lobby.status === 'OPEN' && msUntilDeadline > 0
  const isCancelled = lobby.status === 'CANCELLED'
  /*
   * ТЗ §18 — the deadline passed and not enough people came.
   *
   * On chain this is still an OPEN lobby, because the status only changes
   * when somebody sends `cancelLobby`. To a player it is not open at all:
   * the operation can never run, and the only thing left is to cancel it so
   * the entry fees can be claimed back. Saying "applications closed" here
   * described a queue that was about to move.
   */
  const isUndersubscribed = phase === 'UNDERSUBSCRIBED'
  const [joinHeld, setJoinHeld] = useState(false)
  useEffect(() => {
    if (hasJoined) setJoinHeld(false)
  }, [hasJoined])
  const seated = hasJoined || joinHeld

  const defenders = `${lobby.participantCount} / ${lobby.config.participation.maxPlayers} defenders`
  const joinCost = calculateParticipantCost(
    lobby.config.participation.entryPrice,
    lobby.config.economics.creatorFeePercent,
    isProtocolOwnedLobby(lobby.creator, getConfiguredContractAddress()),
  )
  const terms = isAcceptingApplications
    ? [
        defenders,
        joinCost === 0 ? 'free to join' : `${formatEth(joinCost)} to join`,
        `closes in ${formatLongCountdown(msUntilDeadline)}`,
      ]
    : [
        defenders,
        isCancelled
          ? operationStatusLabel(lobby).toLowerCase()
          : isUndersubscribed
            ? `needed ${lobby.config.participation.minPlayers}`
            : 'applications closed',
      ]

  return (
    <div className={styles.intro}>
      <LobbyHeader lobby={lobby} />
      <p className={styles.subtitle}>{terms.filter(Boolean).join(' · ')}</p>
      <p className={styles.tagline}>
        {tagline({
          hasJoined: seated,
          isAcceptingApplications,
          isCancelled,
          isUndersubscribed,
          cause: isCancelled ? refundCause(lobby) : null,
        })}
      </p>

      {/*
        ТЗ §10 — the transition nobody owns, offered rather than performed.
        It sits above the join call because when it is here it is the only
        thing that can move the operation at all: applications are over, and
        until somebody sends this the screen has nothing else to do.
      */}
      {advance.action ? (
        <div className={styles.advance}>
          {advance.busy ? (
            /*
             * Nothing to decide while it is in flight, so nothing to press:
             * the operation says what is happening to it. This is the whole
             * of what a defender sees in the ordinary case — the transition
             * is sent for them the moment the deadline passes.
             */
            <p className={styles.advanceStatus} role="status">
              {advance.pending}
            </p>
          ) : (
            <>
              <button type="button" className={styles.advanceButton} onClick={() => void advance.run()}>
                {advance.label}
              </button>
              <p className={styles.advanceNote}>{advance.description}</p>
            </>
          )}
          {advance.error ? <p className={styles.advanceError}>{advance.error}</p> : null}
        </div>
      ) : null}

      {isCancelled ? null : seated ? (
        /*
         * ТЗ §5 — Leave Operation, and only while there is still an
         * operation to leave. `isAcceptingApplications` is exactly the
         * window the protocol allows it in: once the deadline passes the
         * lobby is on its way to ACTIVE and the seat is committed, so the
         * control goes rather than staying on as a button that can only be
         * refused.
         *
         * Buy probe sits above it: buying is a move on this seat, and the
         * count on the button is the allotment a defender is looking at
         * while they still can. It stays after Leave goes (applications
         * closed, attack not yet airborne) because that is still the
         * protocol's purchase window.
         *
         * Leave is deliberately a quiet link under the tagline, not a
         * second call to action. The screen's one accent belongs to joining
         * — and, once seated, to the next spend.
         */
        <div className={styles.actions}>
          {hasJoined && !isUndersubscribed ? (
            <DronePanel
              lobby={lobby}
              participant={participant}
              onBuyDrone={onBuyProbe}
              isPurchasing={isBuyingProbe}
              blockedReason={probePurchaseBlocked}
              error={probePurchaseError}
            />
          ) : null}
          {isAcceptingApplications ? (
            <button type="button" className={styles.leave} onClick={onLeave} disabled={isLeaving}>
              <LeaveIcon className={styles.leaveIcon} />
              {isLeaving ? 'Leaving…' : refundable > 0 ? `Leave · refunds ${formatEth(refundable)}` : 'Leave'}
            </button>
          ) : null}
        </div>
      ) : (
        <JoinLobbyButton
          lobby={lobby}
          hasJoined={hasJoined}
          onJoined={() => {
            setJoinHeld(true)
            onJoined()
          }}
          className={styles.cta}
        />
      )}

      {/*
        ТЗ §5 — the refund, confirmed. Nothing else on the screen changes
        visibly when a defender withdraws (the seat simply stops existing),
        so without this the money moving is invisible and the player is left
        to trust that it did.
      */}
      {refunded !== null ? (
        <p className={styles.refund} role="status">
          {refunded > 0
            ? `Refunded ${formatEth(refunded)} — entry, creator commission and every Recon Probe you bought.`
            : 'You left the operation.'}
        </p>
      ) : null}
    </div>
  )
}

/** Leave Operation — a door with an arrow stepping out of it. */
function LeaveIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M13 4H6.5A1.5 1.5 0 0 0 5 5.5v13A1.5 1.5 0 0 0 6.5 20H13" />
      <path d="M10 12h10.5" />
      <path d="M17.5 8.5 21 12l-3.5 3.5" />
    </svg>
  )
}

function tagline({
  hasJoined,
  isAcceptingApplications,
  isCancelled,
  isUndersubscribed,
  cause,
}: {
  hasJoined: boolean
  isAcceptingApplications: boolean
  isCancelled: boolean
  isUndersubscribed: boolean
  cause: RefundCause | null
}): string {
  /*
   * ТЗ §18 — a cancelled operation says so, and says what happens to the
   * money. It used to fall through to "applications are closed", which is
   * true and useless: it reads as an operation that is about to start,
   * while the actual situation is that this one never will and the entry
   * is sitting on the contract waiting to be claimed.
   *
   * The sentence used to always be "not enough defenders", which is only
   * one of the three ways an operation ends without a contest. A room that
   * filled and then sat idle — no probe, no intercept — is a different
   * reason, and naming the wrong one is worse than naming none.
   *
   * The claim panel is the action; this line names the reason and that
   * the funds are there to take. "Available for refund" repeated the
   * same word the button already is.
   */
  if (isCancelled && cause) {
    return cancelledTagline(hasJoined, cause)
  }
  /*
   * The cancellation has not been sent yet, so this says what is true and
   * what comes next — rather than "you are defending this operation", which
   * is what a joined defender used to be told about an operation that could
   * no longer happen.
   */
  if (isUndersubscribed) {
    return hasJoined
      ? 'Not enough defenders joined before the deadline — cancel to return everyone their entry'
      : 'Not enough defenders joined before the deadline — this operation cannot run'
  }
  if (isAcceptingApplications) {
    return hasJoined ? 'You are defending this operation' : 'Take a position before applications close'
  }
  // Telegraphic, like every other line in this block. "Applications for
  // this operation are closed" spent five words re-identifying an operation
  // the player is already looking at.
  return hasJoined ? 'You are defending this operation' : 'Applications closed'
}

function cancelledTagline(hasJoined: boolean, cause: RefundCause): string {
  switch (cause) {
    case 'unplayed':
      return hasJoined
        ? 'Nobody sent a Recon Probe or intercept — funds are available to claim'
        : 'Cancelled: nobody sent a Recon Probe or intercept'
    case 'protocol':
      return hasJoined
        ? 'The protocol could not complete this round — funds are available to claim'
        : 'Cancelled: the protocol could not complete this round'
    case 'undersubscribed':
      return hasJoined
        ? 'Not enough defenders joined — funds are available to claim'
        : 'Cancelled: not enough defenders joined before the deadline'
  }
}
