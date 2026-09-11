import { useSyncExternalStore } from 'react'
import { isPageVisible, subscribeToPageVisibility } from '../app/pageVisibility'

/**
 * One clock, for every countdown in the app.
 *
 * Two countdowns that each own a `setInterval` are two clocks: their ticks
 * are out of phase by whatever the gap between their mounts happened to be,
 * so at any moment one of them may have crossed a second boundary the other
 * has not. The header's epoch readout and the operation's countdown are
 * counting to the same block, and the only way they can be *seen* to agree
 * is if they re-render together, off the same sample of `Date.now()`.
 *
 * So the sample lives here, module-level, and every countdown subscribes to
 * it. There is exactly one interval no matter how many countdowns are on
 * screen, it exists only while something is watching, and every subscriber
 * renders the same `now`.
 */
const TICK_MS = 250

let sampledNow = Date.now()
/**
 * What subscribers actually watch. The timestamp itself is unusable as the
 * snapshot: two pulses can land on the same millisecond — a re-anchor
 * arriving in the same tick that produced the current sample is the common
 * case, not a corner one — and an unchanged snapshot means React skips the
 * render, leaving a countdown showing the previous block's number.
 */
let version = 0
const subscribers = new Set<() => void>()
let ticker: ReturnType<typeof setInterval> | null = null
let releaseVisibility: (() => void) | null = null

function startTicker(): void {
  if (ticker === null && isPageVisible()) ticker = setInterval(pulse, TICK_MS)
}

function stopTicker(): void {
  if (ticker === null) return
  clearInterval(ticker)
  ticker = null
}

/**
 * The clock does not run while the window is behind another one.
 *
 * Four ticks a second is four re-renders a second of every countdown on the
 * screen — the header epoch readout, the operation timer, the lobby rows —
 * and unlike the CSS animations there is no `animation-play-state` that
 * reaches React. A hidden page was paying for all of it, which is most of
 * what a second browser left open actually costs.
 *
 * Sampling *before* restarting the interval is the whole correctness
 * argument. The countdown is derived from the chain's own timestamp rather
 * than accumulated locally (see `useSmoothCountdown`), so a gap in the
 * ticks loses nothing — but the first frame after the window comes back
 * would otherwise be drawn from whatever `Date.now()` was when it went
 * away. One pulse first, and the return paint is already correct.
 */
function onVisibilityChange(visible: boolean): void {
  if (!visible) {
    stopTicker()
    return
  }
  if (subscribers.size === 0) return
  pulse()
  startTicker()
}

function subscribe(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange)
  if (releaseVisibility === null) releaseVisibility = subscribeToPageVisibility(onVisibilityChange)
  startTicker()
  return () => {
    subscribers.delete(onStoreChange)
    if (subscribers.size === 0) {
      stopTicker()
      releaseVisibility?.()
      releaseVisibility = null
    }
  }
}

function pulse(): void {
  sampledNow = Date.now()
  version += 1
  subscribers.forEach((notify) => notify())
}

function getSnapshot(): number {
  return version
}

/** Test-only: the sample is module state and ignores `vi.setSystemTime` until a tick. */
export function __syncCountdownClockForTests(): void {
  sampledNow = Date.now()
  version += 1
}

/**
 * The shared sample of `Date.now()`, advancing four times a second.
 *
 * The subscription carries the version and the render reads the sample —
 * which is what makes every countdown on the screen render the *same*
 * instant rather than each calling `Date.now()` at its own moment in the
 * commit.
 */
export function useCountdownClock(): number {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return sampledNow
}

/**
 * A countdown that reads from the block clock but *moves* like a clock —
 * and the single primitive every countdown in the app is built from.
 *
 * Blocks are the truth. The **origin** of the remaining time is the chain's
 * `block.timestamp` for the current head, not the wall-clock instant this
 * tab happened to learn the block number. Two windows that see the same
 * head therefore compute the same due-at, even if one RPC answered five
 * seconds later than the other — which is exactly the "142 blocks, but
 * 00:04:48 vs 00:04:53" failure.
 *
 * `dueAt = chainTimestamp + blocksRemaining * blockTimeMs`. Between heads
 * this subtracts the shared clock from that. The next head brings a new
 * timestamp and a new remainder; the display does not accumulate.
 *
 * `chainTimestampMs` is required for two clients to agree. Without it the
 * remaining time is `blocksRemaining * blockTimeMs` with no intra-block
 * motion — honest about not knowing when the current block started, rather
 * than pretending the poll's arrival was the mine.
 */
export function useSmoothCountdown(
  blocksRemaining: number | null,
  blockTimeMs: number,
  chainTimestampMs: number | null = null,
): number | null {
  const now = useCountdownClock()
  if (blocksRemaining === null || blockTimeMs <= 0) return null
  const origin = chainTimestampMs ?? now
  return Math.max(0, origin + Math.max(0, blocksRemaining) * blockTimeMs - now)
}
