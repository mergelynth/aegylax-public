import type { LobbyPhase } from '../../game/lobbyPhase'
import { useSmoothCountdown } from '../../hooks/useSmoothCountdown'
import { formatLongCountdown } from '../../utils/format'
import styles from './AttackCountdown.module.css'

export interface AttackCountdownProps {
  phase: LobbyPhase
  /**
   * Blocks until whatever the phase is counting towards — the launch while
   * an attack is pending, the impact while one is in flight. Null when the
   * block feed has not arrived yet.
   */
  blocksRemaining: number | null
  blockTimeMs: number
  /**
   * The current head's `block.timestamp` (unix ms). The countdown is due
   * at this plus `blocksRemaining * blockTimeMs`, so two windows that see
   * the same head print the same clock. Null until the block feed has it.
   */
  chainTimestampMs?: number | null
  /**
   * How many blocks the current wait is, in total — what the progress bar
   * measures `blocksRemaining` against. One epoch, for both the wait before
   * the launch and the flight itself, since an attack launches on one epoch
   * boundary and lands on the next. Null suppresses the bar.
   */
  totalBlocks: number | null
  /** The operation's verdict once it has one — null until then. */
  intercepted: boolean | null
  /**
   * This player's own verdict, which is not always the operation's (ТЗ §16).
   * `true` — they won. `false` — they missed or were outranked. Null until
   * scored. Outranked is named separately via `ownAlreadyDown`.
   */
  ownDefenseSucceeded: boolean | null
  /**
   * A hit that lost the race. Distinct from a miss: the aim was right, and
   * somebody else's interceptor arrived first — `Resolution.recrown` crowns
   * the earliest arrival, which on a descending threat is also the highest.
   */
  ownAlreadyDown?: boolean
  /**
   * Whether the chain has answered `getAttackReveal` for this attack.
   *
   * `intercepted === null` is otherwise ambiguous: it is both "still sealed"
   * and "we have not asked yet". On a reload of an already-scored round the
   * second is briefly true, and announcing RESULT SEALED there is a lie.
   */
  revealLoaded?: boolean
  /**
   * Whether the backend keeper is carrying the reveal right now.
   *
   * A sealed result has two different things to say depending on this, and
   * telling a player to press Reveal while the console beside this banner
   * shows a disabled `Decoding` is the screen contradicting itself. See
   * `REVEAL_PATIENCE_MS`, which is also what eventually turns this false.
   */
  revealAuto?: boolean
}

/**
 * The countdown (ТЗ §1, §2.1).
 *
 * It stands where the hero block used to, at the top of the scene: once an
 * operation is running, when the attack lands is the only headline it has.
 *
 * ТЗ §2 makes it deliberately faint and housing-less — bare type over the
 * scene rather than a card on it — because the grid and the threat above it
 * outrank it, and it must never come between a player and a sector they are
 * about to click. It takes no pointer events in any phase, and steps back
 * further still while the attack is in flight, which is the one window in
 * which the whole board underneath is live. The Command Center repeats the
 * same countdown at bubble scale (ТЗ §3.3), so the number is never actually
 * out of reach.
 *
 * Blocks are the truth and the clock is the presentation: the value shown
 * is `blocksRemaining` converted through the chain's block time, smoothed
 * between blocks by `useSmoothCountdown` so the digits move continuously
 * instead of jumping a block at a time. The block figure is printed
 * underneath for exactly that reason.
 */
export function AttackCountdown({
  phase,
  blocksRemaining,
  blockTimeMs,
  totalBlocks,
  intercepted,
  ownDefenseSucceeded,
  ownAlreadyDown = false,
  revealLoaded = true,
  revealAuto = false,
  chainTimestampMs = null,
}: AttackCountdownProps) {
  const remaining = useSmoothCountdown(blocksRemaining, blockTimeMs, chainTimestampMs)
  const { label, value, detail, tone } = describe(
    phase,
    remaining,
    blocksRemaining,
    intercepted,
    ownDefenseSucceeded,
    ownAlreadyDown,
    revealLoaded,
    revealAuto,
  )
  const progress = progressOf(phase, blocksRemaining, totalBlocks)

  return (
    <div
      className={[styles.countdown, styles[tone], phase === 'ATTACK_ACTIVE' ? styles.recessed : '']
        .filter(Boolean)
        .join(' ')}
    >
      <span className={styles.label}>{label}</span>
      <strong className={styles.value}>{value}</strong>
      {/*
        The same countdown as a filled bar.

        It earns its place by being made of a different material than the
        digits: the bar is a ratio of *blocks*, which is the thing the
        protocol actually decides, while the digits are those blocks
        translated into seconds through a rate that can only ever be an
        estimate. So when a run of slow blocks makes the seconds correct
        themselves, the bar does not — it simply advances one notch per
        block, and stays the honest answer to "how much of the flight is
        left".
      */}
      {progress !== null ? (
        <span
          className={styles.progress}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress * 100)}
          aria-label={label}
        >
          <span className={styles.progressFill} style={{ transform: `scaleX(${progress})` }} />
        </span>
      ) : null}
      {detail ? <span className={styles.detail}>{detail}</span> : null}
    </div>
  )
}

/**
 * How much of the current wait has elapsed, 0..1 — or null when there is
 * nothing to fill.
 *
 * Only the two phases that are genuinely *counting* get a bar. A finished or
 * cancelled operation is not partway through anything, and a bar frozen at
 * 100% under the word CANCELLED would read as a stalled process.
 */
function progressOf(phase: LobbyPhase, blocksRemaining: number | null, totalBlocks: number | null): number | null {
  if (phase !== 'WAITING_FOR_ATTACK' && phase !== 'ATTACK_INCOMING' && phase !== 'ATTACK_ACTIVE') return null
  if (blocksRemaining === null || totalBlocks === null || totalBlocks <= 0) return null

  const elapsed = totalBlocks - Math.max(0, blocksRemaining)
  return Math.min(1, Math.max(0, elapsed / totalBlocks))
}

type Tone = 'waiting' | 'incoming' | 'active' | 'won' | 'lost' | 'ended' | 'outranked'

function describe(
  phase: LobbyPhase,
  remainingMs: number | null,
  blocksRemaining: number | null,
  intercepted: boolean | null,
  ownDefenseSucceeded: boolean | null,
  ownAlreadyDown: boolean,
  revealLoaded: boolean,
  revealAuto: boolean,
): { label: string; value: string; detail: string | null; tone: Tone } {
  const clock = remainingMs === null ? '--:--:--' : formatLongCountdown(remainingMs)
  const blocks = blocksRemaining === null ? null : `${Math.max(0, blocksRemaining)} blocks`

  switch (phase) {
    case 'OPEN':
      // The countdown only exists once an operation is under way, so this
      // branch is unreachable in practice — it stays as the honest answer
      // rather than a crash if the phase ever arrives here.
      return { label: 'Standing by', value: '--:--:--', detail: null, tone: 'waiting' }
    case 'WAITING_FOR_ATTACK':
      return { label: 'Attack in', value: clock, detail: blocks, tone: 'waiting' }
    case 'ATTACK_INCOMING':
      return { label: 'Attack incoming', value: clock, detail: blocks, tone: 'incoming' }
    case 'ATTACK_ACTIVE':
      return { label: 'Attack active — impact in', value: clock, detail: blocks, tone: 'active' }
    case 'RESULT':
      // ТЗ §16 — the verdict takes the countdown's slot, which is the most
      // prominent readout on the screen. It is the last thing the operation
      // has to say, so it says it where the clock was.
      //
      // Two verdicts, in the two lines §16 asks for: what happened to the
      // planet, and what that means for this player. They are not always
      // the same sentence — an operation can be intercepted by somebody
      // else's Defense Point, in which case the threat was stopped and
      // this defender still failed.
      //
      // And `null` is a third state, not a quiet "no": until somebody
      // reveals, *nobody knows* — the geometry is still sealed and no
      // defense has been scored. Folding null into "TARGET REACHED"
      // announced a defeat the protocol had not decided, on every operation
      // in the window between impact and reveal, which is precisely the
      // window the Reveal control exists for.
      //
      // The chain not having answered yet is a fourth state. On a reload of
      // a scored round that window is a few seconds of "we have not asked",
      // and RESULT SEALED in it is a false invitation to reveal.
      if (intercepted === null) {
        if (!revealLoaded) {
          return { label: 'Impact', value: 'READING RESULT', detail: null, tone: 'ended' }
        }
        return {
          label: 'Impact',
          value: 'RESULT SEALED',
          // Two sentences for one state, and which one is true is not this
          // banner's to guess.
          //
          // While the keeper carries the reveal there is nothing for the
          // player to do, and this line said "Reveal to score this
          // operation" straight at a console showing a disabled `Decoding`
          // — the screen instructing an action it was simultaneously
          // refusing. Only once the keeper has had its turn is asking the
          // honest thing to do.
          //
          // Both are deliberately about *scoring* rather than about the
          // trajectory. The flight path may well already be on the board —
          // publishing it is one transaction for the whole epoch and another
          // team may have sent it — while this operation's own defenders
          // have not been ranked yet. See `AttackRevealData.scored`.
          detail: revealAuto ? 'Decoding the sealed trajectory' : 'Reveal to score this operation',
          tone: 'ended',
        }
      }
      return intercepted
        ? ownAlreadyDown
          ? {
              label: 'Operation complete',
              value: 'TARGET INTERCEPTED',
              /*
               * "A higher kill took the round" was true and unreadable.
               *
               * `Resolution.recrown` crowns the *earliest arrival*, and
               * because the threat is descending, earliest is highest — so
               * the altitude framing was accurate, and it asked a
               * first-time player to derive that equivalence before the
               * sentence meant anything. This states the rule the contract
               * actually applies.
               */
              detail: 'ALREADY DOWN — another defender intercepted it earlier',
              tone: 'outranked',
            }
          : {
              /*
               * Three states, not two. `null` means this viewer has no
               * defense in this operation — a passer-by, or a defender who
               * never submitted — and folding that into the `true` branch
               * congratulated strangers on a DEFENSE SUCCESS they had no
               * part in. They get the operation's verdict and no personal
               * line, which is all there is to tell them.
               */
              label: 'Operation complete',
              value: 'TARGET INTERCEPTED',
              detail:
                ownDefenseSucceeded === null ? null : ownDefenseSucceeded ? 'DEFENSE SUCCESS' : 'DEFENSE FAILED',
              tone: ownDefenseSucceeded === false ? 'lost' : 'won',
            }
        : {
            /*
             * The impact branch had no personal verdict at all, where the
             * interception branch has one — so the player who just lost
             * read "TARGET REACHED" (an achievement, to anyone not thinking
             * in terms of whose target it was) followed by a note about
             * where the money went. The loss is now said out loud, and only
             * to defenders who actually submitted.
             */
            label: 'Operation complete',
            value: 'TARGET REACHED',
            detail:
              ownDefenseSucceeded === false
                ? 'DEFENSE FAILED — prize → Global Defense jackpot'
                : 'Prize → Global Defense jackpot',
            tone: 'lost',
          }
    case 'UNDERSUBSCRIBED':
      // Same ending as CANCELLED, one transaction earlier: the deadline has
      // passed without the minimum, so the operation will never run — the
      // cancellation that says so on chain simply has not been sent yet.
      // Like OPEN, unreachable in practice, since the countdown only renders
      // once an operation is under way.
      return { label: 'Operation', value: 'NOT ENOUGH DEFENDERS', detail: 'Refunds unlock on cancellation', tone: 'ended' }
    case 'CANCELLED':
      return { label: 'Operation', value: 'CANCELLED', detail: 'Minimum defenders not met', tone: 'ended' }
  }
}
