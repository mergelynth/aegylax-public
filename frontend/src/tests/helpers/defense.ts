import { positionAtProgress } from '../../game/attacks'
import type { Address, AttackTrajectory, DefensePoint, Hash } from '../../game/types'
import {
  closestApproach,
  defensePointToWorld,
  interceptorArrivalBlock,
  worldToDefensePoint,
  type WorldGeometry,
} from '../../game/world'

type DefenseClient = {
  getBlockNumber(): Promise<number>
  advanceBlocks(count: number): void
  submitDefense: (
    from: Address,
    params: { lobbyId: Hash; attackId: string; defensePoint: DefensePoint },
  ) => Promise<unknown>
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

/**
 * Integer submit at the progress this point sits on. A geometric point at
 * an arbitrary progress can miss the snapshot when the epoch is short:
 * the threat only exists at `submit`, and that instant may sit more than
 * `interceptionRadius` away from a chosen progress. Iterating onto the
 * threat at that submit is what makes a timed test a hit rather than a
 * near miss.
 */
export function timedDefensePlacement(input: {
  point: DefensePoint
  world: WorldGeometry
  launchBlock: number
  flightBlocks: number
  trajectory: AttackTrajectory
  defenseSpeedKmPerBlock: number
}): { point: DefensePoint; submitBlock: number } {
  const impact = input.launchBlock + input.flightBlocks
  const lastSubmit = Math.max(input.launchBlock, impact - 1)
  const desired = defensePointToWorld(input.point, input.world)
  const approach = closestApproach(desired, input.trajectory.pointA, input.trajectory.pointB)
  let t = clamp(approach.t, 0, 0.999)
  let submitBlock = input.launchBlock
  let point = input.point

  for (let i = 0; i < 6; i++) {
    const worldPoint = positionAtProgress(input.trajectory, t)
    point = worldToDefensePoint(worldPoint, input.world)
    const climb = interceptorArrivalBlock(worldPoint, input.world, 0, input.defenseSpeedKmPerBlock)
    const pass = input.launchBlock + t * input.flightBlocks
    submitBlock = Math.round(pass - climb)
    submitBlock = clamp(submitBlock, input.launchBlock, lastSubmit)
    const arrival = submitBlock + climb
    t = clamp((arrival - input.launchBlock) / Math.max(1, input.flightBlocks), 0, 0.999)
  }

  return { point, submitBlock }
}

/**
 * Advance to the submit block when the threat would pass this point, then
 * send the defense.
 */
export async function submitTimedDefenseAttempt(
  client: DefenseClient,
  from: Address,
  params: {
    lobbyId: Hash
    attackId: string
    defensePoint: DefensePoint
    trajectory: AttackTrajectory
    world: WorldGeometry
    launchBlock: number
    flightBlocks: number
    defenseSpeedKmPerBlock: number
  },
): Promise<void> {
  const { point, submitBlock } = timedDefensePlacement({
    point: params.defensePoint,
    world: params.world,
    launchBlock: params.launchBlock,
    flightBlocks: params.flightBlocks,
    trajectory: params.trajectory,
    defenseSpeedKmPerBlock: params.defenseSpeedKmPerBlock,
  })
  const now = await client.getBlockNumber()
  if (submitBlock > now) client.advanceBlocks(submitBlock - now)
  await client.submitDefense(from, {
    lobbyId: params.lobbyId,
    attackId: params.attackId,
    defensePoint: point,
  })
}
