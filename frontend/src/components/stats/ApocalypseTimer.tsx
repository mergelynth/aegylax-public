import { useEffect, useRef, useState } from 'react'
import { computeApocalypseTimestamp } from '../../game/apocalypse'
import { useGlobalStats } from '../../hooks/useGlobalStats'
import { useCountdownClock } from '../../hooks/useSmoothCountdown'
import { formatApocalypseCountdown } from '../../utils/format'
import styles from './ApocalypseTimer.module.css'

/** How long the glow runs for. Matches the HUD metrics' own alert window. */
const GLOW_MS = 900

/**
 * Countdown to the protocol's apocalypse date (spec §15-19), framed to the
 * player as Event X — an event that is coming, certain, and otherwise
 * unknown. The target timestamp is derived from
 * `GameStats.interceptedAttacks` and `GameStats.missedAttacks` — the same
 * push-driven stats `GlobalStatsHud` renders — so it's canonical across
 * every open client without any dedicated event/read.
 *
 * ТЗ §7 — **this readout reacts to an attack too, and it is the only one that
 * says what the attack cost.** The icon row above counts events; this counts
 * the consequence. So when an epoch closes and the totals move, Day X moves
 * with them, live, and the readout glows to say so.
 *
 * The reaction is deliberately *not* the row's reaction. The HUD metrics take
 * a diagonal shake, because a counter ticking over is an event landing. Day X
 * is not an event, it is a date being rewritten, and a date that jitters reads
 * as unstable rather than as important — so this glows in its own amber and
 * holds still. Each of the three segments lights in the colour it already
 * has, which is what keeps it one object reacting rather than a badge
 * flashing on top of a timer.
 *
 * Sits over Earth at the bottom of the Home hero — the protocol's
 * countdown, not an operation's. An open lobby leaves that slot empty until
 * join has closed and the command rail takes it.
 */
export function ApocalypseTimer() {
  const stats = useGlobalStats()
  const [pinned, setPinned] = useState(false)
  /*
   * The app's one clock, rather than a `setInterval` of this component's own.
   * The interval it replaces was a second timer sampling `Date.now()` at an
   * unrelated moment from every other countdown on the screen — the same
   * split that used to let two readouts of the same instant disagree. See
   * `useSmoothCountdown`.
   */
  const now = useCountdownClock()

  const intercepted = stats?.interceptedAttacks ?? 0
  const missed = stats?.missedAttacks ?? 0
  const targetTimestamp = computeApocalypseTimestamp(intercepted, missed)
  const { years, days, time } = formatApocalypseCountdown(targetTimestamp - now)

  /*
   * The glow fires on the *date* moving, not on the clock ticking.
   *
   * `targetTimestamp` is the whole of the state: it is a pure function of the
   * two totals, so it changes exactly when an attack resolves and never in
   * between, however often this re-renders. Watching it rather than the two
   * counters also means an epoch that closes with a hit and a miss at once
   * still announces itself once, with the net result already in the digits.
   */
  const previousTarget = useRef<number | null>(null)
  const [glowing, setGlowing] = useState(false)

  useEffect(() => {
    const before = previousTarget.current
    previousTarget.current = targetTimestamp
    // The first figure is the chain answering, not the horizon moving — there
    // was nothing there before for it to have moved from.
    if (before === null || before === targetTimestamp) return

    setGlowing(true)
    const timeout = setTimeout(() => setGlowing(false), GLOW_MS)
    return () => clearTimeout(timeout)
  }, [targetTimestamp])

  const glow = glowing ? ` ${styles.glowing}` : ''

  return (
    <span
      /* ТЗ §24 — last into the sequence and the smallest thing in it: it
         sits on the planet, so it has nothing to sit on until the planet is
         there, and a clock that arrives with a flourish is a clock nobody
         trusts. See `app/motion.css`. */
      className={`${styles.item} boot-clock${pinned ? ` ${styles.pinned}` : ''}`}
      tabIndex={0}
      aria-expanded={pinned}
      aria-label={`Event X in ${years} years, ${days} days, ${time}`}
      onClick={() => setPinned((open) => !open)}
      onBlur={() => setPinned(false)}
    >
      <span className={styles.years + glow}>{years}y</span>
      <span className={styles.days + glow}>{days}d</span>
      <span className={styles.time + glow}>{time}</span>
      <span className={styles.tooltip} role="tooltip">
        <span className={styles.tooltipLabel}>Event X</span>
        {/*
          What the clock is *for*, which nothing on this page said.

          It used to read "An event is coming. Its occurrence is certain.
          Everything else remains unknown." — the third object on the home
          screen making the same gesture, after the heading SOMETHING IS
          COMING and the line about an unknown threat. Said three times, the
          mystery stops reading as withheld information and starts reading
          as none.

          So the heading keeps the mystery and this keeps the mechanism: it
          is the one readout tied to the protocol's own totals, and the
          10:1 weighting in `computeApocalypseTimestamp` is the whole reason a
          good run visibly buys the planet time back. A player who knows
          that watches this number; a player who does not sees a decorative
          clock.
        */}
        <span className={styles.tooltipDescription}>
          The date is certain — when it falls is not. Every attack that lands moves it closer; every
          interception pushes it back ten times as far.
        </span>
      </span>
    </span>
  )
}
