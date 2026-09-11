/**
 * Global synchronization for Earth's rotation: every open tab, every
 * reload, every device must show the same face of the planet at the same
 * instant. The angle is always derived fresh from Date.now() against this
 * deployment's `deployedAt` — nothing about "current rotation" is stored
 * client-side, so there is nothing to desync or drift.
 */

import deployments from '../contracts/generated/deployments.json'

const FALLBACK_EPOCH = Date.parse('2026-01-01T00:00:00Z')

function epochFromDeployments(): number {
  let earliest = Number.POSITIVE_INFINITY
  for (const row of Object.values(deployments as Record<string, { deployedAt?: string }>)) {
    const parsed = Date.parse(row.deployedAt ?? '')
    if (Number.isFinite(parsed) && parsed < earliest) earliest = parsed
  }
  return Number.isFinite(earliest) ? earliest : FALLBACK_EPOCH
}

/** Wall-clock origin of the globe. Shared by every client of this build. */
export const EARTH_ROTATION_EPOCH = epochFromDeployments()

/**
 * Earth's axial tilt (ТЗ §6). The planet turns about *its own* axis, which
 * is inclined ~23.5° from the vertical — the real obliquity, not a rounded
 * 30°. It is a constant: the real axis does not precess on any timescale
 * this game cares about, so nothing here is ever a function of time.
 *
 * Applied as `rotateZ(-tilt)` on the CSS 3D globe after `rotateY` spin, so
 * the pole leans in the picture plane and continents wrap around that
 * leaning axis rather than sliding across a flat disc.
 */
export const EARTH_AXIAL_TILT_DEGREES = 23.5

/**
 * Camera elevation above the equator, in degrees of `rotateX`. Zero is a
 * true side-on view; a small positive value tips the north pole slightly
 * toward the viewer so the cylinder-of-slices reads as a globe without
 * exposing the hollow ends.
 */
export const EARTH_VIEW_ELEVATION_DEGREES = 8

/** Longitude strips that approximate the sphere. CSS 3D, not a 3D engine. */
export const EARTH_GLOBE_SLICES = 16

/** One full visual rotation every 600s (10min) — slow and cinematic, not a UI spin. */
export const EARTH_ROTATION_PERIOD_MS = 600_000

/**
 * The texture's left edge doesn't necessarily land on a flattering
 * continent at phase 0. Nudge this (0-1, fraction of one rotation) once
 * to calibrate which side of Earth is visible at the epoch — it never
 * needs to change again after that.
 */
export const EARTH_ROTATION_OFFSET = 0

/** Where Earth is in its turn at `now`, as a fraction in [0, 1) — always re-derived from the clock, never accumulated. */
export function computeEarthRotationPhase(now: number): number {
  const elapsed = now - EARTH_ROTATION_EPOCH
  const rawPhase = (((elapsed % EARTH_ROTATION_PERIOD_MS) + EARTH_ROTATION_PERIOD_MS) % EARTH_ROTATION_PERIOD_MS) / EARTH_ROTATION_PERIOD_MS
  return (((rawPhase + EARTH_ROTATION_OFFSET) % 1) + 1) % 1
}

/**
 * Yaw around Earth's own axis at `now`, in degrees. Phase 0 is yaw 0;
 * the globe turns through −360° over one period (negative = the same
 * eastward sense the old texture pan used).
 */
export function computeEarthSpinYawDegrees(now: number): number {
  // `+ 0` drops the IEEE −0 that phase 0 would otherwise produce.
  return -computeEarthRotationPhase(now) * 360 + 0
}

/**
 * The full CSS 3D transform of the hero globe at a UTC timestamp.
 *
 * Order is view elevation, then axial tilt, then spin: local Y is the
 * polar axis, `rotateY` turns the planet, `rotateZ` leans that axis, and
 * `rotateX` is the side-on camera. A turning planet does not go through
 * this function every frame — it hands the same phase to a CSS animation
 * once as a negative `animation-delay` and lets the compositor carry it
 * (see EarthSphere.module.css). Both produce the same angle for the same
 * instant, which is what lets a resolved operation pin its globe.
 */
export function computeEarthGlobeTransform(now: number): string {
  return (
    `rotateX(${EARTH_VIEW_ELEVATION_DEGREES}deg) ` +
    `rotateZ(${-EARTH_AXIAL_TILT_DEGREES}deg) ` +
    `rotateY(${computeEarthSpinYawDegrees(now)}deg)`
  )
}
