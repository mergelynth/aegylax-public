import { render } from '@testing-library/react'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { EarthSphere } from '../../components/earth/EarthSphere'
import {
  EARTH_AXIAL_TILT_DEGREES,
  EARTH_GLOBE_SLICES,
  EARTH_ROTATION_PERIOD_MS,
  computeEarthGlobeTransform,
  computeEarthRotationPhase,
} from '../../game/earthRotation'

afterEach(() => vi.restoreAllMocks())

/** The CSS 3D spinning group — the only element the rotation is ever written to. */
function sphere(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[class*="sphere"]')
}

describe('<EarthSphere /> rotation', () => {
  /**
   * The judder fix, stated as a property rather than as a look: nothing
   * about the turn runs in JavaScript. One negative animation-delay places
   * the CSS loop at the wall-clock phase and the compositor carries it, so
   * there is no per-frame work to be throttled into visible steps.
   */
  it('hands the whole turn to CSS — no animation frame loop at all', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const { container } = render(<EarthSphere variant="hero" />)

    expect(raf).not.toHaveBeenCalled()
    expect(sphere(container)!.style.animationDuration).toBe(`${EARTH_ROTATION_PERIOD_MS}ms`)
  })

  it('starts the loop at the phase the wall clock is already at, so every client agrees', () => {
    const now = Date.parse('2026-05-02T11:22:33Z')
    vi.spyOn(Date, 'now').mockReturnValue(now)

    const { container } = render(<EarthSphere variant="hero" />)
    const delayMs = Number.parseFloat(sphere(container)!.style.animationDelay)

    // A negative delay of exactly the elapsed fraction of one period.
    expect(delayMs).toBeCloseTo(-computeEarthRotationPhase(now) * EARTH_ROTATION_PERIOD_MS, 6)
  })

  /**
   * ТЗ §6 — the planet turns about *its own* axis, leaned by the real
   * obliquity, not a 2D rotate of a panning strip.
   */
  it('turns about an axis inclined by the axial tilt, and only that', () => {
    const { container } = render(<EarthSphere variant="hero" />)
    const globe = sphere(container)!

    expect(globe.style.getPropertyValue('--earth-tilt')).toBe(`${-EARTH_AXIAL_TILT_DEGREES}deg`)
    expect(container.querySelectorAll('[class*="slice"]')).toHaveLength(EARTH_GLOBE_SLICES)
  })

  it('never builds the hero globe for the small panel variant', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const { container } = render(<EarthSphere variant="panel" />)

    expect(raf).not.toHaveBeenCalled()
    expect(sphere(container)).toBeNull()
  })
})

/**
 * ТЗ §6 — a resolved operation's globe is a *record*, and a record has to
 * survive being closed and reopened.
 */
describe('<EarthSphere /> frozen at a block timestamp (ТЗ §6)', () => {
  const IMPACT_MS = Date.parse('2026-03-14T09:41:00Z')

  it('stops advancing and renders the angle that timestamp implies', () => {
    const { container } = render(<EarthSphere variant="hero" frozenAtMs={IMPACT_MS} />)
    const globe = sphere(container)!

    expect(globe.style.animation).toBe('none')
    expect(globe.style.transform).toBe(computeEarthGlobeTransform(IMPACT_MS))
  })

  it('renders the same angle on a later mount, whatever the wall clock says', () => {
    // This is the property that makes the impact stay in one physical
    // place a day, a week or a month later: nothing about the frozen frame
    // is derived from when it is being looked at.
    const first = render(<EarthSphere variant="hero" frozenAtMs={IMPACT_MS} />)
    const before = sphere(first.container)!.style.transform
    first.unmount()

    vi.spyOn(Date, 'now').mockReturnValue(IMPACT_MS + 45 * 24 * 60 * 60 * 1000)
    const second = render(<EarthSphere variant="hero" frozenAtMs={IMPACT_MS} />)

    expect(sphere(second.container)!.style.transform).toBe(before)
  })
})

/**
 * ТЗ §12-13 — the shield and the shockwave belong to the moment the result
 * arrives, not to every later visit.
 */
describe('<EarthSphere /> announcing a result', () => {
  it('performs the impact when the verdict is arriving', () => {
    const { container } = render(<EarthSphere variant="hero" state="impacted" announce />)
    expect(container.querySelector('[class*="impact"]')).not.toBeNull()
  })

  it('keeps the verdict but plays nothing when the operation is simply being read back', () => {
    const { container } = render(<EarthSphere variant="hero" state="impacted" announce={false} />)

    expect(container.querySelector('[class*="impact"]')).toBeNull()
    // The planet still wears the result — only the performance is gone.
    expect(container.querySelector('[class*="struck"]')).not.toBeNull()
  })
})
