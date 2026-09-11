import { createSeededRandom, deriveSeed } from './randomness'
import type { Attack, AttackTrajectory, Hash, Point2D } from './types'
import {
  MAX_APPROACH_OFFSET_RADIANS,
  MAX_LAUNCH_OFFSET_RADIANS,
  distance,
  pointOnEarthSurface,
  rayExitFromEarth,
  type WorldGeometry,
} from './world'

/**
 * Attack generation and flight (ТЗ §3, §5).
 *
 * One operation gets exactly one attack. When applications close, the
 * protocol picks the nearest *future* epoch boundary and schedules the
 * launch there; the attack impacts at the following boundary, so the flight
 * duration is the epoch interval by construction (§5.3).
 *
 * Geometry matches `Geometry.deriveTrajectory`: two independent draws,
 * then the ray.
 *
 *   θ — launch bearing, ±60° off straight up (`MAX_LAUNCH_OFFSET`);
 *   δ — impact offset from that bearing, ±55° (`MAX_APPROACH_OFFSET`);
 *   startPoint — `rayExitFromEarth(θ)` on the board's outer edge;
 *   targetPoint — Earth surface at θ + δ.
 *
 * Length is a result rather than a constant: a shallow approach exits
 * through a far side edge and travels a long way, a steep one leaves
 * through the top nearby. Speed then falls out of §5.4-5.6 —
 * `distance / flightDuration` — so long trajectories run fast, short ones
 * run slow, and every attack reaches its target at the end of the epoch
 * (§5.7).
 *
 * Everything generated here is sealed. `Attack` carries only the schedule;
 * the geometry *and the speed it implies* live on `AttackTrajectory`, which
 * no read returns until the player asks for the reveal (§3.3-3.5, §13).
 * Speed is on the sealed half deliberately: publishing it would publish
 * `speed × epochBlocks`, which is the distance from Earth to the launch
 * point — a straight leak of half the hidden geometry.
 */

export interface AttackGenerationConfig {
  /** Blocks per epoch; the attack's whole flight (ТЗ §5.3). */
  epochBlocks: number
}

export interface ChainTimeReference {
  blockNumber: number
  timestamp: number
  avgBlockTimeMs: number
}

export function estimateTimestampForBlock(ref: ChainTimeReference, targetBlock: number): number {
  return ref.timestamp + (targetBlock - ref.blockNumber) * ref.avgBlockTimeMs
}

export function distanceBetween(a: Point2D, b: Point2D): number {
  return distance(a, b)
}

/**
 * A generated attack, split along the line the protocol has to keep: the
 * `attack` half is what any client may read, the `trajectory` half is what
 * only the protocol holds until the reveal.
 */
export interface GeneratedAttack {
  attack: Attack
  trajectory: AttackTrajectory
}

export function generateAttack(
  lobbyId: Hash,
  epoch: { epochId: number; startBlock: number; seed: Hash },
  config: AttackGenerationConfig,
  world: WorldGeometry,
  chainRef: ChainTimeReference,
): GeneratedAttack {
  const rng = createSeededRandom(deriveSeed([epoch.seed, 'attack']))

  // Same two draws Geometry.sol recentres from the confidential layer:
  // θ ∈ ±MAX_LAUNCH_OFFSET, δ ∈ ±MAX_IMPACT_DELTA. Screen convention is
  // +x with y down, so straight up out of the planet is -π/2.
  const theta = (rng() * 2 - 1) * MAX_LAUNCH_OFFSET_RADIANS
  const delta = (rng() * 2 - 1) * MAX_APPROACH_OFFSET_RADIANS
  const launchBearing = -Math.PI / 2 + theta
  const impactAngle = launchBearing + delta

  const targetPoint = pointOnEarthSurface(impactAngle, world)
  const startPoint = rayExitFromEarth(launchBearing, world)

  const lengthKm = distance(startPoint, targetPoint)
  const launchBlock = epoch.startBlock
  const impactBlock = launchBlock + config.epochBlocks

  return {
    attack: {
      id: `${lobbyId}-e${epoch.epochId}`,
      lobbyId,
      epochId: epoch.epochId,
      launchBlock,
      launchTimestamp: estimateTimestampForBlock(chainRef, launchBlock),
      impactBlock,
      impactTimestamp: estimateTimestampForBlock(chainRef, impactBlock),
      flightDurationBlocks: config.epochBlocks,
      status: 'PENDING',
    },
    trajectory: {
      pointA: startPoint,
      pointB: targetPoint,
      impactAngleRadians: impactAngle,
      launchBearingRadians: launchBearing,
      lengthKm,
      // ТЗ §5.4: the one place speed is ever computed. Dividing by the
      // flight duration is what pins the impact to the epoch boundary
      // whatever the distance turned out to be.
      speedKmPerBlock: config.epochBlocks > 0 ? lengthKm / config.epochBlocks : 0,
    },
  }
}

/** 0..1 through the flight at a given block. */
export function flightProgress(attack: Attack, blockNumber: number): number {
  if (attack.flightDurationBlocks <= 0) return 1
  return Math.min(1, Math.max(0, (blockNumber - attack.launchBlock) / attack.flightDurationBlocks))
}

export function getPositionAtBlock(
  attack: Attack,
  trajectory: AttackTrajectory,
  blockNumber: number,
): Point2D {
  return positionAtProgress(trajectory, flightProgress(attack, blockNumber))
}

export function positionAtProgress(trajectory: AttackTrajectory, progress: number): Point2D {
  const t = Math.min(1, Math.max(0, progress))
  return {
    x: trajectory.pointA.x + (trajectory.pointB.x - trajectory.pointA.x) * t,
    y: trajectory.pointA.y + (trajectory.pointB.y - trajectory.pointA.y) * t,
  }
}

export function getImpactPoint(trajectory: AttackTrajectory): Point2D {
  return trajectory.pointB
}

/** Wall-clock estimate of impact, for countdowns only — never for game state. */
export function getImpactTime(attack: Attack, avgBlockTimeMs: number): number {
  return attack.launchTimestamp + attack.flightDurationBlocks * avgBlockTimeMs
}

/**
 * The block a progress fraction through the flight lands on. Interception
 * times come back from the geometry as a 0..1 fraction; this is what turns
 * one into the chain-side number the winner is decided by (ТЗ §11.5).
 */
export function blockAtProgress(
  attack: Pick<Attack, 'launchBlock' | 'flightDurationBlocks'>,
  progress: number,
): number {
  return attack.launchBlock + progress * attack.flightDurationBlocks
}
