/**
 * The guided tour's chain (ТЗ §11, §25).
 *
 * A second, throwaway `EmulatorBlockchainClient` with three properties the
 * player's own chain must never have:
 *
 *   persistence: 'none'   — it is never read from or written to
 *                           `localStorage`. There is one storage key, so a
 *                           tour that persisted would not sit *beside* the
 *                           real chain, it would replace it.
 *   autoMine: false       — the clock is frozen. Every countdown on screen
 *                           holds still, nothing resolves while somebody is
 *                           reading, and stepping back shows the same
 *                           numbers stepping forward did.
 *   txConfirmDelayMs: 0   — writes confirm instantly, so seeding the whole
 *                           demo costs no visible wait.
 *
 * Everything above that is the product. The rooms below are created by
 * `createLobby`, joined by `joinLobby`, scouted with real Recon Probes and
 * resolved by the real scoring — so the screens the tour shows are not
 * dressed up with fixtures, they are reading a chain that genuinely holds
 * what they claim.
 *
 * Three rooms rather than one room advanced three times, and that is the
 * whole reason the tour can go backwards. Blocks cannot be un-mined: a
 * single room walked from OPEN to RESULT is a one-way trip, and PREV would
 * have to rebuild the chain. Three rooms sitting permanently in the three
 * states make every step a *read*, so PREV and NEXT are the same cost and
 * neither can drift.
 */

import { EmulatorBlockchainClient } from '../blockchain'
import { appConfig } from '../config/env'
import { buildDefaultLobbyConfig } from '../config/gameConfig'
import { positionAtProgress } from '../game/attacks'
import {
  createLobby,
  getAttack,
  getLobby,
  joinLobby,
  revealAttack,
  sendReconProbe,
} from '../game/gameService'
import { joinCostOf } from '../game/economics'
import { seal, unseal, type SealedEnvelope, type SealingKey } from '../game/sealing'
import type { Address, AttackTrajectory, DefensePoint, Hash, LobbyConfig } from '../game/types'
import {
  buildWorld,
  distance,
  pointOnEarthSurface,
  rayExitFromEarth,
  worldToDefensePoint,
  type WorldGeometry,
} from '../game/world'

/** The wallet the tour acts as. Named so the roster reads as somebody. */
export const DEMO_PLAYER = '0x00000000000000000000000000000000000000d0' as Address
const DEMO_CREATOR = '0x00000000000000000000000000000000000000c1' as Address
const DEMO_RIVAL_A = '0x00000000000000000000000000000000000000a2' as Address
const DEMO_RIVAL_B = '0x00000000000000000000000000000000000000b3' as Address

const GRID = { columns: appConfig.map.columns, rows: appConfig.map.rows }

/**
 * The rooms the tour walks, and what each one is for.
 *
 * Five, because the tour branches twice and both sides of both branches
 * have to be true. A room the demo player created reads differently from a
 * room they found, and a round they won reads differently from one they
 * lost — so each is its own room, seeded into its own state, rather than
 * one room relabelled by the narration.
 */
export interface GuideLobbies {
  /**
   * Created by the demo player, who also took a seat in it.
   *
   * Joined, because the probe shop only renders for a participant — the
   * drawer's Recon panel is behind `hasJoined` — and buying probes before
   * the launch is a step the tour has to be able to stand somewhere and
   * show. A creator taking one of their own seats is ordinary.
   */
  mine: Hash
  /** Somebody else's, with a seat still free — where JOIN is demonstrated. */
  open: Hash
  /**
   * Somebody else's, with the demo player already in it.
   *
   * The room the JOIN branch continues in once the seat is taken. Joining
   * is a state change and blocks cannot be un-mined, so the tour cannot
   * walk one room across it — it steps into the room that is already on the
   * other side, and the step that lands there says so.
   */
  seated: Hash
  /**
   * In flight, and nothing has been scouted.
   *
   * Its own room, because the step that says the screen reveals nothing has
   * to be standing somewhere that reveals nothing. A room with probes
   * already spent draws the corridor, which is precisely the thing that
   * step is claiming not to show.
   */
  active: Hash
  /**
   * In flight, with exactly one probe spent.
   *
   * One reading is a *direction* and nothing more: the opening probe is a
   * sweep, so it paints a wide cone and no occupancy marks at all — the
   * trail starts at the second reading (`TRAIL_MIN_PROBES`). That makes
   * this the only state in which the difference between "which way" and
   * "where along it" can actually be shown.
   */
  sighted: Hash
  /** In flight, with several probes spent — the fused corridor and the shot. */
  scouted: Hash
  /**
   * The four ways one shot can end, one operation each.
   *
   * Every one of them flies the *same* staged trajectory and carries
   * exactly one committed point, which is the whole reason they are
   * separate operations rather than four markers on one map. Four points on
   * one board is a crowd: the eye cannot tell which ring the explanation is
   * about, and the two timing failures — which are the hard idea — look
   * like scatter. One point against one line is unambiguous, and putting
   * them side by side across four rooms makes the comparison the lesson.
   */
  won: Hash
  early: Hash
  late: Hash
  stray: Hash
}

export interface GuideChain {
  client: EmulatorBlockchainClient
  lobbies: GuideLobbies
}

/**
 * The sealed trajectory, opened — and, below, replaced.
 *
 * Reaching into the client is deliberate and is confined to these two
 * functions. The tour needs a path it can *stage*: one shot that certainly
 * lands, two that certainly miss on timing, and a line that is actually
 * legible on screen. The protocol's whole design is that nobody can know
 * any of that from reconnaissance, so the fixture cheats where a player
 * cannot, inside a sandbox, to script a scene.
 *
 * Nothing else in the tour touches this. The screens are shown the same
 * sealed state a player would be, and the geometry reaches them only
 * through the reveal.
 */
function chainInternals(client: EmulatorBlockchainClient) {
  return client as unknown as {
    state: { sealedTrajectories: Map<string, SealedEnvelope> }
    sealingKey: SealingKey
  }
}

function openSealedTrajectory(
  client: EmulatorBlockchainClient,
  lobbyId: Hash,
  attackId: string,
): AttackTrajectory {
  const internals = chainInternals(client)
  const sealed = internals.state.sealedTrajectories.get(`${lobbyId}:${attackId}`)
  if (!sealed) throw new Error(`Guide chain: no sealed trajectory for ${attackId}`)
  return unseal<AttackTrajectory>(sealed, internals.sealingKey)
}

/**
 * How the staged attack comes in.
 *
 * The generator draws both angles at random inside wide bounds, and a fair
 * share of those draws are useless to look at: a path that grazes the far
 * edge of the field, or one so close to vertical that the reveal is a
 * hairline against the frame. That is correct for a real round and wrong
 * for a demonstration, where the same picture has to read every time.
 *
 * Screen convention is +x right, +y down, so -PI/2 is straight up out of
 * the planet. The launch is tilted well off vertical and the impact is
 * offset the other way, which puts the chord diagonally across the middle
 * of the working area — long enough to see, short enough to sit inside the
 * frame end to end.
 */
const STAGED_LAUNCH_BEARING = -Math.PI / 2 - 0.62
const STAGED_IMPACT_ANGLE = -Math.PI / 2 + 0.30

/** Replaces an attack's sealed geometry with the staged one. */
function pinTrajectory(
  client: EmulatorBlockchainClient,
  lobbyId: Hash,
  attackId: string,
  flightBlocks: number,
): AttackTrajectory {
  const world = buildWorld(GRID, appConfig.protocol.sectorSpanKm)
  const pointA = rayExitFromEarth(STAGED_LAUNCH_BEARING, world)
  const pointB = pointOnEarthSurface(STAGED_IMPACT_ANGLE, world)
  const lengthKm = distance(pointA, pointB)

  const staged: AttackTrajectory = {
    pointA,
    pointB,
    impactAngleRadians: STAGED_IMPACT_ANGLE,
    launchBearingRadians: STAGED_LAUNCH_BEARING,
    lengthKm,
    // The one place speed is ever computed, and the reason impact lands on
    // the epoch boundary whatever the distance turned out to be.
    speedKmPerBlock: flightBlocks > 0 ? lengthKm / flightBlocks : 0,
  }

  const internals = chainInternals(client)
  internals.state.sealedTrajectories.set(`${lobbyId}:${attackId}`, seal(staged, internals.sealingKey))
  return staged
}

/**
 * A room's terms.
 *
 * `deadlineBlock` is set explicitly rather than left to the creation screen,
 * because it is what lets applications close *instantly*: the tour advances
 * past the block instead of waiting out a wall clock, so seeding three rooms
 * — one of which has to fly and resolve — costs no time at all.
 */
function termsFor(name: string, currentBlock: number, openForBlocks: number): LobbyConfig {
  const base = buildDefaultLobbyConfig(appConfig, Date.now())
  return {
    ...base,
    name,
    participation: {
      ...base.participation,
      minPlayers: 2,
      maxPlayers: 8,
      entryPrice: 0.03,
      deadline: Date.now() + openForBlocks * appConfig.blockTimeMs,
      deadlineBlock: currentBlock + openForBlocks,
    },
    economics: { ...base.economics, prizePool: 0.05 },
  }
}

async function openRoom(
  client: EmulatorBlockchainClient,
  name: string,
  openForBlocks: number,
  joiners: Address[],
  creator: Address = DEMO_CREATOR,
): Promise<Hash> {
  const currentBlock = await client.getBlockNumber()
  const terms = termsFor(name, currentBlock, openForBlocks)
  const { lobby } = await createLobby(client, creator, terms)
  const cost = joinCostOf(terms)
  for (const joiner of joiners) await joinLobby(client, joiner, lobby.id, cost)
  return lobby.id
}

/** Closes applications and puts the room's attack in the sky. */
async function launch(client: EmulatorBlockchainClient, lobbyId: Hash): Promise<{ attackId: string; launchBlock: number; flightBlocks: number }> {
  const lobby = await getLobby(client, lobbyId)
  const deadlineBlock = lobby!.config.participation.deadlineBlock
  const now = await client.getBlockNumber()
  if (deadlineBlock > now) client.advanceBlocks(deadlineBlock - now)

  const refreshed = await getLobby(client, lobbyId)
  const attackId = refreshed!.activeAttackId
  if (!attackId) throw new Error(`Guide chain: ${lobbyId} closed without scheduling an attack`)

  const attack = await getAttack(client, lobbyId, attackId)

  /*
   * Staged before the chain moves another block, and therefore before any
   * probe is spent or any defense submitted. A probe reads the trajectory
   * at send time, so replacing it afterwards would leave readings that
   * describe a path nothing else on the screen agrees with.
   */
  pinTrajectory(client, lobbyId, attackId, attack!.flightDurationBlocks)

  const atLaunch = await client.getBlockNumber()
  if (attack!.launchBlock + 1 > atLaunch) client.advanceBlocks(attack!.launchBlock + 1 - atLaunch)

  return { attackId, launchBlock: attack!.launchBlock, flightBlocks: attack!.flightDurationBlocks }
}

/**
 * A defender who was never near the path.
 *
 * The ordinary miss, and the reason the timing ones read as timing: without
 * it, "on the path and still lost" has nothing to be contrasted with, and
 * every marker on the board looks like the same kind of failure.
 */
async function commitStray(
  client: EmulatorBlockchainClient,
  from: Address,
  params: {
    lobbyId: Hash
    attackId: string
    trajectory: AttackTrajectory
    launchBlock: number
    flightBlocks: number
    commitAt: number
  },
): Promise<void> {
  const world = buildWorld(GRID, appConfig.protocol.sectorSpanKm)
  const commitBlock = params.launchBlock + Math.round(params.commitAt * params.flightBlocks)
  const now = await client.getBlockNumber()
  if (commitBlock > now) client.advanceBlocks(commitBlock - now)

  await client.submitDefense(from, {
    lobbyId: params.lobbyId,
    attackId: params.attackId,
    defensePoint: besideThePath(params.trajectory, world),
  })
}

/** Puts one defender's point on the path at `pointAt`, committed at `commitAt`. */
async function commitOnPath(
  client: EmulatorBlockchainClient,
  from: Address,
  params: {
    lobbyId: Hash
    attackId: string
    trajectory: AttackTrajectory
    launchBlock: number
    flightBlocks: number
    commitAt: number
    pointAt: number
  },
): Promise<void> {
  const world = buildWorld(GRID, appConfig.protocol.sectorSpanKm)
  const commitBlock = params.launchBlock + Math.round(params.commitAt * params.flightBlocks)
  const now = await client.getBlockNumber()
  if (commitBlock > now) client.advanceBlocks(commitBlock - now)

  await client.submitDefense(from, {
    lobbyId: params.lobbyId,
    attackId: params.attackId,
    defensePoint: worldToDefensePoint(positionAtProgress(params.trajectory, params.pointAt), world),
  })
}

/** Spends probes as the demo player, so the room has a corridor to show. */
async function scout(client: EmulatorBlockchainClient, lobbyId: Hash, attackId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await sendReconProbe(client, DEMO_PLAYER, { lobbyId, attackId, probeId: `${lobbyId}-probe-${index}` })
    // The protocol refuses a second probe inside the cooldown, so the tour
    // spends them the way a player has to: a few blocks apart.
    client.advanceBlocks(4)
  }
}

/**
 * Where through the flight each staged defender commits, and where their
 * point sits on the path.
 *
 * The three verdicts the reveal has to be able to show, arranged so that
 * every one of them is *earned* by the scoring rather than asserted:
 *
 *   winner    — point and submit at the same progress, so the threat is
 *               inside the radius at the moment of the snapshot.
 *   too early — point further down the path than the threat has reached.
 *               The chord enters the radius later than the submit block.
 *   too late  — point behind the threat. The chord passed through before
 *               the submit block.
 *
 * Submitted in ascending block order, because the chain only moves forward.
 */
const STAGED_SHOTS = {
  won: { commitAt: 0.6, pointAt: 0.6 },
  early: { commitAt: 0.44, pointAt: 0.72 },
  late: { commitAt: 0.82, pointAt: 0.54 },
} as const

export async function buildGuideChain(): Promise<GuideChain> {
  const client = new EmulatorBlockchainClient({
    initialBlock: appConfig.emulator.initialBlock,
    blockTimeMs: appConfig.blockTimeMs,
    mapGrid: GRID,
    epochBlocks: appConfig.protocol.epochBlocks,
    protocolLimits: appConfig.protocol,
    txConfirmDelayMs: 0,
    persistence: 'none',
    autoMine: false,
  })

  /*
   * The four resolved operations come first, and the losing three are not
   * decoration.
   *
   * The Global Defense jackpot is the second thing the tour explains, and
   * the pill is hidden while the pool is empty — a 0 trophy is not a status,
   * it is noise. The only way to put money in it is for operations to
   * actually complete unwon, which these do: real attacks, real shots that
   * miss, and pools the protocol forfeits exactly as it would on a live
   * chain.
   *
   * They also have to be seeded before anything that must still be flying.
   * Launching an attack advances the chain to an epoch boundary, so every
   * launch drags the rooms behind it forward — harmless for an operation
   * that has already resolved, fatal for one the tour is about to describe
   * as in flight.
   */
  const stray = await seedOutcomeRoom(client, 'stray')
  const late = await seedOutcomeRoom(client, 'late')
  const early = await seedOutcomeRoom(client, 'early')
  const won = await seedOutcomeRoom(client, 'won')

  /*
   * The rest seeded newest-last, because the directory shows the newest
   * first and the rooms the tour actually walks into should be at the top
   * of it.
   */
  const { active, sighted, scouted } = await seedInFlightRooms(client)
  const seated = await openRoom(client, 'HIGH GROUND', 4_000, [DEMO_RIVAL_A, DEMO_PLAYER])
  const open = await openRoom(client, 'OPEN SKIES', 4_000, [DEMO_RIVAL_A, DEMO_RIVAL_B])
  // The demo player's own room, created last so it is the newest thing on
  // the board — which is what a room you just made looks like.
  const mine = await openRoom(client, 'SILENT HORIZON', 4_000, [DEMO_PLAYER], DEMO_PLAYER)

  return {
    client,
    lobbies: { mine, open, seated, active, sighted, scouted, won, early, late, stray },
  }
}

/** Which of the four endings an outcome operation is staged to produce. */
export type OutcomeKind = 'won' | 'early' | 'late' | 'stray'

const OUTCOME_ROOMS: Record<OutcomeKind, string> = {
  won: 'IRON CURTAIN',
  early: 'SHORT FUSE',
  late: 'LAST LIGHT',
  stray: 'BROKEN ARROW',
}

/**
 * One resolved operation, staged to end exactly one way.
 *
 * A single committed point, on the same trajectory every other outcome room
 * flies. That is what makes the four of them a comparison: the line does not
 * move between screens, so the only thing that changed is where the point
 * sat and which block it was committed on — which is precisely the rule the
 * tour is trying to teach.
 *
 * All four still go through the protocol's own scoring. Nothing here asserts
 * a verdict; the staging only decides the inputs, and `guideSandbox.test.ts`
 * checks that each room actually produced the ending it was built for.
 *
 * The three losing rooms also fund the Global Defense jackpot, which the
 * tour explains on its second screen: an operation nobody won is COMPLETED,
 * and its pool is forfeit rather than refunded. That needs somebody to have
 * *played* — an operation where nobody acted at all is UNPLAYED and every
 * wei goes back — which the probes and the shot below satisfy.
 */
async function seedOutcomeRoom(
  client: EmulatorBlockchainClient,
  kind: OutcomeKind,
): Promise<Hash> {
  const lobbyId = await openRoom(client, OUTCOME_ROOMS[kind], 6, [DEMO_PLAYER, DEMO_RIVAL_A])
  const { attackId, launchBlock, flightBlocks } = await launch(client, lobbyId)
  await scout(client, lobbyId, attackId, 2)

  const trajectory = openSealedTrajectory(client, lobbyId, attackId)
  const shot = { lobbyId, attackId, trajectory, launchBlock, flightBlocks }

  if (kind === 'stray') await commitStray(client, DEMO_PLAYER, { ...shot, commitAt: 0.6 })
  else await commitOnPath(client, DEMO_PLAYER, { ...shot, ...STAGED_SHOTS[kind] })

  const afterSubmit = await client.getBlockNumber()
  const impactBlock = launchBlock + flightBlocks
  if (impactBlock + 1 > afterSubmit) client.advanceBlocks(impactBlock + 1 - afterSubmit)
  await revealAttack(client, DEMO_PLAYER, { lobbyId, attackId })

  return lobbyId
}

/**
 * A point clearly beside the path, rather than the furthest one from it.
 *
 * The obvious implementation — sweep the board and take the sector centre
 * with the greatest distance — is worse in the two ways that matter. It
 * lands in a corner, which on this screen is under the details drawer and
 * behind the tour's own card; and a marker in the far corner reads as a
 * defender who was not really playing, when the point being made is that
 * the line itself was wrong.
 *
 * So it is taken square off the middle of the trajectory: unmistakably not
 * on it — the offset is many times the interception radius — while staying
 * in the part of the scene somebody is already looking at. The side is
 * chosen to land away from the drawer.
 */
const STRAY_OFFSET_KM = 2_600

function besideThePath(trajectory: AttackTrajectory, world: WorldGeometry): DefensePoint {
  const { pointA, pointB } = trajectory
  const along = { x: pointB.x - pointA.x, y: pointB.y - pointA.y }
  const length = Math.hypot(along.x, along.y) || 1
  // Square to the path, in the scene's own convention.
  const normal = { x: -along.y / length, y: along.x / length }
  const middle = { x: (pointA.x + pointB.x) / 2, y: (pointA.y + pointB.y) / 2 }

  const candidates = [1, -1].map((sign) => ({
    x: middle.x + normal.x * STRAY_OFFSET_KM * sign,
    y: middle.y + normal.y * STRAY_OFFSET_KM * sign,
  }))

  // The drawer covers the right of the scene, so prefer the side that does
  // not put the marker underneath it.
  const chosen = candidates.reduce((best, point) => (point.x < best.x ? point : best))
  return worldToDefensePoint(chosen, world)
}


/**
 * The rooms that have to still be flying when the tour arrives.
 *
 * Seeded together, on one shared deadline, and this is not tidiness — it is
 * the only arrangement that works. An attack launches on an *epoch
 * boundary*, so putting a room in the sky can mean advancing the chain by
 * most of an epoch; do that a second time and the later launch carries the
 * earlier room past its own impact, quietly resolving an operation the tour
 * is about to describe as in flight.
 *
 * One deadline means one epoch, one advance, and every room airborne with
 * the whole flight ahead of it.
 *
 * They differ in exactly one thing — how much has been scouted — because
 * that is the axis the tour walks along:
 *
 *   active   nothing spent. The sky is genuinely empty, so the step that
 *            says the screen reveals nothing stands somewhere it is true.
 *   sighted  one reading: a direction, and no occupancy marks.
 *   scouted  several: the fused corridor, with the trail that only exists
 *            from the second probe onward.
 */
async function seedInFlightRooms(
  client: EmulatorBlockchainClient,
): Promise<{ active: Hash; sighted: Hash; scouted: Hash }> {
  const openFor = 6
  const at = await client.getBlockNumber()

  const defenders = [DEMO_PLAYER, DEMO_RIVAL_A, DEMO_RIVAL_B]
  const scouted = await openRoomAt(client, 'DEEP FIELD', at, openFor, defenders)
  const sighted = await openRoomAt(client, 'FIRST LIGHT', at, openFor, defenders)
  const active = await openRoomAt(client, 'NIGHT WATCH', at, openFor, defenders)

  const scoutedAttack = await launch(client, scouted)
  const sightedAttack = await launch(client, sighted)
  await launch(client, active)

  /*
   * The three states reconnaissance actually has, one room each: nothing
   * spent, one reading, several. The probes advance a few blocks apiece,
   * which all three absorb — the flight is a whole epoch long.
   */
  await scout(client, sighted, sightedAttack.attackId, 1)
  await scout(client, scouted, scoutedAttack.attackId, 3)

  return { active, sighted, scouted }
}

/** `openRoom`, with the deadline pinned to a block the caller chose. */
async function openRoomAt(
  client: EmulatorBlockchainClient,
  name: string,
  fromBlock: number,
  openForBlocks: number,
  joiners: Address[],
): Promise<Hash> {
  const terms = termsFor(name, fromBlock, openForBlocks)
  const { lobby } = await createLobby(client, DEMO_CREATOR, terms)
  const cost = joinCostOf(terms)
  for (const joiner of joiners) await joinLobby(client, joiner, lobby.id, cost)
  return lobby.id
}

