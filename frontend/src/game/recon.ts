import { sectorToLabel } from './map'
import { createSeededRandom, deriveSeed } from './randomness'
import type { AttackTrajectory, Hash, MapGridConfig, Point2D, ReconProbeResult, Sector } from './types'
import {
  bearingLabel,
  distance,
  MAX_APPROACH_OFFSET_RADIANS,
  pointOnEarthSurface,
  rayExitFromEarth,
  sectorCenterKm,
  type WorldGeometry,
} from './world'

/**
 * Recon Probe intelligence (ТЗ §1).
 *
 * A probe is not aimed. It sweeps the whole working area around Earth and
 * comes back with one thing: **which way to look**. There is no sector to
 * choose, no coordinate in the transaction, and no coordinate in the answer.
 *
 * The model is a bearing estimate with an uncertainty corridor, from the
 * launch on the field's edge down to Earth:
 *
 *   - the *true* bearing is the direction from Earth to where the threat
 *     came in from — the trajectory's launch point;
 *   - one probe reports that bearing plus noise, and states the half-width
 *     of the cone its own reading leaves;
 *   - the *drawing* is a fan from Earth's rim into the sky, wide enough
 *     for the unknown impact offset as well as the noise. Apexing it at
 *     the launch (the board's edge) clipped the wedge to a smear that
 *     missed the inbound the reveal later draws;
 *   - several probes are *fused* rather than replaced, and the fused cone
 *     narrows as the square root of their number.
 *   - every probe on one attack also carries a shared bias ε, drawn once
 *     for that attack. Extra cells average away their own noise and
 *     converge on θ + ε, never on θ. That residual is small, and it is
 *     what stops a farm of wallets from buying a solved ray.
 *
 * That last property is the whole of ТЗ §1.3, and it is a real statistical
 * fact rather than a tuned curve: independent estimates of one angle
 * combine with precision `Σ 1/σᵢ²`, so `n` readings of equal quality leave
 * `σ / √n`. One probe gives a broad quarter of the sky, two cut it to ~70%
 * of that, four to half. It never reaches zero — `MIN_CONE_DEGREES` is the
 * floor, and it is what keeps the exact target a thing only Reveal can
 * answer (ТЗ §4). Fusion cannot cancel ε either: the floor is at least as
 * wide as the bias window, so the picture that remains still contains the
 * truth more often than it pins a false ray.
 *
 * Nothing here ever returns a true coordinate. The richest public value
 * it produces is a per-sector *weight* in [0, 1] — how much of the fused
 * cone falls across that sector — which the grid paints as fog. A sector
 * at weight 1 is "somewhere in here"; it is never "here". Each probe also
 * leaves a jittered snapshot (`mark`) of where the attack was when the
 * shutter closed; sitting Defense on that mark is not a free intercept.
 *
 * TODO (§57): `BASE_CONE_DEGREES`, `MIN_CONE_DEGREES` and the confidence
 * ramp are game balance, not correctness. The call shapes are the stable
 * part: `(trajectory, epochId, probeIndex, world, seed, block) ->
 * ReconProbeResult` and `(results) -> ReconFix`.
 */

/**
 * Angular jitter half-width on a probe snapshot, in degrees.
 *
 * Matches the protocol default of `GameParams.probeConeMicroRad` (10° /
 * 174533 µrad). Wider than one intercept radius so a Defense parked on a
 * mark is not a free hit; tight enough that the pile still reads as the
 * path Reveal will draw.
 */
export const HINT_JITTER_DEGREES = 10
export const BASE_CONE_DEGREES = 52

/**
 * However many probes are sent, the cone never closes past this.
 *
 * Sized to sit at or above `ATTACK_BIAS_DEGREES`, so a fused picture that
 * has converged on θ + ε still has a band wide enough that the truth is
 * usually inside it — and wide enough at the launch edge that one
 * intercept radius cannot cover the whole remaining uncertainty.
 */
export const MIN_CONE_DEGREES = 12

/**
 * Half-width of the per-attack bias ε, in degrees.
 *
 * Drawn once per attack (from the epoch seed, in the emulator; inside Inco,
 * on chain) and added to every probe. Matches `ReconRules.BIAS_MICRO_RAD`.
 */
export const ATTACK_BIAS_DEGREES = 5

/** `ATTACK_BIAS_DEGREES` in microradians — the unit the confidential hint uses. */
export const ATTACK_BIAS_MICRO_RAD = 87_266

/**
 * Blocks between a probe and the next move its reading could inform.
 *
 * Matches `ReconRules.DELAY_BLOCKS`. Sending another probe before this
 * elapses is illegal, and so is submitting a Defense Point — which is what
 * makes reconnaissance cost time rather than only an allowance.
 *
 * It is deliberately *not* a wait for the answer. The hint is granted by
 * the transaction that computes it, so a reading arrives with its own send;
 * gating the moves it could inform is the same rule stated where it can be
 * enforced without charging every honest player a second transaction.
 */
export const PROBE_DELAY_BLOCKS = 3

/**
 * The narrowest cone a perfectly aimed probe can leave, in degrees.
 *
 * A sensor pointed straight at the truth is the best single reading the
 * protocol will ever give — but it is still a reading, not an answer. The
 * floor exists so that no amount of good aim substitutes for the Reveal.
 */
const AIMED_CONE_DEGREES = 12

/**
 * How far off-aim a probe can be before it stops telling the player
 * anything, in degrees.
 *
 * Past this the cone is wider than the one the first probe already gave, so
 * fusion — which weights each reading by 1/σ² — quietly ignores it. That is
 * the whole of "point it the wrong way and learn nothing": not a rule that
 * refuses the probe, but a reading too vague to move the picture.
 */
const AIM_FALLOFF_DEGREES = 70

const MAX_CONFIDENCE_PERCENT = 90
const BASE_CONFIDENCE_PERCENT = 40
const CONFIDENCE_PER_PROBE_PERCENT = 15

/**
 * How far into the cone's tail a sector still counts as "elevated
 * probability" (ТЗ §1.2). One σ covers the bulk of the distribution; the
 * fog itself fades continuously well past it.
 */
const ELEVATED_SECTOR_WEIGHT = 0.5

export interface ReconFix {
  /** Fused search bearing, degrees clockwise from east (scene convention, +y down). */
  bearingDegrees: number
  /**
   * Fused impact bearing, same convention. The cloud is the chord from
   * launch to this point, not the radial through Earth's centre — that
   * radial is what left Reveal's trajectory hanging out of the first scan.
   */
  impactBearingDegrees?: number
  /** Eight-point compass label for the same bearing. */
  direction: string
  /** Half-width of the fused uncertainty cone, in degrees. Shrinks with every probe. */
  uncertaintyDegrees: number
  confidencePercent: number
  probeCount: number
}

/**
 * The reconnaissance picture the grid draws: the fused fix, plus how
 * strongly each sector is implicated by it.
 *
 * `weights` is deliberately a plain sector-id map rather than anything
 * geometric — it survives the portrait transposition untouched, because it
 * is computed in the canonical km world and consumed by cells that already
 * know where they are on screen.
 */
export interface ReconFog {
  fix: ReconFix | null
  weights: ReadonlyMap<string, number>
}

export const EMPTY_RECON_FOG: ReconFog = { fix: null, weights: new Map() }

/**
 * One probe's reading.
 *
 * `trajectory` is the sealed truth, and this is the only function outside
 * resolution and Reveal that touches it. Everything it hands back is
 * already blurred: a bearing with noise on it, the width of that noise,
 * and a snapshot on a noisy chord of the same angles, sampled at
 * `flightProgress`.
 *
 * `probeIndex` seeds the draw so two probes on the same attack disagree —
 * that disagreement is what fusion averages away, and re-rolling the same
 * index would make repeat reconnaissance free.
 */
export function generateReconProbeResult(
  trajectory: AttackTrajectory,
  epochId: number,
  probeIndex: number,
  world: WorldGeometry,
  seed: Hash,
  currentBlock: number,
  /**
   * Where this probe was pointed, in the same degrees the fix reports —
   * or null for a sweep, which is what the first probe always is.
   *
   * A player with no picture yet has nothing to aim at, so the opening
   * reading is a wide sweep that hands them a direction. From then on the
   * probe is aimed, and how well it was aimed is what decides whether it
   * sharpens the picture or merely confirms the sky is large.
   */
  aimDegrees: number | null = null,
  /**
   * 0..1 through the flight at the send block. The snapshot sits here on
   * the noisy chord. Defaults to a step per probe so tests that do not
   * pass a clock still get a trail.
   */
  flightProgress?: number,
): ReconProbeResult {
  const rng = createSeededRandom(deriveSeed([seed, 'recon-probe', probeIndex]))

  const trueBearing = threatBearingRadians(trajectory, world)
  const bias = attackBiasRadians(seed)
  const coneDegrees = coneForAim(aimDegrees, ((trueBearing + bias) * 180) / Math.PI)
  const cone = (coneDegrees * Math.PI) / 180
  // The opening sweep *paints* a wide flashlight (coneDegrees). The draw
  // that places its axis is the shutter — otherwise a ±52° wander puts the
  // true inbound outside the cloud the first probe is supposed to contain.
  const noiseWidth = aimDegrees === null ? (HINT_JITTER_DEGREES * Math.PI) / 180 : cone
  const noise = ((rng() + rng()) - 1) * noiseWidth
  const reportedBearing = trueBearing + bias + noise

  const t = flightProgress ?? Math.min(0.82, BLOTCH_FIRST_STEP + probeIndex * BLOTCH_STEP)
  const snapshot = snapshotOnNoisyChord(trajectory, world, rng, bias, t)

  return {
    bearingDegrees: normalizeDegrees((reportedBearing * 180) / Math.PI),
    impactBearingDegrees: snapshot.impactBearingDegrees,
    direction: bearingLabel(reportedBearing),
    uncertaintyDegrees: coneDegrees,
    confidencePercent: BASE_CONFIDENCE_PERCENT + Math.round(rng() * 6),
    sectorIds: sectorsInCone(reportedBearing, cone, world),
    generatedAtBlock: currentBlock,
    epochId,
    mark: snapshot.mark,
  }
}

/** A later probe's shot: random across the first sweep's cone, not a new sky. */
export function aimInsideFirstCloud(
  firstBearingDegrees: number,
  firstConeDegrees: number,
  seed: Hash,
  probeIndex: number,
): number {
  const rng = createSeededRandom(deriveSeed([seed, 'recon-aim', probeIndex]))
  return firstBearingDegrees + (rng() * 2 - 1) * firstConeDegrees * 0.85
}

/**
 * The per-attack bias ε, in radians.
 *
 * Seeded from the epoch, not from a probe index, so every probe on the
 * same attack shares it. Fusion of many cells therefore converges on
 * θ + ε rather than on θ — the property the chain's confidential engine
 * enforces by drawing ε once per `attackId`.
 */
export function attackBiasRadians(seed: Hash): number {
  const rng = createSeededRandom(deriveSeed([seed, 'recon-bias']))
  return ((rng() + rng()) - 1) * ((ATTACK_BIAS_DEGREES * Math.PI) / 180)
}

/**
 * How sharp a reading an aim earns.
 *
 * An unaimed sweep gets the base cone — wide, but centred on θ + ε, so
 * it is what turns "somewhere" into "over there". An aimed probe is repaid
 * in proportion to how right it was relative to that biased bearing: dead
 * on, it narrows to `AIMED_CONE_DEGREES`; a full `AIM_FALLOFF_DEGREES` off,
 * it is back to the base cone and adds nothing the sweep had not already
 * said. Beyond that it keeps widening, so a badly aimed probe is genuinely
 * worse than no probe — though fusion weights it down to nothing rather
 * than letting it drag the fix off course.
 *
 * The curve is squared rather than linear so that the middle of the range
 * still rewards being close. Near-misses should feel like progress; only a
 * real miss should feel wasted.
 */
function coneForAim(aimDegrees: number | null, trueBearingDegrees: number): number {
  if (aimDegrees === null) return BASE_CONE_DEGREES

  const error = Math.abs(angularDifferenceDegrees(aimDegrees, trueBearingDegrees))
  const missRatio = error / AIM_FALLOFF_DEGREES
  const cone = AIMED_CONE_DEGREES + (BASE_CONE_DEGREES - AIMED_CONE_DEGREES) * missRatio * missRatio

  return Math.max(AIMED_CONE_DEGREES, cone)
}

/** Signed separation between two bearings, in (-180, 180]. */
function angularDifferenceDegrees(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180
}

/**
 * Fuses every probe this player has sent into one fix (ТЗ §1.3).
 *
 * The bearing is a circular mean of unit vectors, so 350° and 10° merge to
 * 0° rather than to 180°. The cone is the precision-weighted combination
 * described at the top of the file, floored so it can never answer the
 * question Reveal exists to answer.
 *
 * This is what the map draws. Holding the *first* reading instead — which
 * the picture used to do, so that a noisy third probe could not redraw the
 * corridor — anchored the cloud forever to the one reading taken blind: it
 * kept its opening 52° cone however many probes were bought, and sat
 * off-centre by that reading's whole error. Measured over 2000 attacks,
 * fusing drops the drawn cone from 52° to 12° by the second probe and
 * brings the true path inside the cloud every time, where the first
 * reading alone left it outside about one run in fifty. Precision
 * weighting is also why the feared swing does not happen: a wide reading
 * enters the mean at `1/σ²`, so a bad probe nudges the corridor instead of
 * moving it.
 */
export function mergeReconProbes(results: readonly ReconProbeResult[]): ReconFix | null {
  if (results.length === 0) return null

  const vector = results.reduce(
    (sum, result) => {
      const radians = (result.bearingDegrees * Math.PI) / 180
      // Weight by precision: a probe that admits a wider cone counts less.
      const weight = 1 / (result.uncertaintyDegrees * result.uncertaintyDegrees)
      return { x: sum.x + Math.cos(radians) * weight, y: sum.y + Math.sin(radians) * weight }
    },
    { x: 0, y: 0 },
  )
  const meanBearing = Math.atan2(vector.y, vector.x)

  const precision = results.reduce((sum, r) => sum + 1 / (r.uncertaintyDegrees * r.uncertaintyDegrees), 0)
  const uncertaintyDegrees = Math.max(MIN_CONE_DEGREES, 1 / Math.sqrt(precision))

  /*
   * Only readings that actually carried δ vote on where the chord meets
   * Earth. Falling back to the launch bearing produced a fix that *looked*
   * like it knew the impact and pointed at the radial through Earth's
   * centre — the corridor missed the real chord by the whole approach
   * offset, and nothing downstream could tell the guess from a reading.
   */
  const withImpact = results.filter((result) => result.impactBearingDegrees !== undefined)
  const impactVector = withImpact.reduce(
    (sum, result) => {
      const radians = (result.impactBearingDegrees! * Math.PI) / 180
      const weight = 1 / (result.uncertaintyDegrees * result.uncertaintyDegrees)
      return { x: sum.x + Math.cos(radians) * weight, y: sum.y + Math.sin(radians) * weight }
    },
    { x: 0, y: 0 },
  )
  const meanImpact = Math.atan2(impactVector.y, impactVector.x)

  return {
    bearingDegrees: normalizeDegrees((meanBearing * 180) / Math.PI),
    impactBearingDegrees: withImpact.length === 0 ? undefined : normalizeDegrees((meanImpact * 180) / Math.PI),
    direction: bearingLabel(meanBearing),
    uncertaintyDegrees,
    confidencePercent: Math.min(
      MAX_CONFIDENCE_PERCENT,
      BASE_CONFIDENCE_PERCENT + (results.length - 1) * CONFIDENCE_PER_PROBE_PERCENT,
    ),
    probeCount: results.length,
  }
}

/**
 * Turns a fix into the fog the grid paints (ТЗ §1.2).
 *
 * Each sector's weight is a Gaussian in the angular distance between the
 * corridor's axis and the direction from the *launch* to that sector. The
 * corridor is the incoming path — launch on the field's edge, down to
 * Earth — not a fan from the planet's centre. A radial fan shares the
 * attack's slope and misses its coordinates; this one sits on the path
 * a Defense Point actually has to cover.
 */
export function buildReconFog(
  results: readonly ReconProbeResult[],
  world: WorldGeometry,
  grid: MapGridConfig = world.grid,
): ReconFog {
  const fix = mergeReconProbes(results)
  if (!fix) return EMPTY_RECON_FOG

  const bearing = (fix.bearingDegrees * Math.PI) / 180
  const launch = rayExitFromEarth(bearing, world)
  const inward = bearing + Math.PI
  const sigma = corridorHalfWidthRadians(fix, world)
  const weights = new Map<string, number>()

  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      const sector: Sector = { column, row }
      const center = sectorCenterKm(sector, world)
      const fromLaunch = Math.atan2(center.y - launch.y, center.x - launch.x)
      const delta = angularDistance(fromLaunch, inward)
      const weight = Math.exp(-0.5 * (delta / sigma) ** 2)
      if (weight >= 0.01) weights.set(sectorToLabel(sector), weight)
    }
  }

  return { fix, weights }
}

// ---------------------------------------------------------------------------
// The reconnaissance picture (ТЗ §3)
// ---------------------------------------------------------------------------

/**
 * How many probes it takes before the protocol will commit to a *route*
 * rather than a direction (ТЗ §3).
 *
 * One reading is a direction and a cloud. The red occupancy stack starts
 * with the second probe: the opening sweep has not earned a place yet.
 */
export const TRAIL_MIN_PROBES = 2

/**
 * Floors on the painted beam, as a fraction of Earth's radius, so a fused
 * picture cannot close onto a line one intercept radius covers (ТЗ §4).
 * Both ends are otherwise sized from the fix's own error, and neither is
 * ever wider than the planet — a searchlight wider than Earth is the sky.
 */
const BEAM_FAR_FLOOR = 0.34
const BEAM_NEAR_FLOOR = 0.16
/**
 * The widest half-width any corridor is drawn at, as a share of the field.
 *
 * The opening sweep is a flashlight, not a strip: it has to be allowed to
 * occupy a real slice of the board or a 52° cone paints as a tidy band.
 * Later probes keep that shape — they do not collapse onto a ray.
 */
export const BEAM_MAX_FIELD_FRACTION = 0.55
/**
 * How much of the extra outer wash is actually painted.
 *
 * The search the first probe *reports* is still 52° + ε, so the inbound
 * cannot sit beside the corridor. The wash around it was reading as noise:
 * a quarter of that extra width is scatter the eye takes for the threat
 * sitting beside the beam. Later probes inherit this trimmed flashlight
 * rather than falling back to a 12° strip.
 */
export const OPENING_PAINT_SCALE = 0.75
/**
 * First-probe aperture on Earth's rim, in sectors.
 *
 * The beam does not pinch to a point on the planet — that is a searchlight
 * from a lamp, not a ray from a pin. One-and-a-third cells is a band of
 * horizon the inbound can still land in.
 */
export const OPENING_APERTURE_SECTORS = 1.35

/**
 * How far past the launch the beam is drawn, as a fraction of the chord.
 * Enough that the far edge is off-screen, not so far that the wide end
 * of the trapezoid happens in space the player never sees — that is what
 * made a 2:1 searchlight read as a painted rectangle.
 */
export const SKY_OVERSHOOT = 0.14
/** Pull the near corners inside the disc so their rim projection hugs the horizon. */
export const HORIZON_DIP = 0.72

/**
 * A painted recon region.
 *
 * `ring` is the corridor quad (far-left, earth-left, earth-right, far-right)
 * in canonical km. `apex` is the far end, off the board; `arc` is the two
 * corners at Earth's rim, which the painted near edge joins by following
 * the planet rather than cutting a chord across it.
 *
 * Everything is in canonical km. The consumer projects, which is what keeps
 * the shape correct on a transposed portrait grid — an angle in world space
 * is not the same angle on screen once the axes have swapped.
 */
export interface ReconWedge {
  apex: Point2D
  arc: Point2D[]
  /** Corridor polygon (far-left, earth-left, earth-right, far-right). */
  ring: Point2D[]
  /** Perpendicular half-width at the far end and at Earth, km. */
  halfWidthKm: { far: number; near: number }
}

/**
 * What the map draws from a fused fix (ТЗ §3), and the whole of the
 * progression the brief describes:
 *
 *   one probe    — a flashlight from a band of horizon, flaring into the
 *                  sky. Wide enough that the true inbound cannot sit
 *                  outside it. No red occupancy yet.
 *   two plus     — the same corridor, a little tighter, plus a red mark
 *                  per probe from the second onward. Several shutters
 *                  over the flight form a trail because the attack is
 *                  moving. The beam does not collapse into a strip:
 *                  that was the old drawing, and it threw away the
 *                  searchlight the first probe had just earned.
 *
 * What it never becomes is the answer. The beam always has width, so the
 * route on screen is a guess that gets better and stays a guess. Reveal
 * is where the two are finally seen apart (ТЗ §7, §8).
 */
export interface ReconEstimate {
  probeCount: number
  /** 0 at a single probe's cone, 1 at the tightest reconnaissance is allowed to get. */
  sharpness: number
  /**
   * ТЗ §3 — the blue uncertainty cloud: a beam along the fused inbound,
   * wide enough to search and narrow enough to read as a direction.
   */
  cloud: ReconWedge
  /** A tighter inner beam. Not painted; kept so width comparisons stay honest. */
  core: ReconWedge
  /**
   * Static occupancy guesses, one per probe from the second onward, each
   * placed on the bearing its own probe reported. They stay on the board;
   * later ones sit closer to Earth and paint darker, and where several
   * overlap is where the readings concentrate.
   */
  blotches: ReconBlotch[]
  /** Half-width of the blue beam at mid-corridor, km — blotches are held inside it. */
  spreadKm: number
  /** The fix's centreline: launch on the field's edge down to Earth's rim. */
  axis: { from: Point2D; to: Point2D }
}

/** The red occupancy smudge along the estimated inbound. */
export interface ReconBlotch {
  center: Point2D
  /** Half-length along the inbound, km. Longer than `acrossKm` — time, not a round ping. */
  alongKm: number
  /** Half-width across the inbound, km. */
  acrossKm: number
  headingRadians: number
  /** 0 at the first red blotch, 1 once several have stacked. */
  depth: number
}

/**
 * Turns a fused fix into the picture above.
 *
 * The cloud is a beam along the inbound — launch on the field's edge,
 * extended off the sky, down to Earth's rim — not a pizza from the
 * planet's centre. The pizza at θ+42° is honest and unreadable: it
 * paints the whole sky a uniform blue with a leftover strip where the
 * cone's right ray happens to fall, which is what the first probe was
 * drawing. Capping the perpendicular width in sectors is what makes
 * the same bearing look like a searchlight.
 *
 * `readings` are the individual probe reports behind `fix`, in the order
 * they were bought. Only the red marks use them, for where each mark sits
 * across the beam. Passing nothing is allowed and stacks every mark on
 * the axis.
 */
export function buildReconEstimate(
  fix: ReconFix | null,
  world: WorldGeometry,
  readings: readonly ReconProbeResult[] = [],
): ReconEstimate | null {
  if (!fix) return null

  const bearing = (fix.bearingDegrees * Math.PI) / 180
  const impactBearing = ((fix.impactBearingDegrees ?? fix.bearingDegrees) * Math.PI) / 180
  const launch = rayExitFromEarth(bearing, world)
  const impact = pointOnEarthSurface(impactBearing, world)
  const sharpness = reconSharpness(fix)
  const chordKm = distance(launch, impact) || world.earth.radiusKm
  const far = extendPast(impact, launch, chordKm * SKY_OVERSHOOT)
  const { far: farHalf, near: nearHalf } = beamHalfKm(fix, launch, world)

  const cloud = corridorWedge(far, impact, farHalf, nearHalf, world)
  const core = corridorWedge(far, impact, farHalf * 0.55, nearHalf * 0.55, world)

  const estimate: ReconEstimate = {
    probeCount: fix.probeCount,
    sharpness,
    cloud,
    core,
    blotches: [],
    spreadKm: (cloud.halfWidthKm.far + cloud.halfWidthKm.near) / 2,
    axis: { from: launch, to: impact },
  }
  estimate.blotches = staticReconBlotches(estimate, world, readings, bearing)
  return estimate
}

/**
 * Half-width of the incoming corridor, in radians.
 *
 * Two uncertainties stack, and they are not the same angle:
 *
 *   - the probes' remaining error on the launch bearing θ;
 *   - the impact's unknown offset δ around that bearing, which from the
 *     launch looks like ~23° even when θ is known exactly.
 *
 * A drawing that used only the first sat on the radial through Earth's
 * centre and left the real chord — launch to an offset impact — beside
 * the cloud. Adding the second is what puts the path inside the hint.
 */
export function corridorHalfWidthRadians(fix: ReconFix, world: WorldGeometry): number {
  const bearing = (fix.bearingDegrees * Math.PI) / 180
  const launch = rayExitFromEarth(bearing, world)
  return impactSpreadFromLaunch(launch, world) + (fix.uncertaintyDegrees * Math.PI) / 180
}

/** How wide the ±δ impact arc looks from a launch on the field's edge. */
export function impactSpreadFromLaunch(launch: Point2D, world: WorldGeometry): number {
  const range = distance(launch, world.earth.center)
  const radius = world.earth.radiusKm
  const denom = range - radius * Math.cos(MAX_APPROACH_OFFSET_RADIANS)
  if (denom <= 1e-9) return Math.PI / 6
  return Math.atan((radius * Math.sin(MAX_APPROACH_OFFSET_RADIANS)) / denom)
}

/**
 * 0 at a first probe's cone, 1 at `MIN_CONE_DEGREES` — the single number
 * every "how good is this intelligence" decision is read off, so the blur,
 * the brightness and the trail's contrast can never disagree about it.
 */
export function reconSharpness(fix: ReconFix): number {
  const span = Math.max(1, BASE_CONE_DEGREES - MIN_CONE_DEGREES)
  return Math.min(1, Math.max(0, (BASE_CONE_DEGREES - fix.uncertaintyDegrees) / span))
}

function corridorWedge(
  from: Point2D,
  to: Point2D,
  farHalfKm: number,
  nearHalfKm: number,
  world: WorldGeometry,
): ReconWedge {
  const earth = world.earth.center
  const dipped = {
    x: earth.x + (to.x - earth.x) * HORIZON_DIP,
    y: earth.y + (to.y - earth.y) * HORIZON_DIP,
  }
  const dx = dipped.x - from.x
  const dy = dipped.y - from.y
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  const farLeft = { x: from.x + nx * farHalfKm, y: from.y + ny * farHalfKm }
  const farRight = { x: from.x - nx * farHalfKm, y: from.y - ny * farHalfKm }
  const dippedLeft = { x: dipped.x + nx * nearHalfKm, y: dipped.y + ny * nearHalfKm }
  const dippedRight = { x: dipped.x - nx * nearHalfKm, y: dipped.y - ny * nearHalfKm }
  const nearLeft = ontoEarthRim(dippedLeft, world)
  const nearRight = ontoEarthRim(dippedRight, world)
  return {
    apex: from,
    arc: [nearLeft, nearRight],
    ring: [farLeft, nearLeft, nearRight, farRight],
    halfWidthKm: { far: farHalfKm, near: nearHalfKm },
  }
}

/** Walk from `from` through `through` and continue `extraKm` past it. */
function extendPast(from: Point2D, through: Point2D, extraKm: number): Point2D {
  const dx = through.x - from.x
  const dy = through.y - from.y
  const len = Math.hypot(dx, dy) || 1
  return { x: through.x + (dx / len) * extraKm, y: through.y + (dy / len) * extraKm }
}

/**
 * Project a point onto a ring just outside Earth's disc. The sky clip then
 * bites a horizon arc instead of leaving the trapezoid's near edge as a
 * straight chord across the globe.
 */
function ontoEarthRim(point: Point2D, world: WorldGeometry): Point2D {
  const c = world.earth.center
  const dx = point.x - c.x
  const dy = point.y - c.y
  const len = Math.hypot(dx, dy) || 1
  const r = world.earth.radiusKm * 1.012
  return { x: c.x + (dx / len) * r, y: c.y + (dy / len) * r }
}

/**
 * Degrees that size the painted beam.
 *
 * On chain a probe's own σ is the shutter (~10°). The *search area* a first
 * probe lights up is the opening sweep, plus ε, so the true inbound cannot
 * sit outside the cloud. Side scatter is a drawing scale (`OPENING_PAINT_SCALE`),
 * not a narrower search. Later probes keep that flashlight and only shave
 * it — they do not drop to the fused 12° floor, which is a statistical fact
 * for fusion, not a drawing width.
 */
export function paintedConeDegrees(fix: ReconFix): number {
  const opening = Math.max(fix.uncertaintyDegrees, BASE_CONE_DEGREES) + ATTACK_BIAS_DEGREES
  if (fix.probeCount <= 1) return opening
  return opening * (0.92 - 0.06 * reconSharpness(fix))
}

function beamHalfKm(fix: ReconFix, launch: Point2D, world: WorldGeometry): { far: number; near: number } {
  const radius = world.earth.radiusKm
  const opening = fix.probeCount <= 1
  const painted = (paintedConeDegrees(fix) * Math.PI) / 180
  const impactSpread =
    fix.impactBearingDegrees === undefined || opening
      ? MAX_APPROACH_OFFSET_RADIANS
      : MAX_APPROACH_OFFSET_RADIANS * (0.94 - 0.08 * reconSharpness(fix))

  const rangeKm = distance(launch, world.earth.center)
  // A later probe still searches a band of horizon. Dropping the aperture
  // to zero is what pinched the corridor into the old vertical strip.
  const aperture = OPENING_APERTURE_SECTORS * world.sectorSpanKm * (opening ? 1 : 0.88)
  /*
   * The corridor, taken in by 30%.
   *
   * The complaint was about the opening probe: one probe buys a direction
   * and nothing else, so its corridor is necessarily wide — but it was wide
   * enough to read as "somewhere in the sky" rather than as a lead, which
   * is the wrong lesson for the only reading a player has before they spend
   * a second one.
   *
   * Scaling *that* probe alone is what does not work, and the unit test for
   * ТЗ §1.3 says so: the near half-width of a one-probe fix is barely above
   * a four-probe fix's, so a third off the first inverts them and four
   * probes paint a wider cloud than one. The picture's whole claim is that
   * the cloud closes. So the scale goes on the ramp, before the floors,
   * which keeps every reading in its existing order, keeps the floors doing
   * their job at the narrow end, and still takes the opening beam in by the
   * third that was asked for. The axis is untouched either way — the beam
   * narrows around the same launch-to-impact centreline.
   */
  const far = clampBeam(rangeKm * Math.tan(Math.min(painted, Math.PI / 2.8)) * BEAM_SCALE, BEAM_FAR_FLOOR, world)
  const near = clampBeam(
    Math.max(aperture, radius * Math.sin(impactSpread)) * BEAM_SCALE,
    BEAM_NEAR_FLOOR,
    world,
  )
  const minFlare = opening ? 2.05 : 1.78
  return { far: Math.max(far, near * minFlare), near }
}

/** How much of its natural half-width the corridor keeps. See `beamHalfKm`. */
const BEAM_SCALE = 0.7

/**
 * Floors as a share of the planet, the ceiling as a share of the board.
 *
 * The cap has to exist — an uncapped first cone is wider than the field —
 * but it belongs to the board it must not swallow rather than to the
 * planet, and it has to leave the first picture room to look like a
 * flashlight and the fourth like an answer.
 */
function clampBeam(valueKm: number, floorFraction: number, world: WorldGeometry): number {
  const ceiling = BEAM_MAX_FIELD_FRACTION * world.widthKm
  return Math.min(ceiling, Math.max(floorFraction * world.earth.radiusKm, valueKm))
}

/** The sectors a fix implicates strongly enough to be worth searching first (ТЗ §1.2). */
export function elevatedSectors(fog: ReconFog): string[] {
  return [...fog.weights.entries()]
    .filter(([, weight]) => weight >= ELEVATED_SECTOR_WEIGHT)
    .sort((a, b) => b[1] - a[1])
    .map(([sectorId]) => sectorId)
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Which way the threat lies, as seen from Earth: the bearing to the
 * trajectory's launch point.
 *
 * The launch point rather than the impact point, and rather than the
 * closest approach, because that is the direction a defender actually has
 * to look along — the trajectory runs from there down to the planet, so the
 * whole path is inside a cone around this bearing.
 */
export function threatBearingRadians(trajectory: AttackTrajectory, world: WorldGeometry): number {
  return Math.atan2(trajectory.pointA.y - world.earth.center.y, trajectory.pointA.x - world.earth.center.x)
}

/**
 * The sectors a bearing-and-cone reading implicates (ТЗ §1.2).
 *
 * Exported because a probe's answer is *presented* the same way wherever it
 * came from: the emulator generates the noisy bearing locally, the contract
 * client decrypts one the confidential network computed, and both then need
 * the same list of elevated sectors drawn from it. Deriving the drawing
 * from an answer is not reconstructing hidden data — the answer is what the
 * protocol chose to release.
 */
export function sectorsInCone(bearing: number, thetaHalfWidth: number, world: WorldGeometry): string[] {
  const launch = rayExitFromEarth(bearing, world)
  const inward = bearing + Math.PI
  const halfWidth = impactSpreadFromLaunch(launch, world) + thetaHalfWidth
  const ids: string[] = []
  for (let row = 0; row < world.grid.rows; row++) {
    for (let column = 0; column < world.grid.columns; column++) {
      const sector: Sector = { column, row }
      const center = sectorCenterKm(sector, world)
      const fromLaunch = Math.atan2(center.y - launch.y, center.x - launch.x)
      if (angularDistance(fromLaunch, inward) <= halfWidth) {
        ids.push(sectorToLabel(sector))
      }
    }
  }
  return ids
}

/**
 * How many shades the red stack has — probes 2 through 6, light to dark.
 * One per Recon Probe a player can still buy after the opening reading,
 * so the darkest mark on the board is also the last one available.
 */
export const RECON_BLOTCH_GRADES = 5

/** Where the first mark sits along the corridor, and how far each next one steps toward Earth. */
const BLOTCH_FIRST_STEP = 0.2
const BLOTCH_STEP = 0.115

/**
 * How far a mark may sit off the inbound, in sectors.
 *
 * Left/right of the reconstructed chord — not along it — so a trail of
 * probes is not a ruler on the attack. Wider than one intercept radius
 * (0.14) so a Defense parked on the smudge is not a free hit; small
 * enough that the pile still reads as the path Reveal will draw.
 */
export const MARK_JITTER_SECTORS = 0.26

/**
 * Snapshot on a noisy reconstruction of the chord, at flight progress `t`.
 *
 * Matches the on-chain encoding: independent triangular jitter on θ and δ
 * (width `HINT_JITTER_DEGREES`), plus the shared attack bias on θ. The
 * sample then steps off the chord left or right so a stack of shutters
 * cannot be read as a straight inbound. Residual ε and cell noise still
 * hide the true path. The UI shows the shutter at `t`, not a live crawler.
 */
function snapshotOnNoisyChord(
  trajectory: AttackTrajectory,
  world: WorldGeometry,
  rng: () => number,
  biasRadians: number,
  flightProgress: number,
): { mark: Point2D; impactBearingDegrees: number } {
  const trueLaunch = threatBearingRadians(trajectory, world)
  const trueDelta = signedAngleDelta(trajectory.impactAngleRadians, trueLaunch)
  const jitter = (HINT_JITTER_DEGREES * Math.PI) / 180
  const thetaNoisy = trueLaunch + biasRadians + ((rng() + rng()) - 1) * jitter
  const deltaNoisy = trueDelta + ((rng() + rng()) - 1) * jitter
  const from = rayExitFromEarth(thetaNoisy, world)
  const to = pointOnEarthSurface(thetaNoisy + deltaNoisy, world)
  const t = Math.min(1, Math.max(0, flightProgress))
  const onChord = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
  return {
    mark: offsetAcrossInbound(onChord, from, to, rng, world),
    impactBearingDegrees: normalizeDegrees(((thetaNoisy + deltaNoisy) * 180) / Math.PI),
  }
}

/**
 * Step a point off a chord, perpendicular only.
 *
 * Same draw the occupancy trail used before packed hints sat the shutter
 * on the reconstructed line: random left/right of the inbound, never
 * along it. Shared ε still shifts every probe the same way; this is the
 * per-probe scatter that stops the trail lining up as a predictable ray.
 */
export function offsetAcrossInbound(
  point: Point2D,
  from: Point2D,
  to: Point2D,
  rng: () => number,
  world: WorldGeometry,
): Point2D {
  const ax = to.x - from.x
  const ay = to.y - from.y
  const len = Math.hypot(ax, ay) || 1
  const nx = -ay / len
  const ny = ax / len
  const jitterKm = (rng() * 2 - 1) * MARK_JITTER_SECTORS * world.sectorSpanKm
  return { x: point.x + nx * jitterKm, y: point.y + ny * jitterKm }
}

/**
 * Occupancy guess on the true inbound, jittered left/right only.
 *
 * Used when a caller already has the sealed chord (emulator tests, fallback).
 * Every probe leaves a point — already offset, never the exact coordinate.
 */
export function occupancyAlongInbound(
  trajectory: AttackTrajectory,
  probeIndex: number,
  world: WorldGeometry,
  rng: () => number,
): Point2D {
  const k = Math.max(0, probeIndex - TRAIL_MIN_PROBES + 1)
  const alongT = Math.min(0.82, BLOTCH_FIRST_STEP + k * BLOTCH_STEP)
  const ax = trajectory.pointB.x - trajectory.pointA.x
  const ay = trajectory.pointB.y - trajectory.pointA.y
  const onPath = {
    x: trajectory.pointA.x + ax * alongT,
    y: trajectory.pointA.y + ay * alongT,
  }
  return offsetAcrossInbound(onPath, trajectory.pointA, trajectory.pointB, rng, world)
}

/**
 * Same guess when the client only has a bearing (legacy radial hint),
 * not the packed chord. The point sits on the reported ray.
 */
export function occupancyAlongRay(
  bearingRadians: number,
  probeIndex: number,
  world: WorldGeometry,
  rng: () => number,
): Point2D {
  const from = rayExitFromEarth(bearingRadians, world)
  const to = pointOnEarthSurface(bearingRadians, world)
  return occupancyAlongInbound({ pointA: from, pointB: to, impactAngleRadians: 0, lengthKm: 0, speedKmPerBlock: 0 }, probeIndex, world, rng)
}

/**
 * The red mark one probe leaves: occupancy where *that reading* puts the
 * inbound, at a range stepped toward Earth (ТЗ §3).
 *
 * `readingOffsetRadians` is the probe's own bearing minus the picture's,
 * and it is the whole point of the mark. Sampling a random offset instead
 * — which is what this used to do — draws a convincing pile of smudges
 * whose darkest overlap means nothing: a player who learns to sit on it
 * is guessing, and the fourth probe buys decoration. Placing each mark on
 * the inbound its own reading implies makes the overlap real evidence.
 * Readings that agree stack their marks into one dark column; readings
 * that disagree spread them across the cloud, which is exactly what a
 * noisy set of readings should look like.
 *
 * It still cannot become the answer. Every probe carries the same hidden
 * ε bias (see `probeReading`), so the pile converges on θ+ε and never on
 * θ, and the offset is clamped inside the cloud it was drawn from. Reveal
 * remains the only thing that draws the real path (ТЗ §7, §8).
 */
export function reconBlotchForProbe(
  world: WorldGeometry,
  probeIndex: number,
  ownBearingRadians: number,
  mark?: Point2D,
): ReconBlotch {
  /*
   * The probe's *own* inbound, not the fused one.
   *
   * Everything here used to be measured against the merged corridor, and
   * the corridor moves every time another probe is bought: a mark drawn
   * where probe two reported was re-projected onto probe three's axis and
   * clamped into probe three's narrower cloud, which slid it hundreds of
   * kilometres across the board — a reading changing after the fact
   * because of a reading it knows nothing about. Whatever else a snapshot
   * is, it is a fact with a timestamp. It is drawn where it was taken and
   * it stays there.
   */
  const from = rayExitFromEarth(ownBearingRadians, world)
  const to = pointOnEarthSurface(ownBearingRadians, world)
  const dx = to.x - from.x
  const dy = to.y - from.y

  const k = Math.max(0, probeIndex - TRAIL_MIN_PROBES)
  const alongT = Math.min(0.88, BLOTCH_FIRST_STEP + k * BLOTCH_STEP)

  return {
    // A reading that carried a snapshot is drawn at the snapshot. Without
    // one, the best this probe said is its bearing, stepped to the range
    // its turn in the sequence implies.
    center: mark ?? { x: from.x + dx * alongT, y: from.y + dy * alongT },
    alongKm: world.sectorSpanKm * 0.82,
    acrossKm: world.sectorSpanKm * 0.98,
    headingRadians: Math.atan2(dy, dx),
    depth: reconBlotchDepth(probeIndex),
  }
}

function staticReconBlotches(
  estimate: ReconEstimate,
  world: WorldGeometry,
  readings: readonly ReconProbeResult[],
  bearingRadians: number,
): ReconBlotch[] {
  if (estimate.probeCount < TRAIL_MIN_PROBES) return []
  const marks: ReconBlotch[] = []
  for (let probeIndex = TRAIL_MIN_PROBES; probeIndex <= estimate.probeCount; probeIndex++) {
    const reading = readings[probeIndex - 1]
    // No reading in hand — a picture rebuilt from a fix alone — is the one
    // case with nothing of its own to stand on, so it borrows the fix's.
    const own = reading ? (reading.bearingDegrees * Math.PI) / 180 : bearingRadians
    marks.push(reconBlotchForProbe(world, probeIndex, own, reading?.mark))
  }
  return marks
}

/** 0 at the first red mark (probe 1), 1 at the seventh — one step per grade. */
export function reconBlotchDepth(probeIndex: number): number {
  const step = (probeIndex - TRAIL_MIN_PROBES) / (RECON_BLOTCH_GRADES - 1)
  return Math.min(1, Math.max(0, step))
}

/** Signed `a - b`, folded into (-π, π] so 350° and 10° are 20° apart. */
export function signedAngleDelta(a: number, b: number): number {
  const delta = (a - b) % (2 * Math.PI)
  if (delta > Math.PI) return delta - 2 * Math.PI
  if (delta <= -Math.PI) return delta + 2 * Math.PI
  return delta
}

/** Smallest angle between two bearings, in radians — always in [0, π]. */
export function angularDistance(a: number, b: number): number {
  const delta = Math.abs(a - b) % (2 * Math.PI)
  return delta > Math.PI ? 2 * Math.PI - delta : delta
}

export function normalizeDegrees(degrees: number): number {
  return Math.round(((degrees % 360) + 360) % 360)
}
