import { act, render, renderHook, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PhaseStrip } from '../../components/lobby/PhaseStrip'
import { useIncrease } from '../../motion/useIncrease'
import type { LobbyPhase } from '../../game/lobbyPhase'

/** The marker is the only stop-level element the strip ever draws one of. */
function markedStop(container: HTMLElement): number {
  const stops = [...container.querySelectorAll('[class*="stop"]')].filter(
    (stop) => !stop.className.includes('stopLabel'),
  )
  return stops.findIndex((stop) => stop.querySelector('[class*="marker"]') !== null)
}

describe('<PhaseStrip /> — the operation as a position', () => {
  /**
   * The point of the strip over the string it replaced: the status is not
   * only *which* state, it is how far through the operation that state is.
   */
  it('moves the marker along the track as the operation advances', () => {
    const stops: [LobbyPhase, number][] = [
      ['OPEN', 0],
      ['WAITING_FOR_ATTACK', 1],
      ['ATTACK_ACTIVE', 2],
      ['RESULT', 3],
    ]

    for (const [phase, expected] of stops) {
      const { container, unmount } = render(<PhaseStrip phase={phase} />)
      expect(markedStop(container)).toBe(expected)
      unmount()
    }
  })

  /**
   * Incoming is the same *place* as waiting — applications are closed and
   * nothing has launched — so the marker must not move for it. What has
   * changed is that it is about to, which is a pulse on the stop it is
   * already standing on.
   */
  it('does not advance for ATTACK INCOMING, and lights the stop instead', () => {
    const { container } = render(<PhaseStrip phase="ATTACK_INCOMING" />)
    expect(markedStop(container)).toBe(1)
    expect(container.querySelector('[class*="markerImminent"]')).not.toBeNull()

    const { container: waiting } = render(<PhaseStrip phase="WAITING_FOR_ATTACK" />)
    expect(waiting.querySelector('[class*="markerImminent"]')).toBeNull()
  })

  /**
   * The phase's own name still reaches assistive tech — out of a live
   * region, so a screen reader is told when the operation moves. The track
   * itself is decoration and says nothing.
   */
  it('announces the phase in words and hides the track', () => {
    const { container } = render(<PhaseStrip phase="ATTACK_ACTIVE" />)
    expect(screen.getByRole('status')).toHaveTextContent('ATTACK ACTIVE')
    expect(container.querySelector('[class*="track"]')).toHaveAttribute('aria-hidden', 'true')
  })
})

describe('useIncrease — a reading that just went up', () => {
  /**
   * The first value is not an arrival: it is what was already true when the
   * panel opened. Only a rise afterwards is an event.
   */
  it('pulses on a rise, and never on the first value or a fall', () => {
    const { result, rerender } = renderHook(({ value }) => useIncrease(value), {
      initialProps: { value: 3 },
    })
    expect(result.current).toBe(0)

    act(() => rerender({ value: 4 }))
    const afterRise = result.current
    expect(afterRise).toBeGreaterThan(0)

    // A count falling is a probe being spent or a player leaving — something
    // the player did, which does not need announcing back to them.
    act(() => rerender({ value: 2 }))
    expect(result.current).toBe(afterRise)

    act(() => rerender({ value: 5 }))
    expect(result.current).toBeGreaterThan(afterRise)
  })
})
