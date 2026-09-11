import { blockAtProgress, positionAtProgress } from './attacks'
import type {
  Address,
  Attack,
  AttackTrajectory,
  DefenseAttempt,
  DefensePoint,
  DefenseResult,
  Hash,
  Point2D,
} from './types'
import { closestApproach, defensePointToWorld, firstEntryIntoCircle, interceptorArrivalBlock, distance, type WorldGeometry } from './world'

export function isLateArrival(result: Pick<DefenseResult, 'status' | 'interceptionBlock' | 'arrivalBlock'>): boolean {
  return (
    result.status === 'missed' &&
    result.interceptionBlock !== null &&
    result.arrivalBlock !== null &&
    result.arrivalBlock > result.interceptionBlock
  )
}

export function isTooEarly(result: Pick<DefenseResult, 'status' | 'interceptionBlock' | 'arrivalBlock'>): boolean {
  return (
    result.status === 'missed' &&
    result.interceptionBlock !== null &&
    result.arrivalBlock !== null &&
    result.arrivalBlock < result.interceptionBlock
  )
}

/**
 * Right point, right moment, no kill: the threat was already down when this
 * circle closed on it. Distinct from a miss — nothing was wrong with the
 * shot except that somebody took it higher.
 */
export function isAlreadyDown(result: Pick<DefenseResult, 'status' | 'isWinner'>): boolean {
  return result.status === 'intercepted' && !result.isWinner
}

/**
 * Wrong moment: submitted after the threat passed, or submitted before it
 * got there. Losing to a higher kill is not this — see `isAlreadyDown`.
 */
export function isTooLate(
  result: Pick<DefenseResult, 'status' | 'interceptionBlock' | 'arrivalBlock' | 'isWinner'>,
): boolean {
  return isLateArrival(result)
}

export interface DefenseTiming {
  climbBlocks: number
  arrivalBlock: number
  /** When the threat would pass this altitude along the recon corridor. Null with no estimate. */
  passBlock: number | null
  late: boolean
  early: boolean
}

/**
 * Submit vs the recon corridor's clock — the same two numbers the protocol
 * will compare at reveal, estimated from what this defender currently knows.
 *
 * Without a fused bearing there is no honest pass time, only the submit
 * block. With one, a point behind the estimated inbound is already too
 * late: the threat has already gone by.
 */
export function previewDefenseTiming(input: {
  point: DefensePoint
  world: WorldGeometry
  nowBlock: number
  submittedAtBlock?: number
  launchBlock: number
  flightBlocks: number
  defenseSpeedKmPerBlock: number
  axis: { from: Point2D; to: Point2D } | null
}): DefenseTiming {
  const worldPoint = defensePointToWorld(input.point, input.world)
  const submit = input.submittedAtBlock ?? input.nowBlock
  const arrivalBlock = interceptorArrivalBlock(
    worldPoint,
    input.world,
    submit,
    input.defenseSpeedKmPerBlock,
  )
  const climbBlocks = Math.max(0, arrivalBlock - submit)

  let passBlock: number | null = null
  if (input.axis && input.flightBlocks > 0) {
    const dx = input.axis.to.x - input.axis.from.x
    const dy = input.axis.to.y - input.axis.from.y
    const lengthSquared = dx * dx + dy * dy
    const t =
      lengthSquared <= 0
        ? 0
        : Math.min(
            1,
            Math.max(0, ((worldPoint.x - input.axis.from.x) * dx + (worldPoint.y - input.axis.from.y) * dy) / lengthSquared),
          )
    passBlock = input.launchBlock + t * input.flightBlocks
  }

  return {
    climbBlocks,
    arrivalBlock,
    passBlock,
    late: passBlock !== null && arrivalBlock > passBlock,
    early: passBlock !== null && arrivalBlock < passBlock,
  }
}

export function formatDefenseTiming(timing: DefenseTiming, nowBlock: number): string {
  const arrival = Math.max(0, Math.round(timing.arrivalBlock))
  // Recon estimate, not the protocol clock. The fused corridor names a
  // pass block; the chain will score the snapshot at submit against the
  // sealed trajectory, which this preview has not seen.
  const prefix = `Est. submit: Block ${arrival}`
  if (timing.passBlock === null) return prefix
  if (timing.late) {
    const lateBy = Math.max(1, Math.round(timing.arrivalBlock - timing.passBlock))
    return `${prefix} · TOO LATE ${lateBy} est. — threat already passed`
  }
  if (timing.early) {
    const earlyBy = Math.max(1, Math.round(timing.passBlock - timing.arrivalBlock))
    return `${prefix} · TOO EARLY ${earlyBy} est. — threat not there yet`
  }
  const untilPass = Math.max(0, Math.round(timing.passBlock - nowBlock))
  return `${prefix} · on the pass ${untilPass} est.`
}

/**
 * Interception (ТЗ §10, §11).
 *
 * The rule is a *spacetime snapshot*, not a chord test. Covering the path
 * is not a hit: at `arrival = submit` the threat must still be in flight,
 * and `distance(point, trajectory[submit])` must be inside the radius.
 * Ranking among those hits is altitude: the earliest snapshot hit is the
 * kill, and a threat killed high never reaches the circles waiting below.
 * Hits that share the winning block share the pool, however many there are.
 *
 * The chord test (`firstEntryIntoCircle`) is kept only so a miss can be
 * named TOO EARLY or TOO LATE rather than "never near the path".
 */

export function createDefenseAttempt(params: {
  id: string
  lobbyId: Hash
  attackId: string
  participant: Address
  defensePoint: DefensePoint
  submittedAtBlock: number
  submittedAtTimestamp: number
  txHash: Hash
}): DefenseAttempt {
  // `sealedPoint` is a *read-time* field — the protocol reseals a point to
  // its owner when they ask for it (ТЗ §11) — so a freshly built attempt
  // never carries one.
  return { ...params, sealedPoint: null }
}

/**
 * Submit block when the threat would pass this point — the bet the
 * snapshot test actually scores.
 */
export function rendezvousSubmitBlock(input: {
  point: DefensePoint
  world: WorldGeometry
  launchBlock: number
  flightBlocks: number
  trajectory: AttackTrajectory
  defenseSpeedKmPerBlock: number
}): number {
  const worldPoint = defensePointToWorld(input.point, input.world)
  const climb = interceptorArrivalBlock(worldPoint, input.world, 0, input.defenseSpeedKmPerBlock)
  const approach = closestApproach(worldPoint, input.trajectory.pointA, input.trajectory.pointB)
  const passBlock = input.launchBlock + approach.t * input.flightBlocks
  const submit = Math.floor(passBlock - climb)
  const impactBlock = input.launchBlock + input.flightBlocks
  return Math.min(Math.max(input.launchBlock, submit), Math.max(input.launchBlock, impactBlock - 1))
}

export interface InterceptionCheck {
  intercepts: boolean
  /** 0..1 through the flight at which the threat entered the radius. NaN when it never did. */
  interceptionProgress: number
  /** Where on the trajectory that entry happened. Null when it never did. */
  interceptionPoint: Point2D | null
  /** Closest the Defense Point ever came to the trajectory — what makes a miss describable. */
  missDistanceKm: number
}

/**
 * Chord test only — did the path ever enter the radius. The payout test is
 * `resolveDefense`: the threat's position *at submit*, not this.
 */
export function checkInterception(
  defensePoint: DefensePoint,
  trajectory: AttackTrajectory,
  world: WorldGeometry,
  interceptionRadiusKm: number,
): InterceptionCheck {
  const point = defensePointToWorld(defensePoint, world)
  const entry = firstEntryIntoCircle(trajectory.pointA, trajectory.pointB, point, interceptionRadiusKm)
  const approach = closestApproach(point, trajectory.pointA, trajectory.pointB)

  return {
    intercepts: entry.entered,
    interceptionProgress: entry.t,
    interceptionPoint: entry.entered ? entry.point : null,
    missDistanceKm: approach.distanceKm,
  }
}

/**
 * One attempt's result, without ranking. `attempt.defensePoint` is null when
 * the caller is not allowed to see it, which is also exactly when there is
 * nothing to resolve for them — so that case reports `pending` rather than
 * guessing.
 *
 * `isWinner` is always false here: winning is a comparison against the
 * other defenders, and this function only sees one. `resolveAttackDefenses`
 * is what decides it.
 */
export function resolveDefense(
  attempt: DefenseAttempt,
  attack: Pick<Attack, 'launchBlock' | 'flightDurationBlocks'>,
  trajectory: AttackTrajectory | null,
  world: WorldGeometry,
  interceptionRadiusKm: number,
  defenseSpeedKmPerBlock: number,
): DefenseResult {
  if (!trajectory || !attempt.defensePoint) {
    return {
      attemptId: attempt.id,
      participant: attempt.participant,
      status: 'pending',
      interceptionProgress: null,
      interceptionBlock: null,
      interceptionPoint: null,
      missDistanceKm: null,
      arrivalBlock: null,
      isWinner: false,
      reason: 'The attack has not resolved yet, so its trajectory is still sealed.',
    }
  }

  const point = defensePointToWorld(attempt.defensePoint, world)
  const arrivalBlock = interceptorArrivalBlock(point, world, attempt.submittedAtBlock, defenseSpeedKmPerBlock)
  const impactBlock = attack.launchBlock + attack.flightDurationBlocks
  const inFlight =
    attack.flightDurationBlocks > 0 && arrivalBlock >= attack.launchBlock && arrivalBlock < impactBlock
  const t = inFlight ? (arrivalBlock - attack.launchBlock) / attack.flightDurationBlocks : null
  const threat = t !== null ? positionAtProgress(trajectory, t) : null
  const snapshotKm = threat ? distance(point, threat) : null
  const hit = threat !== null && snapshotKm !== null && snapshotKm <= interceptionRadiusKm

  if (hit && threat && t !== null && snapshotKm !== null) {
    return {
      attemptId: attempt.id,
      participant: attempt.participant,
      status: 'intercepted',
      interceptionProgress: t,
      interceptionBlock: arrivalBlock,
      interceptionPoint: threat,
      missDistanceKm: snapshotKm,
      arrivalBlock,
      isWinner: false,
      reason: `The threat was inside the ${Math.round(interceptionRadiusKm)} km radius at submit block ${arrivalBlock.toFixed(1)}.`,
    }
  }

  const check = checkInterception(attempt.defensePoint, trajectory, world, interceptionRadiusKm)
  const passBlock = check.intercepts ? blockAtProgress(attack, check.interceptionProgress) : null
  const missKm = snapshotKm ?? check.missDistanceKm

  if (check.intercepts && passBlock !== null && arrivalBlock > passBlock) {
    return {
      attemptId: attempt.id,
      participant: attempt.participant,
      status: 'missed',
      interceptionProgress: check.interceptionProgress,
      interceptionBlock: passBlock,
      interceptionPoint: check.interceptionPoint,
      missDistanceKm: missKm,
      arrivalBlock,
      isWinner: false,
      reason: `Defense was submitted at block ${arrivalBlock.toFixed(1)}, after the threat had already passed through.`,
    }
  }

  if (check.intercepts && passBlock !== null && arrivalBlock < passBlock) {
    return {
      attemptId: attempt.id,
      participant: attempt.participant,
      status: 'missed',
      interceptionProgress: check.interceptionProgress,
      interceptionBlock: passBlock,
      interceptionPoint: check.interceptionPoint,
      missDistanceKm: missKm,
      arrivalBlock,
      isWinner: false,
      reason: `Defense was submitted at block ${arrivalBlock.toFixed(1)}, before the threat reached this altitude.`,
    }
  }

  return {
    attemptId: attempt.id,
    participant: attempt.participant,
    status: 'missed',
    interceptionProgress: null,
    interceptionBlock: null,
    interceptionPoint: null,
    missDistanceKm: missKm,
    arrivalBlock,
    isWinner: false,
      reason: `Defense Point stayed ${Math.round(missKm)} km from the threat at submit, outside the ${Math.round(interceptionRadiusKm)} km interception radius.`,
  }
}

export interface DefenseResolution {
  intercepted: boolean
  /** Where the *winning* interception happened (ТЗ §11.5). */
  interceptionPoint: Point2D | null
  interceptionProgress: number | null
  interceptionBlock: number | null
  /** ТЗ §11.6 — the earliest snapshot hit. Its block's hits split the pool. */
  winners: Address[]
  results: DefenseResult[]
}

/**
 * Resolves every attempt against one attack (ТЗ §11).
 *
 * Two distinct answers come out of this:
 *
 *   `status: 'intercepted'` — at this interceptor's submit the threat was
 *                             still flying and inside the radius. Covering
 *                             the chord at some other time is not a hit.
 *   `isWinner`              — the earliest of those hits, and only it. Every
 *                             hit sharing that block wins too, and they
 *                             split the pool equally.
 */
export function resolveAttackDefenses(
  attempts: readonly DefenseAttempt[],
  attack: Pick<Attack, 'launchBlock' | 'flightDurationBlocks'>,
  trajectory: AttackTrajectory,
  world: WorldGeometry,
  interceptionRadiusKm: number,
  defenseSpeedKmPerBlock: number,
): DefenseResolution {
  const results = attempts
    .filter((attempt) => attempt.defensePoint !== null)
    .map((attempt) =>
      resolveDefense(attempt, attack, trajectory, world, interceptionRadiusKm, defenseSpeedKmPerBlock),
    )

  const interceptors = results.filter((result) => result.status === 'intercepted')
  if (interceptors.length === 0) {
    return {
      intercepted: false,
      interceptionPoint: null,
      interceptionProgress: null,
      interceptionBlock: null,
      winners: [],
      results,
    }
  }

  // Arrival is the submit block, so the earliest hit is the highest one, and
  // ranking by time and ranking by altitude are the same ranking. Compared as
  // whole blocks: everything that hit in the winning block hit the same threat
  // at the same coordinates, so no number is left to separate them.
  const killBlock = interceptors.reduce(
    (earliest, result) => Math.min(earliest, result.arrivalBlock ?? Number.POSITIVE_INFINITY),
    Number.POSITIVE_INFINITY,
  )
  const kills = interceptors.filter((result) => result.arrivalBlock === killBlock)
  for (const result of kills) result.isWinner = true

  // The shot was good and the record says so; what it did not do is kill
  // anything, because there was nothing left at that altitude to kill.
  for (const result of interceptors) {
    if (result.isWinner) continue
    result.reason = `The threat was inside the radius at submit block ${result.arrivalBlock?.toFixed(1)}, but it had already been intercepted at block ${killBlock.toFixed(1)}, higher up.`
  }

  const shown = kills[0]

  return {
    intercepted: true,
    interceptionPoint: shown.interceptionPoint,
    interceptionProgress: shown.interceptionProgress,
    interceptionBlock: shown.interceptionBlock,
    winners: kills.map((result) => result.participant),
    results,
  }
}
