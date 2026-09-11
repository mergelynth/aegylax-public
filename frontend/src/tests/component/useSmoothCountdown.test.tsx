import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __syncCountdownClockForTests, useSmoothCountdown } from '../../hooks/useSmoothCountdown'
import { formatCountdown } from '../../utils/format'

const BLOCK_TIME_MS = 2000
const CHAIN = 1_700_000_000_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(CHAIN)
  __syncCountdownClockForTests()
})
afterEach(() => vi.useRealTimers())

describe('useSmoothCountdown', () => {
  it('moves between blocks instead of jumping a whole block at a time', () => {
    const { result } = renderHook(() => useSmoothCountdown(30, BLOCK_TIME_MS, CHAIN))
    const start = result.current!

    act(() => void vi.advanceTimersByTime(1000))
    const later = result.current!

    expect(start).toBe(30 * BLOCK_TIME_MS)
    expect(later).toBeGreaterThan(0)
    expect(start - later).toBeCloseTo(1000, -1)
  })

  it('re-anchors on the chain timestamp rather than on when this tab heard the block', () => {
    const { result, rerender } = renderHook(
      ({ blocks, ts }) => useSmoothCountdown(blocks, BLOCK_TIME_MS, ts),
      { initialProps: { blocks: 30, ts: CHAIN } },
    )

    act(() => void vi.advanceTimersByTime(97_000))
    act(() => rerender({ blocks: 12, ts: CHAIN + 97_000 }))

    expect(result.current).toBe(12 * BLOCK_TIME_MS)
  })

  it('says nothing at all until the block feed arrives', () => {
    const { result } = renderHook(() => useSmoothCountdown(null, BLOCK_TIME_MS, CHAIN))
    expect(result.current).toBeNull()
  })

  it('reads identically in two components mounted out of phase with each other', () => {
    const header = renderHook(({ blocks }) => useSmoothCountdown(blocks, BLOCK_TIME_MS, CHAIN), {
      initialProps: { blocks: 90 },
    })
    act(() => void vi.advanceTimersByTime(137))
    const console_ = renderHook(({ blocks }) => useSmoothCountdown(blocks, BLOCK_TIME_MS, CHAIN), {
      initialProps: { blocks: 90 },
    })

    act(() => {
      header.rerender({ blocks: 89 })
      console_.rerender({ blocks: 89 })
    })

    for (const step of [0, 250, 700, 1500, 3300, 11_000]) {
      act(() => void vi.advanceTimersByTime(step))
      expect(header.result.current).toBe(console_.result.current)
      expect(formatCountdown(header.result.current!)).toBe(formatCountdown(console_.result.current!))
    }
  })

  it('agrees across two windows that learned the same head five seconds apart', () => {
    const first = renderHook(() => useSmoothCountdown(142, BLOCK_TIME_MS, CHAIN))
    act(() => void vi.advanceTimersByTime(5_000))
    const second = renderHook(() => useSmoothCountdown(142, BLOCK_TIME_MS, CHAIN))

    expect(first.result.current).toBe(second.result.current)
    expect(formatCountdown(first.result.current!)).toBe(formatCountdown(second.result.current!))
  })
})
