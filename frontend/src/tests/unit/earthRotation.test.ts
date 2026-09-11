import { describe, expect, it } from 'vitest'
import deployments from '../../contracts/generated/deployments.json'
import {
  EARTH_AXIAL_TILT_DEGREES,
  EARTH_ROTATION_EPOCH,
  EARTH_ROTATION_PERIOD_MS,
  EARTH_VIEW_ELEVATION_DEGREES,
  computeEarthGlobeTransform,
  computeEarthSpinYawDegrees,
} from '../../game/earthRotation'

describe('EARTH_ROTATION_EPOCH', () => {
  it('is this deployment’s clock, so every client of the build shares a face', () => {
    const deployed = Object.values(deployments as Record<string, { deployedAt?: string }>)
      .map((row) => Date.parse(row.deployedAt ?? ''))
      .filter((value) => Number.isFinite(value))
    expect(deployed.length).toBeGreaterThan(0)
    expect(EARTH_ROTATION_EPOCH).toBe(Math.min(...deployed))
  })
})

describe('computeEarthSpinYawDegrees', () => {
  it('is a pure function of time — same instant always yields the same angle, on any client', () => {
    const now = EARTH_ROTATION_EPOCH + 54_321
    expect(computeEarthSpinYawDegrees(now)).toEqual(computeEarthSpinYawDegrees(now))
  })

  it('starts at 0° at the epoch', () => {
    expect(computeEarthSpinYawDegrees(EARTH_ROTATION_EPOCH)).toBe(0)
  })

  it('loops seamlessly — one full period lands back on the exact same angle', () => {
    const now = EARTH_ROTATION_EPOCH + 37_000
    expect(computeEarthSpinYawDegrees(now)).toBe(computeEarthSpinYawDegrees(now + EARTH_ROTATION_PERIOD_MS))
    expect(computeEarthSpinYawDegrees(now)).toBe(computeEarthSpinYawDegrees(now + 5 * EARTH_ROTATION_PERIOD_MS))
  })

  it('stays within one turn (−360°, 0°]', () => {
    for (const offset of [
      0,
      1,
      EARTH_ROTATION_PERIOD_MS / 2,
      EARTH_ROTATION_PERIOD_MS - 1,
      10 * EARTH_ROTATION_PERIOD_MS + 999,
    ]) {
      const yaw = computeEarthSpinYawDegrees(EARTH_ROTATION_EPOCH + offset)
      expect(yaw).toBeLessThanOrEqual(0)
      expect(yaw).toBeGreaterThan(-360)
    }
  })

  it('is well-defined before the epoch too (no negative-modulo bug)', () => {
    const yaw = computeEarthSpinYawDegrees(EARTH_ROTATION_EPOCH - 12_345)
    expect(yaw).toBeLessThanOrEqual(0)
    expect(yaw).toBeGreaterThan(-360)
  })

  it('advances monotonically within a period (no backward jump mid-rotation)', () => {
    const a = computeEarthSpinYawDegrees(EARTH_ROTATION_EPOCH + 1_000)
    const b = computeEarthSpinYawDegrees(EARTH_ROTATION_EPOCH + 2_000)
    // Negative yaw: "further along" is a smaller number.
    expect(b).toBeLessThan(a)
  })
})

describe('computeEarthGlobeTransform', () => {
  it('spins about the tilted polar axis, viewed slightly from the side', () => {
    const now = EARTH_ROTATION_EPOCH + 90_000
    expect(computeEarthGlobeTransform(now)).toBe(
      `rotateX(${EARTH_VIEW_ELEVATION_DEGREES}deg) ` +
        `rotateZ(${-EARTH_AXIAL_TILT_DEGREES}deg) ` +
        `rotateY(${computeEarthSpinYawDegrees(now)}deg)`,
    )
  })
})

describe('the axis (ТЗ §6)', () => {
  it('is Earth’s own, inclined ~23.5°', () => {
    expect(EARTH_AXIAL_TILT_DEGREES).toBeCloseTo(23.5, 5)
  })

  /**
   * The axis does not precess. It is a constant rather than a function of
   * time, and this test exists to keep it one — a tilt that drifted would
   * tumble every impact point pinned to the globe.
   */
  it('is a constant, not a function of when it is read', () => {
    expect(typeof EARTH_AXIAL_TILT_DEGREES).toBe('number')
  })
})
