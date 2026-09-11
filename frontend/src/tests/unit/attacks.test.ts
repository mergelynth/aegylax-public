import { describe, expect, it } from 'vitest'
import { keccak256, toHex } from 'viem'
import {
  blockAtProgress,
  flightProgress,
  generateAttack,
  getPositionAtBlock,
  positionAtProgress,
  type ChainTimeReference,
} from '../../game/attacks'
import type { Hash } from '../../game/types'
import {
  MAX_APPROACH_OFFSET_RADIANS,
  MAX_LAUNCH_OFFSET_RADIANS,
  buildWorld,
  distance,
  isApproachClearOfEarth,
  isOnFieldBoundary,
  rayExitFromEarth,
} from '../../game/world'
import { TEST_MAP_GRID, TEST_PROTOCOL_LIMITS } from '../fixtures'

const lobbyId = keccak256(toHex('lobby')) as Hash
const config = { epochBlocks: TEST_PROTOCOL_LIMITS.epochBlocks }
const world = buildWorld(TEST_MAP_GRID, TEST_PROTOCOL_LIMITS.sectorSpanKm)
const chainRef: ChainTimeReference = { blockNumber: 1000, timestamp: 1_700_000_000_000, avgBlockTimeMs: 2000 }

function generate(epochId: number) {
  return generateAttack(
    lobbyId,
    { epochId, startBlock: 1500 + epochId * 150, seed: keccak256(toHex(`seed-${epochId}`)) as Hash },
    config,
    world,
    chainRef,
  )
}

describe('attack generation (ТЗ §3, §5)', () => {
  it('flies for exactly one epoch, launch boundary to impact boundary (§5.3)', () => {
    const { attack } = generate(3)
    expect(attack.flightDurationBlocks).toBe(config.epochBlocks)
    expect(attack.impactBlock).toBe(attack.launchBlock + config.epochBlocks)
  })

  it('starts on the working area’s outer edge and ends on Earth’s surface (§3.1-3.2)', () => {
    for (let epochId = 0; epochId < 40; epochId++) {
      const { trajectory } = generate(epochId)
      expect(isOnFieldBoundary(trajectory.pointA, world)).toBe(true)
      expect(distance(trajectory.pointB, world.earth.center)).toBeCloseTo(world.earth.radiusKm)
    }
  })

  it('derives launch from θ then impact from δ, matching Geometry.deriveTrajectory', () => {
    for (let epochId = 0; epochId < 40; epochId++) {
      const { trajectory } = generate(epochId)
      const bearing = trajectory.launchBearingRadians
      expect(bearing).toEqual(expect.any(Number))
      if (bearing === undefined) continue
      const theta = bearing + Math.PI / 2
      const delta = trajectory.impactAngleRadians - bearing
      expect(Math.abs(theta)).toBeLessThanOrEqual(MAX_LAUNCH_OFFSET_RADIANS + 1e-9)
      expect(Math.abs(delta)).toBeLessThanOrEqual(MAX_APPROACH_OFFSET_RADIANS + 1e-9)
      expect(trajectory.pointA).toEqual(rayExitFromEarth(bearing, world))
    }
  })

  it('reaches Earth on a ray that does not clip the globe first', () => {
    // θ + δ can sit past the old ±60° cap, including a few degrees past the
    // equator — the same envelope Geometry.deriveTrajectory samples. The
    // invariant that still matters is that the inbound does not tunnel
    // through the planet on the way.
    for (let epochId = 0; epochId < 40; epochId++) {
      const { trajectory } = generate(epochId)
      expect(distance(trajectory.pointB, world.earth.center)).toBeCloseTo(world.earth.radiusKm)
      expect(isApproachClearOfEarth(trajectory.pointA, trajectory.pointB, world)).toBe(true)
    }
  })

  it('derives speed from the distance it actually has to cover (§5.4)', () => {
    for (let epochId = 0; epochId < 20; epochId++) {
      const { trajectory } = generate(epochId)
      expect(trajectory.lengthKm).toBeCloseTo(distance(trajectory.pointA, trajectory.pointB))
      expect(trajectory.speedKmPerBlock).toBeCloseTo(trajectory.lengthKm / config.epochBlocks)
    }
  })

  it('gives long trajectories a higher speed than short ones (§5.5)', () => {
    const flights = Array.from({ length: 40 }, (_, epochId) => generate(epochId).trajectory)
    const shortest = flights.reduce((a, b) => (a.lengthKm <= b.lengthKm ? a : b))
    const longest = flights.reduce((a, b) => (a.lengthKm >= b.lengthKm ? a : b))
    expect(longest.lengthKm).toBeGreaterThan(shortest.lengthKm)
    expect(longest.speedKmPerBlock).toBeGreaterThan(shortest.speedKmPerBlock)
  })

  it('lands every attack exactly at the end of its epoch, whatever the distance (§5.3, §5.6)', () => {
    for (let epochId = 0; epochId < 20; epochId++) {
      const { attack, trajectory } = generate(epochId)
      const covered = trajectory.speedKmPerBlock * (attack.impactBlock - attack.launchBlock)
      expect(covered).toBeCloseTo(trajectory.lengthKm, 6)
    }
  })

  it('reaches Earth’s surface at the impact point and not before', () => {
    // A trajectory that clipped the globe early would make the revealed
    // impact point a fiction, so every sample before the end must be
    // strictly outside the disc.
    for (let epochId = 0; epochId < 20; epochId++) {
      const { trajectory } = generate(epochId)
      for (let step = 0; step < 1; step += 0.02) {
        const point = positionAtProgress(trajectory, step)
        expect(distance(point, world.earth.center)).toBeGreaterThan(world.earth.radiusKm - 1e-6)
      }
    }
  })

  it('varies the approach angle between epochs, so the impact sector does not give the path away', () => {
    const bearings = new Set(
      Array.from({ length: 12 }, (_, epochId) => {
        const { trajectory } = generate(epochId)
        return Math.round(
          Math.atan2(
            trajectory.pointB.y - trajectory.pointA.y,
            trajectory.pointB.x - trajectory.pointA.x,
          ) * 100,
        )
      }),
    )
    expect(bearings.size).toBeGreaterThan(8)
  })

  it('is deterministic for a given seed', () => {
    expect(generate(5).trajectory).toEqual(generate(5).trajectory)
  })

  it('keeps the geometry off the public record entirely (§3.3-3.5)', () => {
    // Not "returns null for the trajectory" — there is no field on the
    // public attack that could carry it, and speed is sealed with it
    // because speed x epoch is the distance back to the launch point.
    const { attack } = generate(1)
    expect(attack).not.toHaveProperty('trajectory')
    expect(attack).not.toHaveProperty('speedKmPerBlock')
  })
})

describe('flight position', () => {
  it('is at the launch point at the launch block and the impact point at impact', () => {
    const { attack, trajectory } = generate(2)
    const start = getPositionAtBlock(attack, trajectory, attack.launchBlock)
    const end = getPositionAtBlock(attack, trajectory, attack.impactBlock)
    // Interpolated rather than copied, so the endpoints land within
    // floating-point noise of the trajectory rather than exactly on it.
    expect(start.x).toBeCloseTo(trajectory.pointA.x, 6)
    expect(start.y).toBeCloseTo(trajectory.pointA.y, 6)
    expect(end.x).toBeCloseTo(trajectory.pointB.x, 6)
    expect(end.y).toBeCloseTo(trajectory.pointB.y, 6)
  })

  it('clamps outside the flight window instead of extrapolating', () => {
    const { attack } = generate(2)
    expect(flightProgress(attack, attack.launchBlock - 500)).toBe(0)
    expect(flightProgress(attack, attack.impactBlock + 500)).toBe(1)
  })

  it('turns a progress fraction back into the block it happened on', () => {
    const { attack } = generate(2)
    expect(blockAtProgress(attack, 0)).toBe(attack.launchBlock)
    expect(blockAtProgress(attack, 1)).toBe(attack.impactBlock)
    expect(blockAtProgress(attack, 0.5)).toBe(attack.launchBlock + config.epochBlocks / 2)
  })
})
