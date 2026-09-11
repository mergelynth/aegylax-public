import {
  APOCALYPSE_BASE_TIMESTAMP,
  APOCALYPSE_DAYS_PER_INTERCEPT,
  APOCALYPSE_DAYS_PER_MISS,
} from '../config/gameConfig'

const ONE_DAY_MS = 24 * 60 * 60 * 1000

/**
 * Protocol rule for the global Apocalypse Timer — Day X (spec §16-17): a pure
 * function of the same canonical `GameStats.interceptedAttacks` /
 * `GameStats.missedAttacks` every client already reads via `getGameStats`.
 * No separate blockchain-client surface or client-side divergence — every
 * open tab computes the same timestamp, and the formula keeps working
 * unmodified once `getGameStats` is backed by a real contract.
 *
 *     DayX = base − (MISS × 0.01d) + (INTERCEPT × 0.10d)
 *
 * The two rates are deliberately unequal. Under the symmetric rule this
 * replaces — one constant, applied forward on an interception and backward on
 * a miss — only the *net* of the two ever moved the date, so an epoch that
 * closed with one of each was a wash and a protocol running at an even hit
 * rate showed a horizon that never moved at all. Weighting them 10:1 makes
 * both halves of the game legible instead: the planet loses a little ground
 * on every attack that lands, and one interception is worth ten of them, so a
 * good run visibly buys time back.
 *
 * Kept as a single expression over the two totals rather than accumulated per
 * attack, because that is what lets a client that has just opened the page
 * arrive at the same date as one that has watched every epoch.
 */
export function computeApocalypseTimestamp(interceptedAttacks: number, missedAttacks: number): number {
  const shiftDays = interceptedAttacks * APOCALYPSE_DAYS_PER_INTERCEPT - missedAttacks * APOCALYPSE_DAYS_PER_MISS
  return APOCALYPSE_BASE_TIMESTAMP + shiftDays * ONE_DAY_MS
}
