import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isPageVisible, startVisibilityTracking, subscribeToPageVisibility } from '../../app/pageVisibility'
import { __syncCountdownClockForTests, useSmoothCountdown } from '../../hooks/useSmoothCountdown'

const BLOCK_TIME_MS = 2000
const CHAIN = 1_700_000_000_000

/**
 * jsdom has no window manager, so `visibilityState` is a plain getter that
 * always answers `'visible'`. Overriding it and dispatching the event by
 * hand is the whole of what a browser does here.
 */
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
  act(() => void document.dispatchEvent(new Event('visibilitychange')))
}

function setFocused(focused: boolean): void {
  Object.defineProperty(document, 'hasFocus', {
    configurable: true,
    writable: true,
    value: () => focused,
  })
  act(() => void window.dispatchEvent(new Event(focused ? 'focus' : 'blur')))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(CHAIN)
  Object.defineProperty(document, 'hasFocus', {
    configurable: true,
    writable: true,
    value: () => true,
  })
  startVisibilityTracking()
  setVisibility('visible')
  // The shared sample is module state and does not know about `setSystemTime`.
  __syncCountdownClockForTests()
})

afterEach(() => {
  setFocused(true)
  setVisibility('visible')
  vi.useRealTimers()
})

/*
 * ТЗ §7 — the page stops moving when nobody is looking at it.
 *
 * The case these are about is a background tab. A window that is still
 * on screen — unfocused, beside another app — keeps moving.
 */
describe('page visibility — the document-level switch', () => {
  it('marks the document hidden, and unmarks it on the way back', () => {
    expect(document.documentElement.hasAttribute('data-hidden')).toBe(false)

    setVisibility('hidden')
    expect(document.documentElement.hasAttribute('data-hidden')).toBe(true)
    expect(isPageVisible()).toBe(false)

    setVisibility('visible')
    expect(document.documentElement.hasAttribute('data-hidden')).toBe(false)
    expect(isPageVisible()).toBe(true)
  })

  it('stops notifying a subscriber that has released', () => {
    const seen: boolean[] = []
    const release = subscribeToPageVisibility((visible) => seen.push(visible))

    setVisibility('hidden')
    setVisibility('visible')
    release()
    setVisibility('hidden')

    expect(seen).toEqual([false, true])
  })

  it('treats an unfocused window as hidden even while the tab is visible', () => {
    expect(isPageVisible()).toBe(true)
    expect(document.documentElement.hasAttribute('data-hidden')).toBe(false)

    setFocused(false)
    expect(isPageVisible()).toBe(false)
    expect(document.documentElement.hasAttribute('data-hidden')).toBe(true)

    setFocused(true)
    expect(isPageVisible()).toBe(true)
    expect(document.documentElement.hasAttribute('data-hidden')).toBe(false)
  })

  /*
   * Read out of the stylesheet rather than restated here: jsdom loads no
   * CSS, so a test carrying its own copy of the rule would be checking the
   * copy. What is being pinned is that the attribute reaches *every*
   * animation — the selector is the reason the switch is one write rather
   * than a list of the expensive elements, which is a list to forget to add
   * to.
   */
  it('pauses every CSS animation rather than a chosen few', () => {
    const css = readFileSync(resolve(process.cwd(), 'frontend/src/app/motion.css'), 'utf8')
    const rule = /\[data-hidden\][^{]*{([^}]*)}/.exec(css)

    expect(rule).not.toBeNull()
    expect(rule![0]).toContain('[data-hidden] *')
    /*
     * `paused`, not `none`. An animation holds its position while paused, so
     * coming back is a resumption; `none` would restart every idle loop from
     * its first keyframe at once and bring the surface up in lockstep.
     */
    expect(rule![1]).toContain('animation-play-state: paused')
    expect(rule![1]).not.toContain('animation: none')
  })

  it('keeps Earth’s spin running while the rest of the page is parked', () => {
    const css = readFileSync(resolve(process.cwd(), 'frontend/src/app/motion.css'), 'utf8')
    expect(css).toMatch(/\[data-hidden\] \[data-earth-spin\][\s\S]*?animation-play-state:\s*running/)
  })
})

describe('page visibility — the clocks CSS cannot reach', () => {
  it('stops the countdown clock while hidden and resamples the moment it returns', () => {
    const { result } = renderHook(() => useSmoothCountdown(30, BLOCK_TIME_MS, CHAIN))
    expect(result.current).toBe(30 * BLOCK_TIME_MS)

    setVisibility('hidden')

    // Ten seconds of a window nobody is looking at: no ticks, no re-renders.
    act(() => void vi.advanceTimersByTime(10_000))
    expect(result.current).toBe(30 * BLOCK_TIME_MS)

    /*
     * And the first frame back is already correct rather than ten seconds
     * stale — the resume samples before it restarts the interval, so this
     * does not have to wait a tick for the truth.
     */
    setVisibility('visible')
    expect(result.current).toBe(30 * BLOCK_TIME_MS - 10_000)
  })

  it('keeps ticking once it is visible again', () => {
    const { result } = renderHook(() => useSmoothCountdown(30, BLOCK_TIME_MS, CHAIN))

    setVisibility('hidden')
    setVisibility('visible')
    act(() => void vi.advanceTimersByTime(1000))

    expect(result.current).toBe(30 * BLOCK_TIME_MS - 1000)
  })

  it('stops the countdown while the window is visible but unfocused', () => {
    const { result } = renderHook(() => useSmoothCountdown(30, BLOCK_TIME_MS, CHAIN))

    setFocused(false)
    act(() => void vi.advanceTimersByTime(10_000))
    expect(result.current).toBe(30 * BLOCK_TIME_MS)

    setFocused(true)
    expect(result.current).toBe(30 * BLOCK_TIME_MS - 10_000)
  })
})
