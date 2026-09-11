import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { AnimatePresence } from 'motion/react'
import type { LobbyPhase } from '../../game/lobbyPhase'
import type { DefensePoint } from '../../game/types'
import { formatClaimEth } from '../../utils/format'
import {
  RailAlert,
  RailAtmosphere,
  RailCta,
  RailPot,
  RailRecon,
  RailTrace,
  useEarthSilhouette,
  type CtaKind,
} from './CommandRailLive'
import { revealLabel } from './hudSkin'
import type { ClaimItem } from './SettlementPanel'
import styles from './CommandRail.module.css'

export interface CommandRailProps {
  lobbyPhase: LobbyPhase
  potEth: number
  probesAvailable: number
  probesMax: number
  stagedPoint: DefensePoint | null
  submittedPoint: DefensePoint | null
  onSendRecon: () => void
  reconBlockedReason: string | null
  isReconBusy: boolean
  isReconSending: boolean
  onSendDefense: () => void
  defenseBlockedReason: string | null
  isDefenseBusy: boolean
  isDefenseArming: boolean
  canRequestReveal: boolean
  /** The backend keeper is carrying this reveal — see `CommandCenterProps`. */
  revealAuto?: boolean
  onRequestReveal: () => void
  isRevealBusy: boolean
  claims: ClaimItem[]
  error?: string | null
  attackIntercepted: boolean | null
  ownHit: boolean
  onSignIn?: (() => void) | null
  isSignInBusy?: boolean
}

type PlayAction = {
  label: string
  kind: CtaKind
  disabled: boolean
  busy: boolean
  onClick: () => void
}

export function CommandRail(props: CommandRailProps) {
  const node = <RailSurface {...props} />
  if (typeof document === 'undefined') return node
  return createPortal(node, document.body)
}

function RailSurface({
  lobbyPhase,
  potEth,
  probesAvailable,
  probesMax,
  stagedPoint,
  submittedPoint,
  onSendRecon,
  reconBlockedReason,
  isReconSending,
  onSendDefense,
  defenseBlockedReason,
  isDefenseBusy,
  isDefenseArming,
  canRequestReveal,
  revealAuto = false,
  onRequestReveal,
  isRevealBusy,
  claims,
  error = null,
  attackIntercepted,
  ownHit,
  onSignIn = null,
  isSignInBusy = false,
}: CommandRailProps) {
  const dockRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLDivElement>(null)
  const [pulse, setPulse] = useState(0)
  const [hover, setHover] = useState(false)
  /*
    The rail is the bottom of the planet, not a bar laid over it: it spans
    the globe where the globe crosses the fold and its ends follow the limb.
    Null when Earth is too small to hold the row — then the capsule ТЗ §1
    describes is what gets drawn, at the width the viewport can give.
  */
  const earth = useEarthSilhouette(dockRef, railRef)

  const hasEnded = lobbyPhase === 'RESULT' || lobbyPhase === 'CANCELLED'
  const cooldown = reconCooldownLabel(reconBlockedReason)
  const reconDisabled = reconBlockedReason !== null || isReconSending
  const defenseDisabled = defenseBlockedReason !== null || isDefenseBusy
  const payout = claims.find((claim) => claim.key === 'reward' && claim.amount > 0) ?? null
  const refund = claims.find((claim) => claim.key === 'refund' && claim.amount > 0) ?? null
  const money = payout ?? refund
  const showResult = hasEnded && !canRequestReveal

  const waitReason =
    [reconBlockedReason, defenseBlockedReason].find((reason) => reason != null && /block/i.test(reason)) ?? null
  const alert = railAlert(error ?? money?.error ?? null)

  const action = playAction({
    submittedPoint,
    stagedPoint,
    defenseDisabled,
    onSendDefense,
    isDefenseBusy,
    isDefenseArming,
  })

  const pulseKey = `${Boolean(stagedPoint)}:${isDefenseBusy}:${isReconSending}:${isRevealBusy}:${revealAuto}:${Boolean(money?.busy)}`
  const lastPulse = useRef(pulseKey)
  useEffect(() => {
    if (lastPulse.current === pulseKey) return
    lastPulse.current = pulseKey
    setPulse((n) => n + 1)
  }, [pulseKey])

  const banner =
    !alert && waitReason && !showResult && !canRequestReveal ? (
      <p className="visually-hidden" id="command-wait">
        {waitReason}
      </p>
    ) : null

  const state = canRequestReveal ? 'reveal' : showResult ? 'result' : 'play'
  const verdict = verdictAction({ ownHit, attackIntercepted, cancelled: lobbyPhase === 'CANCELLED' })

  return (
    <section
      ref={dockRef}
      className={styles.dock}
      aria-label="Command Center"
      data-hud="orbit"
      data-state={state}
      data-hover={hover ? 'true' : 'false'}
      data-alert={alert ? 'true' : 'false'}
      data-shape={earth ? 'earth' : 'capsule'}
    >
      <div
        ref={railRef}
        className={styles.rail}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        style={
          earth
            ? {
                left: `${earth.left}px`,
                width: `${earth.width}px`,
                clipPath: `path('${earth.path}')`,
                ['--rail-arc' as string]: `${Math.round(earth.inset)}px`,
              }
            : undefined
        }
      >
        <RailAtmosphere />
        <RailTrace hostRef={railRef} pulse={pulse} outline={earth?.path ?? null} />
        {/*
          The failure, on the panel rather than floating above it.

          It used to sit outside the capsule, which made it a line of red
          text on the planet with no housing and no relationship to the
          control that produced it. It belongs here: centred, layered over
          the row, and inert — ТЗ §7 forbids the chassis growing for a
          message, so it overlays instead of pushing, and `pointer-events`
          stay with the buttons underneath so the action it is complaining
          about is still pressable.
        */}
        <RailAlert message={alert} />
        {banner}
        <div className={styles.body}>
          <AnimatePresence initial={false} mode="wait">
            {canRequestReveal ? (
              <div key="reveal" className={styles.data}>
                <RailPot value={potEth} labelled={formatClaimEth(potEth)} />
                <span className={styles.spacer} />
              </div>
            ) : showResult ? (
              <div key="result" className={styles.data}>
                {/*
                  No verdict line in front of the figure.

                  "Round over", "You missed", "Rocket escaped" were the
                  round's status printed a second time: the countdown banner
                  in the middle of the scene is already the screen's
                  headline and already says exactly that. The rail's job
                  here is the two things the banner does not carry — what
                  the wallet is owed, and the control that takes it — so the
                  sum stays where it always was, on the left.
                */}
                {/*
                  Once there is something to take, the window stops showing
                  the pool and starts showing the payout: the figure is the
                  one the button will actually claim, and the label says
                  what it is owed for. The long version — the split between
                  prize and creator fee, or why a cancelled round is coming
                  back — is the claim's own sentence, and it lives on hover
                  rather than in a rail 60 pixels tall.
                */}
                <RailPot
                  value={money?.amount ?? potEth}
                  labelled={formatClaimEth(money?.amount ?? potEth)}
                  caption={money ? claimCaption(money) : 'Pool'}
                  hint={money?.note}
                />
                <span className={styles.spacer} />
              </div>
            ) : (
              <div key="play" className={styles.data}>
                <RailPot value={potEth} labelled={formatClaimEth(potEth)} />
                {/*
                  ТЗ §7 — the slack the row grows into. RECON opens to the
                  right on hover (§4.2) by eating this, so it and INTERCEPT
                  keep the slots they were given.
                */}
                <span className={styles.spacer} />
                {onSignIn ? null : (
                  <RailRecon
                    remaining={probesAvailable}
                    max={probesMax}
                    disabled={reconDisabled}
                    scanning={isReconSending}
                    cooldown={cooldown}
                    title={cooldown ? undefined : reconTitle(reconDisabled, reconBlockedReason)}
                    describedBy={reconDisabled && waitReason ? 'command-wait' : undefined}
                    busy={isReconSending}
                    onClick={onSendRecon}
                    invite={action.kind !== 'ready'}
                  />
                )}
              </div>
            )}
          </AnimatePresence>

          <AnimatePresence initial={false}>
            {canRequestReveal ? (
              <RailCta
                key="cta"
                kind="reveal"
                label={revealLabel(revealAuto, isRevealBusy)}
                disabled={isRevealBusy || revealAuto}
                busy={isRevealBusy || revealAuto}
                onClick={onRequestReveal}
                /*
                  Said out loud, because the state the slot is in is the
                  answer to "why can I not press this". A disabled control
                  with a changed word on it is not an explanation for anyone
                  reading with a screen reader.
                */
                title={revealAuto ? 'The keeper is revealing this round — no signature needed.' : undefined}
              />
            ) : showResult && money ? (
              <ClaimButton key="cta" claim={money} />
            ) : onSignIn ? (
              <RailCta
                key="cta"
                kind="ready"
                label={isSignInBusy ? 'Signing in' : 'Sign in'}
                disabled={isSignInBusy}
                busy={isSignInBusy}
                onClick={onSignIn}
              />
            ) : showResult ? (
              /*
                ТЗ §4.4 — the last two states of the primary control. The
                round is over and there is nothing to take, so the slot the
                verb lived in reports the verdict instead of emptying: the
                rail's rightmost element is the answer to the thing the
                player pressed, first to last.
              */
              verdict ? (
                <RailCta
                  key="cta"
                  kind={verdict.kind}
                  label={verdict.label}
                  disabled
                  busy={false}
                  onClick={() => undefined}
                />
              ) : null
            ) : (
              <RailCta
                key="cta"
                kind={action.kind}
                label={action.label}
                disabled={action.disabled}
                busy={action.busy}
                onClick={action.onClick}
                title={actionTitle(action.disabled, defenseBlockedReason)}
                describedBy={action.disabled && waitReason ? 'command-wait' : undefined}
              />
            )}
          </AnimatePresence>
        </div>
      </div>
    </section>
  )
}

function railAlert(message: string | null): string | null {
  if (!message) return null
  const text = message.trim()
  if (!text) return null
  if (/^not found$/i.test(text)) return null
  if (/cannot (get|post|put|patch|delete)\b/i.test(text)) return null
  if (/\b404\b/.test(text)) return null
  return text
}

function actionTitle(disabled: boolean, reason: string | null): string | undefined {
  if (!disabled || !reason) return undefined
  if (/launches/i.test(reason)) return undefined
  return reason
}

function reconTitle(disabled: boolean, reason: string | null): string | undefined {
  if (!disabled || !reason) return undefined
  return reason
}

function reconCooldownLabel(reason: string | null): string | null {
  if (!reason) return null
  const match = reason.match(/next probe in (\d+)/i)
  if (!match) return null
  const n = Number(match[1])
  return `Next recon · ${n} ${n === 1 ? 'block' : 'blocks'}`
}

function playAction(input: {
  submittedPoint: DefensePoint | null
  stagedPoint: DefensePoint | null
  defenseDisabled: boolean
  onSendDefense: () => void
  isDefenseBusy: boolean
  isDefenseArming: boolean
}): PlayAction {
  if (input.submittedPoint) {
    return {
      label: 'Shot fired',
      kind: 'fired',
      disabled: true,
      busy: false,
      onClick: () => undefined,
    }
  }
  if (input.stagedPoint) {
    if (input.isDefenseBusy) {
      return {
        label: 'Firing',
        kind: 'firing',
        disabled: true,
        busy: true,
        onClick: input.onSendDefense,
      }
    }
    /*
     * Sealing, which used to be the target readout's job and is now this
     * button's.
     *
     * The point is being encrypted against the confidential network, which
     * takes five to nine seconds and starts on its own. The control stays
     * live throughout — pressing during it is allowed and simply waits for
     * the same work — but it wears the wait, because a button that has
     * silently changed nothing for eight seconds is the one state that
     * looks like a dead control.
     */
    if (input.isDefenseArming) {
      return {
        label: 'Sealing',
        kind: 'ready',
        disabled: input.defenseDisabled,
        busy: true,
        onClick: input.onSendDefense,
      }
    }
    return {
      label: 'Intercept',
      kind: 'ready',
      disabled: input.defenseDisabled,
      busy: false,
      onClick: input.onSendDefense,
    }
  }
  return {
    label: 'Set intercept',
    kind: 'idle',
    disabled: true,
    busy: false,
    onClick: () => undefined,
  }
}

/**
 * ТЗ §4.4 — the verdict, in the primary control's slot, on a finished round
 * that owes this wallet nothing.
 *
 * Two rounds get no verdict at all. A cancelled operation: nobody lost it,
 * it did not happen, and printing ROUND LOST there would fire the panel's
 * one red state at a player whose entry is simply coming back. And a round
 * whose outcome has not reached this client yet — `attackIntercepted` still
 * null — because "lost" would then be a guess, and the slot saying nothing
 * is the honest version of not knowing.
 */
function verdictAction(input: {
  ownHit: boolean
  attackIntercepted: boolean | null
  cancelled: boolean
}): { kind: CtaKind; label: string } | null {
  if (input.ownHit) return { kind: 'won', label: 'Intercepted' }
  if (input.cancelled) return null
  if (input.attackIntercepted === null) return null
  return { kind: 'lost', label: 'Round lost' }
}

/**
 * What the figure is owed for, in words that cannot be read as a charge.
 *
 * Not the settlement path — that is `key`, and labelling from it is the
 * first bug this replaced: a creator whose operation ran but who never
 * intercepted anything is paid through the `reward` path and owed the
 * Creator Fee alone, so the rail printed REWARD over a round the wallet
 * had just lost.
 *
 * The wording matters as much as the itemisation, which is the second bug.
 * In every other context in this product a *fee* is money leaving a wallet
 * — the entry, the creation fee the protocol keeps — so a bare FEE over a
 * Claim button reads as a deduction rather than as the cut of the entry
 * fees a creator is paid for filling the operation. Every label below names
 * the money and which way it is moving; the full sentence — the split, the
 * percentage, why a cancelled round pays out at all — is on hover.
 *
 * Keyed on the combination rather than joined mechanically, because
 * "Pool reward + Entry fee reward" is not something anybody should have to
 * read off an eight-pixel label.
 */
const CLAIM_CAPTIONS: Record<string, string> = {
  prize: 'Pool reward',
  fee: 'Entry fee reward',
  'prize+fee': 'Pool + fee reward',
  entry: 'Entry refund',
  pool: 'Pool refund',
  'entry+pool': 'Entry + pool refund',
}

function claimCaption(claim: ClaimItem): string {
  const named = CLAIM_CAPTIONS[claim.parts.join('+')]
  if (named) return named
  // Nothing itemised: fall back to the path, which is still true if vague.
  return claim.key === 'refund' ? 'Refund' : 'Reward'
}

function ClaimButton({ claim }: { claim: ClaimItem }) {
  const [pressed, setPressed] = useState(false)
  const parentTookOver = useRef(false)

  useEffect(() => {
    if (claim.claimed) {
      parentTookOver.current = false
      setPressed(false)
      return
    }
    if (claim.busy) {
      parentTookOver.current = true
      return
    }
    if (parentTookOver.current || claim.error) {
      parentTookOver.current = false
      setPressed(false)
    }
  }, [claim.busy, claim.claimed, claim.error])

  const ready = !claim.claimed && !claim.busy && !pressed
  const inFlight = !claim.claimed && !ready

  return (
    <RailCta
      kind={claim.claimed ? 'claimed' : 'claim'}
      label={claim.claimed ? 'Claimed' : inFlight && claim.busy ? 'Claiming' : 'Claim'}
      disabled={!ready}
      busy={inFlight}
      onClick={() => {
        if (!ready) return
        setPressed(true)
        claim.onClaim()
      }}
    />
  )
}
