import type { ReactNode } from 'react'
import type { LobbyPhase } from '../../game/lobbyPhase'
import { sectorToLabel } from '../../game/map'
import type { DefensePoint } from '../../game/types'
import { BusySweep } from '../../motion/BusySweep'
import { CrosshairIcon, ProbeIcon, ScanIcon, ShieldIcon, SignalIcon } from './CommandIcons'
import { CommandHudChrome } from './CommandHudOrbit'
import { CommandRail } from './CommandRail'
import { COMMAND_HUD_SKIN, revealLabel } from './hudSkin'
import { SettlementPanel, type ClaimItem } from './SettlementPanel'
import styles from './CommandCenter.module.css'

export interface CommandCenterProps {
  lobbyPhase: LobbyPhase

  /** Prize currently in the pool — the figure a player can win. */
  potEth?: number
  probesAvailable: number
  probesUsed: number
  /** Capacity, not spent. Shown as remaining / max. */
  probesMax?: number

  stagedPoint: DefensePoint | null
  submittedPoint: DefensePoint | null

  onSendRecon: () => void
  reconBlockedReason: string | null
  isReconBusy: boolean
  /**
   * Whether the probe transaction is in flight — the wallet prompt and the
   * mining — as opposed to `isReconBusy`, which stays on while an answer
   * ripens afterwards. Only this one blocks the control; see
   * `reconDisabled`.
   */
  isReconSending: boolean

  onSendDefense: () => void
  defenseBlockedReason: string | null
  isDefenseBusy: boolean
  /**
   * Whether the placed point is being encrypted right now.
   *
   * Not the same as busy. Busy means a transaction is on its way; this
   * means the point is being sealed against the confidential network,
   * which takes five to nine seconds and starts on its own a moment after
   * the marker settles. The button stays live throughout — pressing during
   * it is allowed and simply waits for the same work — but a player who
   * can see it is happening knows the wait is shorter if they let it
   * finish, and does not read the silence as a broken control.
   */
  isDefenseArming?: boolean

  /** ТЗ §7 — the reveal, offered on a finished round until somebody has taken it. */
  canRequestReveal: boolean
  /**
   * Whether the backend keeper is already carrying this reveal.
   *
   * The slot still belongs to the reveal, but it reports rather than asks:
   * pressing would only send the nudge that is already in flight, and a
   * button offered for work already happening reads as an app that has lost
   * track of itself. It goes back to being pressable if the keeper does not
   * finish — see `REVEAL_PATIENCE_MS`.
   */
  revealAuto?: boolean
  onRequestReveal: () => void
  isRevealBusy: boolean

  /**
   * Everything the operation still owes this wallet (ТЗ §14.6, §17, §18) —
   * the claim, the refund, or nothing. It replaces the panel once there is
   * something to take.
   */
  claims: ClaimItem[]

  /**
   * What went wrong with the last thing this console tried to do.
   *
   * It belongs here rather than only in the details drawer, which is where
   * every failure used to land. A drawer the player has closed — and one
   * that is closed by default on an operation they have already read — is
   * not somewhere a message about the button they just pressed can live: a
   * refused probe, a defense the chain rejected and a reveal that could not
   * fetch its attestations were all indistinguishable from a dead control.
   * A player pressing a button is owed the answer next to the button.
   */
  error?: string | null

  /**
   * Submit vs the recon corridor's clock, for the staged or submitted point.
   * Null until there is a point. `late` is the same comparison the protocol
   * will make at reveal, estimated from the fused bearing.
   */
  defenseTimingNote?: string | null
  defenseTimingLate?: boolean
  defenseTimingEarly?: boolean

  /**
   * One line on a finished round that owes this wallet nothing. The Result
   * HUD already has the verdict; this is the console staying on Earth so
   * the planet is not empty, naming why there is no claim.
   */
  settledNote?: string | null

  /** Whether the attack was intercepted. Null until the round is resolved. */
  attackIntercepted?: boolean | null
  /** This wallet was first to hit. */
  ownHit?: boolean
  /** Unsigned visitor — rail stays, Sign in is the verb. */
  onSignIn?: (() => void) | null
  isSignInBusy?: boolean
}

/**
 * The Command Center (ТЗ §1) — a holographic HUD lying *on* the planet.
 *
 * Chamfered glass: a static gray outer rim, a notched inner track with
 * two opposing neon comets, two readings on the left and two verbs on
 * the right. Recon is the small cyan disc; Defense is the large ringed
 * control that commits the round.
 *
 * The comets are drawn on `ATTACK_ACTIVE` only — the phase the console's
 * two verbs are live in. Every other phase gets the bare frame, so the
 * neon means there is something in the sky rather than merely that the
 * panel is on screen.
 */
export function CommandCenter({
  lobbyPhase,
  potEth = 0,
  probesAvailable,
  probesUsed,
  probesMax,
  stagedPoint,
  submittedPoint,
  onSendRecon,
  reconBlockedReason,
  isReconBusy,
  isReconSending,
  onSendDefense,
  defenseBlockedReason,
  isDefenseBusy,
  isDefenseArming = false,
  canRequestReveal,
  revealAuto = false,
  onRequestReveal,
  isRevealBusy,
  claims,
  error = null,
  defenseTimingNote = null,
  defenseTimingLate = false,
  defenseTimingEarly = false,
  settledNote = null,
  attackIntercepted = null,
  ownHit = false,
  onSignIn = null,
  isSignInBusy = false,
}: CommandCenterProps) {
  if (COMMAND_HUD_SKIN !== 'classic') {
    return (
      <CommandRail
        lobbyPhase={lobbyPhase}
        potEth={potEth}
        probesAvailable={probesAvailable}
        probesMax={probesMax ?? Math.max(probesAvailable, 1)}
        stagedPoint={stagedPoint}
        submittedPoint={submittedPoint}
        onSendRecon={onSendRecon}
        reconBlockedReason={reconBlockedReason}
        isReconBusy={isReconBusy}
        isReconSending={isReconSending}
        onSendDefense={onSendDefense}
        defenseBlockedReason={defenseBlockedReason}
        isDefenseBusy={isDefenseBusy}
        isDefenseArming={isDefenseArming}
        canRequestReveal={canRequestReveal}
        revealAuto={revealAuto}
        onRequestReveal={onRequestReveal}
        isRevealBusy={isRevealBusy}
        claims={claims}
        error={error}
        attackIntercepted={attackIntercepted}
        ownHit={ownHit}
        onSignIn={onSignIn}
        isSignInBusy={isSignInBusy}
      />
    )
  }

  const hasEnded = lobbyPhase === 'RESULT' || lobbyPhase === 'CANCELLED'

  /*
   * Once there is something to collect, the claims *replace* the panel
   * rather than joining it — see `SettlementPanel`.
   *
   * They wait for the reveal, though: the winner is the player most entitled
   * to see the trajectory they read correctly, and swapping the console out
   * first would hand them a payout instead of an answer.
   */
  if (claims.length > 0 && !canRequestReveal) {
    return <SettlementPanel claims={claims} />
  }

  /*
   * ТЗ §1 — a finished, revealed operation with no payout still keeps the
   * frame on Earth so the planet is not empty. The verbs go; one line
   * names why there is nothing to take. The verdict itself lives on the
   * Result HUD under the banner.
   */
  if (hasEnded && !canRequestReveal) {
    return (
      <section className={hudClass(styles.settled)} aria-label="Command Center" data-hud={COMMAND_HUD_SKIN}>
        <CommandHudChrome />
        <p className={styles.settledNote} role="status">
          {settledNote ?? 'Round complete'}
        </p>
      </section>
    )
  }

  /*
   * Busy and blocked are not the same thing, and conflating them cost a
   * player two thirds of their reconnaissance.
   *
   * `isReconBusy` stays true for the whole wait — the transaction, and then
   * the tens of seconds CoFHE takes to make the answer readable. That is
   * right for the *look* of the control: nothing else on screen says a
   * probe is out. It is wrong as a gate. The protocol's rule is three
   * blocks from the last send and nothing about the answer, so a player
   * whose first probe is still ripening is entitled to send the second —
   * and on a hundred-and-twenty-block flight, waiting for each answer
   * before the next probe does not leave enough of the window to defend in.
   *
   * `reconBlockedReason` already carries the real rule, and counts those
   * three blocks down rather than claiming a probe is in flight — nothing
   * is: the hint is granted by the send that computes it. So the gate is
   * that, plus the transaction round trip — which the rule cannot see,
   * because until the send lands there is no `lastProbeBlock` and no
   * reading to derive one from. A second press in that window buys a
   * signature on a transaction that will revert.
   */
  const reconDisabled = reconBlockedReason !== null || isReconSending
  const defenseDisabled = defenseBlockedReason !== null || isDefenseBusy
  const isLocked = submittedPoint !== null
  const waitReason = [reconBlockedReason, defenseBlockedReason].find(
    (reason) => reason != null && /block/i.test(reason),
  ) ?? null

  /*
   * ТЗ §1 — one line under the console, and it is now reserved for one thing:
   * **something went wrong.**
   *
   * It used to carry three kinds of message — the failure, a running
   * commentary of what the console was doing, and, when a control was
   * inactive, a sentence explaining why. The last two have gone, and the
   * reason is that the console already says both without words. A disabled
   * Defend button on a round that has not launched is not a mystery a caption
   * has to solve; the countdown directly above it is counting to the launch.
   * A cooldown is different: nothing else on screen counts those blocks,
   * so that wait is named next to the button. Failures stay here too.
   *
   * A failure is different in kind. Nothing on screen expresses it, the player
   * pressed something and is owed the answer next to what they pressed, and it
   * is by definition not the resting state.
   */
  const attackLive = lobbyPhase === 'ATTACK_ACTIVE'

  return (
    <section
      className={hudClass()}
      aria-label="Command Center"
      data-hud={COMMAND_HUD_SKIN}
      data-live={attackLive ? 'true' : undefined}
      data-scanning={isReconBusy ? 'true' : undefined}
    >
      <CommandHudChrome live={attackLive} scanning={isReconBusy} />
      {error ? (
        <p className={[styles.notice, styles.noticeError].join(' ')} role="alert">
          {error}
        </p>
      ) : waitReason ? (
        <p className={[styles.notice, styles.noticeWait].join(' ')} id="command-wait">{waitReason}</p>
      ) : null}
      <div className={styles.readouts}>
        <Readout
          icon={<ScanIcon className={styles.readoutIcon} />}
          label="Recon"
          value={`${probesAvailable} / ${probesUsed}`}
          tone="probe"
        />
        <span className={styles.readoutRule} aria-hidden="true" />
        <Readout
          icon={<CrosshairIcon className={styles.readoutIcon} />}
          label="Defense"
          value={pointLabel(submittedPoint ?? stagedPoint)}
          sub={defenseTimingNote ?? undefined}
          tone={isLocked ? 'locked' : defenseTimingLate || defenseTimingEarly ? 'late' : 'point'}
        />
      </div>

      <div className={styles.spine} aria-hidden="true">
        <span className={styles.spinePlus}>+</span>
        <span className={styles.spineLine} />
        <span className={styles.spinePlus}>+</span>
      </div>

      <div className={styles.actions}>
        <div className={styles.reconWrap}>
          <button
            type="button"
            className={[styles.reconButton, isReconBusy ? styles.reconBusy : ''].filter(Boolean).join(' ')}
            onClick={onSendRecon}
            disabled={reconDisabled}
            title={tooltipFor(reconDisabled, reconBlockedReason, lobbyPhase)}
            aria-label="Send Recon Probe"
            aria-disabled={reconDisabled}
            aria-describedby={reconDisabled && waitReason ? 'command-wait' : undefined}
          >
            <ProbeIcon className={styles.reconIcon} />
            {/*
              The same wait every other control in the app shows, rather
              than the charge ring and the pulsing glyph this button used to
              invent for itself. The layer clips itself, so the count badge
              hanging outside the circle is untouched.
            */}
            {isReconBusy ? <BusySweep /> : null}
            <span className={styles.badge}>{probesAvailable}</span>
          </button>
        </div>

        {canRequestReveal ? (
          <div className={[styles.defendWrap, styles.defendWrapReveal].join(' ')}>
            <span className={styles.defendDash} aria-hidden="true" />
            <span className={styles.defendHalo} aria-hidden="true" />
            <button
              type="button"
              className={[
                styles.defendButton,
                styles.revealButton,
                isRevealBusy || revealAuto ? styles.revealBusy : styles.revealWaiting,
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={onRequestReveal}
              disabled={isRevealBusy || revealAuto}
            >
              <SignalIcon className={styles.defendIcon} />
              <span className={styles.defendLabel}>{revealLabel(revealAuto, isRevealBusy)}</span>
              {isRevealBusy || revealAuto ? <BusySweep /> : null}
            </button>
          </div>
        ) : (
          <div
            className={[styles.defendWrap, isLocked ? styles.defendWrapSubmitted : '']
              .filter(Boolean)
              .join(' ')}
          >
            <span className={styles.defendDash} aria-hidden="true" />
            <span className={styles.defendHalo} aria-hidden="true" />
            <button
              type="button"
              className={[styles.defendButton, isLocked ? styles.defendSubmitted : ''].filter(Boolean).join(' ')}
              onClick={onSendDefense}
              disabled={defenseDisabled}
              title={tooltipFor(defenseDisabled, defenseBlockedReason, lobbyPhase)}
              aria-describedby={defenseDisabled && waitReason ? 'command-wait' : undefined}
            >
              <ShieldIcon className={styles.defendIcon} />
              <span className={styles.defendLabel}>
                {isLocked ? 'Submitted' : isDefenseBusy ? 'Sending' : isDefenseArming ? 'Sealing' : 'Defend'}
              </span>
              {/*
                "Sending" used to be the whole of this button's wait — a
                changed word on a control that otherwise sat perfectly
                still, which is the one state that looks like nothing is
                happening. It waits the way everything else does now.
              */}
              {(isDefenseBusy || isDefenseArming) && !isLocked ? <BusySweep /> : null}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}

function hudClass(...extra: Array<string | false | undefined>): string {
  return [styles.console, styles[COMMAND_HUD_SKIN], ...extra].filter(Boolean).join(' ')
}

/**
 * One line of the readout column (ТЗ §3): a glyph, a small tracked label,
 * the value at the size that actually matters, and no housing of any kind.
 * The tone is a text colour rather than a border or a chip — the point of
 * the rework is that these are readings printed on glass, not objects.
 */
function Readout({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: ReactNode
  label: string
  value: string
  sub?: string
  tone: string
}) {
  return (
    <div className={[styles.readout, styles[tone] ?? ''].filter(Boolean).join(' ')}>
      {icon}
      <span className={styles.readoutBody}>
        <span className={styles.readoutLabel}>{label}</span>
        <span className={styles.readoutValue}>{value}</span>
        {/*
          Its own line, not a tail on the value.

          Both used to share one `nowrap` line inside a column capped at 46%
          of the console, so the note was cut to its first letter: the
          Defense readout printed `H4 0.90 / 0.05 A…`, where the `A…` was
          "Arrives too late". The coordinate survived and the sentence about
          it — the half that says whether the shot is any good — did not.
        */}
        {sub ? <span className={styles.readoutSub}>{sub}</span> : null}
      </span>
    </div>
  )
}

/** NOT SET, or the coordinate itself, in the shortest form it can be written. */
function pointLabel(point: DefensePoint | null): string {
  if (!point) return 'Not set'
  return `${sectorToLabel(point.sector)} ${point.offsetX.toFixed(2)} / ${point.offsetY.toFixed(2)}`
}

/**
 * Hover/title copy for a dead control.
 *
 * Resting "opens when the attack launches" is already the countdown, so it
 * stays off the button. A cooldown, or any block during the flight, is
 * the thing the scene does not already say.
 */
function tooltipFor(disabled: boolean, reason: string | null, phase: LobbyPhase): string | undefined {
  if (!disabled || !reason) return undefined
  // The countdown above the console already counts to the launch.
  if (phase !== 'ATTACK_ACTIVE' && /launches/i.test(reason)) return undefined
  return reason
}
