import { motion } from 'motion/react'
import { lobbyPhaseLabel, type LobbyPhase } from '../../game/lobbyPhase'
import styles from './LobbyStatusPanel.module.css'

/**
 * The four stops an operation that runs to the end passes through, in order.
 *
 * They are stops on a track rather than the seven phases themselves, and the
 * difference is deliberate: `ATTACK_INCOMING` and `WAITING_FOR_ATTACK` are
 * the same *place* in the operation's life — applications are closed and the
 * attack has not launched — and printing them as two stops would mean the
 * marker moved for something that did not happen yet. Incoming instead
 * lights the stop it is standing on, which is what "imminent" looks like.
 *
 * The terminals that leave the track — CANCELLED, UNDERSUBSCRIBED — have no
 * stop here at all: an operation that never ran did not reach `RESULT`, and
 * a strip that showed it three quarters of the way along would be a picture
 * of a round that happened.
 */
const STOPS = ['OPEN', 'CLOSED', 'IN FLIGHT', 'RESULT'] as const

/** Where each phase stands on the track, or `null` for the ones that left it. */
function stopOf(phase: LobbyPhase): number | null {
  switch (phase) {
    case 'OPEN':
      return 0
    case 'WAITING_FOR_ATTACK':
    case 'ATTACK_INCOMING':
      return 1
    case 'ATTACK_ACTIVE':
      return 2
    case 'RESULT':
      return 3
    default:
      return null
  }
}

/**
 * Where the operation stands, as a position rather than as a word.
 *
 * The status is the most-changing reading on this screen and it used to be a
 * string that was simply replaced: OPEN, then one render later WAITING FOR
 * ATTACK, with nothing to say the second follows the first. A track says
 * both things at once — which state, and how far through the operation that
 * state is — and it is the one reading here that has a *direction*, so it is
 * the one that earns a moving part.
 *
 * The marker is a single element that Motion moves between stops
 * (`layoutId`), not four elements taking turns being lit. That is the whole
 * mechanism: the browser is told these are the same object in two places, so
 * what the eye follows is the operation advancing rather than one light
 * going out and another coming on.
 *
 * The strip is decorative to assistive tech and the phase's own name is read
 * instead, out of a live region — a screen reader gets "ATTACK ACTIVE" when
 * it happens, which is more than the tile it replaced ever announced.
 */
export function PhaseStrip({ phase }: { phase: LobbyPhase }) {
  const at = stopOf(phase)
  const imminent = phase === 'ATTACK_INCOMING'

  return (
    <span className={styles.phase}>
      <span className="visually-hidden" role="status">
        {lobbyPhaseLabel(phase)}
      </span>
      <span className={styles.track} aria-hidden="true">
        {STOPS.map((stop, index) => (
          <span
            key={stop}
            className={[
              styles.stop,
              at !== null && index < at ? styles.stopDone : '',
              index === at ? styles.stopOn : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {index === at ? (
              <motion.span
                layoutId="lobby-phase-marker"
                className={`${styles.marker} ${imminent ? styles.markerImminent : ''}`}
                transition={{ type: 'spring', stiffness: 320, damping: 30 }}
              />
            ) : null}
            <span className={styles.stopLabel}>{stop}</span>
          </span>
        ))}
      </span>
    </span>
  )
}
