import { normalizeDegrees, offsetAcrossInbound, sectorsInCone, ATTACK_BIAS_MICRO_RAD, BASE_CONE_DEGREES } from '../../game/recon'
import { createSeededRandom, deriveSeed } from '../../game/randomness'
import type { Address, Hash, MapGridConfig, Point2D, ReconProbeRecord } from '../../game/types'
import { bearingLabel, pointOnEarthSurface, rayExitFromEarth, type WorldGeometry } from '../../game/world'
import { microRadToRad } from './codec'

/** Low 32 bits of a packed hint hold noisy θ; the next 32 hold noisy δ. */
export const HINT_LIMB = 2 ** 32

/**
 * Turning the confidential network's answer into a Recon Probe reading
 * (ТЗ §3).
 *
 * What comes back from the decryption is one integer: noisy launch bearing
 * θ and noisy impact offset δ packed as `δ << 32 | θ`, both in
 * microradians, both computed inside the confidential layer on ciphertext.
 * This function does the only things the browser is entitled to do with it
 * — unpack, recentre, reconstruct the chord, and sample it at the public
 * flight progress of the send block.
 *
 * Recentring is not reconstruction: the noise windows are published
 * protocol parameters, so subtracting their midpoints recovers *the noisy
 * estimate the protocol released*, not the value it withheld. The cell-noise
 * midpoint cancels in the average of many cells; the bias midpoint does
 * not, because ε is drawn once per attack and only on θ. Nothing here
 * narrows the estimate closer to the truth than the probe was told.
 */
export function decodeProbeHint(params: {
  /** The decrypted hint: packed `δ_noisy << 32 | θ_noisy`, in microradians. */
  hint: bigint
  /** Half-width of one draw's cell-noise window, in microradians. */
  coneMicroRad: number
  /** 0..1 through the flight at the probe's send block. */
  flightProgress: number
  probeIndex: number
  lobbyId: Hash
  attackId: string
  probeId: string
  requestedBy: Address
  txHash: Hash
  generatedAtBlock: number
  world: WorldGeometry
  grid: MapGridConfig
}): ReconProbeRecord {
  const { coneMicroRad, world } = params
  const { thetaLimb, deltaLimb } = unpackProbeHint(params.hint)

  // Two uniform draws over [0, cone] sum to a triangular distribution
  // centred on `cone`; the attack bias is the same shape centred on
  // `ATTACK_BIAS_MICRO_RAD`. Removing both midpoints leaves an estimate
  // centred on θ + (ε − B), i.e. on the biased bearing, not on the truth.
  // δ has cell noise only — no shared ε — so farms cannot average onto
  // the true chord.
  const thetaRawMicro = thetaLimb - coneMicroRad - ATTACK_BIAS_MICRO_RAD
  const theta = microRadToRad(thetaRawMicro - MAX_LAUNCH_OFFSET_MICRO_RAD)

  // Scene convention: angles run from +x with y downward, so straight up
  // out of the planet is -π/2 and θ is measured from there.
  const bearingRadians = -Math.PI / 2 + theta
  const coneRadians = microRadToRad(coneMicroRad)

  /*
   * An engine from before the packed hint answers with θ alone, so the δ
   * limb is zero — a value the current engine cannot produce, since it
   * offsets δ by `MAX_IMPACT_DELTA_MICRO_RAD` before adding noise.
   *
   * Recentring a zero limb yields a confident −55°, and the map would then
   * draw a chord and a snapshot the probe never reported: on an operation
   * that started under the old engine the corridor sat one fixed angle off
   * the truth, which is the trajectory landing outside its own scan. A
   * reading that carries no δ says so, and the picture widens to the whole
   * approach window instead of inventing one.
   */
  const impactAngle = deltaLimb === 0 ? null : bearingRadians + impactOffset(deltaLimb, coneMicroRad)
  const markRng = createSeededRandom(deriveSeed([params.txHash, 'recon-mark', params.probeIndex]))
  const mark =
    impactAngle === null
      ? undefined
      : snapshotAtProgress(bearingRadians, impactAngle, params.flightProgress, world, markRng)

  return {
    bearingDegrees: normalizeDegrees((bearingRadians * 180) / Math.PI),
    direction: bearingLabel(bearingRadians),
    impactBearingDegrees: impactAngle === null ? undefined : normalizeDegrees((impactAngle * 180) / Math.PI),
    uncertaintyDegrees:
      params.probeIndex <= 1 ? BASE_CONE_DEGREES : (coneRadians * 180) / Math.PI,
    // A display figure, and the same one for every reading: a probe knows
    // how wide its own error bar is and nothing about whether it got lucky.
    confidencePercent: 40,
    sectorIds: sectorsInCone(bearingRadians, coneRadians, world),
    generatedAtBlock: params.generatedAtBlock,
    epochId: 0,
    id: `${params.attackId}-${params.requestedBy.toLowerCase()}-${params.probeIndex}`,
    lobbyId: params.lobbyId,
    attackId: params.attackId,
    probeId: params.probeId,
    requestedBy: params.requestedBy,
    txHash: params.txHash,
    mark,
  }
}

function impactOffset(deltaLimb: number, coneMicroRad: number): number {
  return microRadToRad(deltaLimb - coneMicroRad - MAX_IMPACT_DELTA_MICRO_RAD)
}

export function packProbeHint(thetaLimb: number, deltaLimb: number): bigint {
  return BigInt(deltaLimb) * BigInt(HINT_LIMB) + BigInt(thetaLimb)
}

export function unpackProbeHint(hint: bigint): { thetaLimb: number; deltaLimb: number } {
  const limb = BigInt(HINT_LIMB)
  return {
    thetaLimb: Number(hint % limb),
    deltaLimb: Number(hint / limb),
  }
}

function snapshotAtProgress(
  launchBearing: number,
  impactAngle: number,
  flightProgress: number,
  world: WorldGeometry,
  rng: () => number,
): Point2D {
  const from = rayExitFromEarth(launchBearing, world)
  const to = pointOnEarthSurface(impactAngle, world)
  const t = Math.min(1, Math.max(0, flightProgress))
  const onChord = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
  return offsetAcrossInbound(onChord, from, to, rng, world)
}

/**
 * `Geometry.MAX_LAUNCH_OFFSET_MICRO_RAD` — how far off vertical a launch
 * bearing may be drawn (±60°), and therefore the offset the confidential
 * layer shifts θ by to keep it non-negative.
 *
 * It is a protocol constant on both sides. Duplicating it here rather than
 * reading it per call is safe because it is compiled into the deployed
 * geometry library, not stored: a change to it is a new deployment, which
 * regenerates this frontend's contract config anyway.
 */
export const MAX_LAUNCH_OFFSET_MICRO_RAD = 1_047_198

/** `Geometry.MAX_IMPACT_DELTA_MICRO_RAD` — same reason as the launch offset. */
export const MAX_IMPACT_DELTA_MICRO_RAD = 959_931
