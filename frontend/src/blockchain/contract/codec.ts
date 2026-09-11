import { decodeAbiParameters, formatEther, parseEther, type AbiParameter, type Hex } from 'viem'
import type {
  ActivityCell,
  Address,
  Attack,
  AttackOutcome,
  AttackStatus,
  AttackTrajectory,
  DefenseAttempt,
  DefensePoint,
  DefenseResult,
  Hash,
  Lobby,
  LobbyConfig,
  LobbyReveal,
  LobbyEnding,
  LobbyStatus,
  Participant,
  Point2D,
} from '../../game/types'
import { defensePointToWorld, worldToDefensePoint, type WorldGeometry } from '../../game/world'

/**
 * The translation layer between what the contract stores and what the game
 * domain is written in.
 *
 * The two disagree about units on purpose. On chain everything is an
 * integer — wei, world units of 1e-6 km, microradians, block numbers scaled
 * by 1e6 — because that is what a contract can do arithmetic on without
 * rounding a reward or an interception time into the wrong answer. In the
 * browser everything is an ordinary number in ETH, kilometres and radians,
 * because that is what the geometry and the UI were written against.
 *
 * Keeping the conversion in one module is what stops those two worlds from
 * leaking into each other: nothing above this file ever sees a bigint, and
 * nothing below it ever sees a float.
 */

/** World units per kilometre, matching `GameTypes.WU` on chain. */
export const WU_PER_KM = 1_000_000
/** Block-number scaling for sub-block timing, matching `GameTypes.TIME_SCALE`. */
export const TIME_SCALE = 1_000_000
const BPS = 10_000

export function weiToEth(value: bigint): number {
  return Number(formatEther(value))
}

/**
 * ETH to wei, through the number's own shortest decimal form.
 *
 * `String(0.123456)` is "0.123456" — JavaScript prints the shortest string
 * that round-trips — whereas `toFixed(18)` prints the binary value behind
 * it, "0.123455999999999996", and would send four wei less than the price
 * a contract is about to check for equality. Exponent notation is the one
 * case the shortest form is not a decimal, so it is expanded first.
 */
export function ethToWei(value: number): bigint {
  const text = String(value)
  return parseEther(text.includes('e') || text.includes('E') ? expandExponent(value) : text)
}

function expandExponent(value: number): string {
  const fixed = value.toFixed(18)
  // Trailing zeros are meaningless here and make the string harder to read
  // in an error message.
  return fixed.replace(/0+$/, '').replace(/\.$/, '')
}

export function wuToKm(value: bigint | number): number {
  return Number(value) / WU_PER_KM
}

export function kmToWu(value: number): bigint {
  return BigInt(Math.round(value * WU_PER_KM))
}

/** A scaled block number back to a fractional block. */
export function scaledToBlock(value: bigint): number {
  return Number(value) / TIME_SCALE
}

export function microRadToRad(value: bigint | number): number {
  return Number(value) / 1_000_000
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

const LOBBY_STATUS: LobbyStatus[] = ['CREATED', 'OPEN', 'READY', 'ACTIVE', 'RESOLVED', 'CANCELLED']

export function toLobbyStatus(value: number): LobbyStatus {
  return LOBBY_STATUS[value] ?? 'CREATED'
}

/** `GameTypes.Ending` — how the operation ended, see `LobbyEnding`. */
const LOBBY_ENDING: LobbyEnding[] = ['NONE', 'COMPLETED', 'UNPLAYED', 'CANCELLED']

export function toLobbyEnding(value: number): LobbyEnding {
  return LOBBY_ENDING[value] ?? 'NONE'
}

/**
 * The contract has a fourth attack state the domain does not: COMPLETED,
 * the window between impact and the reveal. The domain treats it as
 * RESOLVED because that is what it means to a player — the flight is over —
 * and whether the geometry is public yet is answered by `lobby.reveal`,
 * which is where the UI already looks.
 */
export function toAttackStatus(value: number): AttackStatus {
  switch (value) {
    case 1:
      return 'PENDING'
    case 2:
      return 'LAUNCHED'
    case 3:
    case 4:
      return 'RESOLVED'
    default:
      return 'PENDING'
  }
}

// ---------------------------------------------------------------------------
// Chain struct shapes (as viem decodes them)
// ---------------------------------------------------------------------------

/**
 * `GameTypes.GameParams`, field for field.
 *
 * The names are load-bearing rather than documentation: viem decodes a
 * struct into an object keyed by the ABI's own parameter names, so a field
 * misnamed here is not a type error — it is `undefined` at runtime, in a
 * number the protocol prices something with. That is exactly how
 * `maxProbes`/`probePrice` came to be read off a config that had stopped
 * carrying them.
 */
export interface ChainGameParams {
  gridColumns: number
  gridRows: number
  sectorSpanKm: number
  interceptRadiusMilliSectors: number
  epochBlocks: number
  defenseSpeedKmPerBlock: number
  probeConeMicroRad: number
  revealGraceBlocks: number
  minPlayers: number
  maxPlayers: number
  /** Recon Probes one player may hold per attack — protocol-owned (ТЗ §3). */
  maxProbesPerPlayer: number
  /** Recon Probes every player starts an attack with — protocol-owned. */
  freeProbes: number
  maxCreatorFeeBps: number
  minRegistrationSeconds: number
  maxRegistrationSeconds: number
  minEntryFee: bigint
  maxEntryFee: bigint
  minStartPrizePool: bigint
  /** What one Recon Probe costs. A price, not a ceiling — see `GameTypes`. */
  probePrice: bigint
  protocolJoinFee: bigint
}

/**
 * `GameTypes.LobbyConfig` — the creator-chosen half, and only that half.
 *
 * Recon deliberately is not here. One threat per epoch means a probe's
 * answer is worth the same in every operation facing it, so a creator-set
 * price would only decide where the epoch buys its intelligence; the terms
 * live on `ChainGameParams` and are read live.
 */
export interface ChainLobbyConfig {
  name: string
  minPlayers: number
  maxPlayers: number
  entryPrice: bigint
  registrationDeadline: bigint
  /** The block applications close on — what the contract actually enforces. */
  registrationDeadlineBlock: bigint
  startPrizePool: bigint
  creatorFeeBps: number
}

export interface ChainLobby {
  id: Hash
  creator: Address
  createdAtBlock: bigint
  createdAtTimestamp: bigint
  status: number
  paramsVersion: number
  participantCount: number
  startedAtBlock: bigint
  epochId: number
  attackId: Hash
  attemptCount: number
  entryFeesCollected: bigint
  probeFeesCollected: bigint
  creatorFeeAccrued: bigint
  protocolFeeAccrued: bigint
  rewardPool: bigint
  rewardsClaimed: bigint
  creatorSettled: boolean
  /** `GameTypes.Ending` — how it ended. 0 while running. */
  ending: number
  /** Probes sent and defenses submitted: what makes a round played (ТЗ §18). */
  validActions: number
}

export interface ChainParticipant {
  joined: boolean
  joinedAtBlock: bigint
  probesUsed: number
  probesPurchased: number
  defenseIndex: number
  claimed: boolean
  refunded: boolean
  paidIn: bigint
  /** Of `paidIn`, the part spent on Recon Probes — what a losing round keeps. */
  probesPaid: bigint
  lastProbeBlock: bigint
}

/**
 * `GameTypes.Participant` as the ABI returns it.
 *
 * `lastProbeBlock` was appended. A proxy that has not been upgraded still
 * returns the nine-field layout; viem then throws "position out of bounds"
 * and the Operation screen never leaves "Loading". Decode the live bytes,
 * and treat a missing tail as "never sent a probe".
 */
const PARTICIPANT_FIELDS: AbiParameter[] = [
  { name: 'joined', type: 'bool' },
  { name: 'joinedAtBlock', type: 'uint64' },
  { name: 'probesUsed', type: 'uint16' },
  { name: 'probesPurchased', type: 'uint16' },
  { name: 'defenseIndex', type: 'uint32' },
  { name: 'claimed', type: 'bool' },
  { name: 'refunded', type: 'bool' },
  { name: 'paidIn', type: 'uint128' },
  { name: 'probesPaid', type: 'uint128' },
  { name: 'lastProbeBlock', type: 'uint64' },
]

export function decodeChainParticipant(data: Hex): ChainParticipant {
  const components =
    (data.length - 2) / 64 >= PARTICIPANT_FIELDS.length
      ? PARTICIPANT_FIELDS
      : PARTICIPANT_FIELDS.slice(0, -1)
  const [raw] = decodeAbiParameters([{ type: 'tuple', components }], data) as unknown as [
    {
      joined: boolean
      joinedAtBlock: bigint
      probesUsed: number | bigint
      probesPurchased: number | bigint
      defenseIndex: number | bigint
      claimed: boolean
      refunded: boolean
      paidIn: bigint
      probesPaid: bigint
      lastProbeBlock?: bigint
    },
  ]
  return {
    joined: Boolean(raw.joined),
    joinedAtBlock: BigInt(raw.joinedAtBlock),
    probesUsed: Number(raw.probesUsed),
    probesPurchased: Number(raw.probesPurchased),
    defenseIndex: Number(raw.defenseIndex),
    claimed: Boolean(raw.claimed),
    refunded: Boolean(raw.refunded),
    paidIn: BigInt(raw.paidIn),
    probesPaid: BigInt(raw.probesPaid),
    lastProbeBlock: BigInt(raw.lastProbeBlock ?? 0n),
  }
}

/**
 * `GameTypes.Attack` — the *epoch's* attack, not any operation's.
 *
 * There is no `lobbyId` on it by design: one threat crosses the playfield
 * per epoch and every operation running that epoch is a team computing an
 * interception for the same object. Which teams are watching is not a
 * property of the attack, so the operation has to be carried alongside it.
 */
export interface ChainAttack {
  id: Hash
  epochId: number
  launchBlock: bigint
  impactBlock: bigint
  flightBlocks: number
  status: number
  bearingHandle: Hash
  deltaHandle: Hash
  decryptionUnlocked: boolean
  /** Whether any team on this epoch stopped it — what the planet cares about. */
  intercepted: boolean
  /** One-time pad `K`. Unlocked after impact; every defense is `P + K`. */
  maskKeyHandle: Hash
}

export interface ChainTrajectory {
  startX: bigint
  startY: bigint
  targetX: bigint
  targetY: bigint
  impactAngleMicroRad: bigint
  launchBearingMicroRad: bigint
  lengthWu: bigint
  speedWuPerBlock: bigint
}

export interface ChainOutcome {
  intercepted: boolean
  interceptX: bigint
  interceptY: bigint
  interceptionBlockScaled: bigint
  winningArrivalBlockScaled: bigint
  interceptRadiusWu: bigint
  winners: readonly Address[]
  rewardPerWinner: bigint
  resolvedAtBlock: bigint
  resolvedAtTimestamp: bigint
  revealedBy: Address
}

export interface ChainDefenseAttempt {
  participant: Address
  pointHandle: Hash
  submittedAtBlock: bigint
  submittedAtTimestamp: bigint
  revealed: boolean
  x: bigint
  y: bigint
  arrivalBlockScaled: bigint
  intercepted: boolean
  interceptionBlockScaled: bigint
  interceptX: bigint
  interceptY: bigint
  missDistanceWu: bigint
  isWinner: boolean
  /** `P + K (mod 2^128)`. Globally decryptable from submit; useless without `K`. */
  maskedHandle: Hash
}

// ---------------------------------------------------------------------------
// Chain -> domain
// ---------------------------------------------------------------------------

/**
 * A lobby's terms as the UI knows them.
 *
 * The creator-set half comes from the lobby's own config. Attack geometry
 * — flight duration, world scale, interception radius — comes from the
 * parameter snapshot the contract froze onto this operation at creation,
 * so a later `setParams` cannot change the game somebody is already
 * playing. Recon is the exception: `buyProbes` charges live `$.params`,
 * so those three fields overlay the snapshot (see `liveParams`).
 */
export function toLobbyConfig(
  config: ChainLobbyConfig,
  params: ChainGameParams,
  /**
   * Live `$.params`. Recon is priced off these at purchase time, so they
   * overlay the frozen snapshot for the three drone fields. Attack geometry
   * and fees stay on `params` — those *are* what this operation plays under.
   */
  liveParams: ChainGameParams = params,
): LobbyConfig {
  return {
    name: config.name,
    participation: {
      minPlayers: config.minPlayers,
      maxPlayers: config.maxPlayers,
      entryPrice: weiToEth(config.entryPrice),
      deadline: Number(config.registrationDeadline) * 1000,
      deadlineBlock: Number(config.registrationDeadlineBlock),
    },
    economics: {
      prizePool: weiToEth(config.startPrizePool),
      creatorFeePercent: (config.creatorFeeBps / BPS) * 100,
      protocolJoinFee: weiToEth(params.protocolJoinFee),
    },
    /*
     * Recon comes from the *live* protocol params, never from the lobby and
     * never from the frozen snapshot `getLobby` returns.
     *
     * `buyProbes` charges `$.params.probePrice`, so a snapshot taken at
     * creation is not what the player will pay after `setParams`. Showing
     * the frozen figure is how the Buy control advertised 0.002 ETH while
     * the transaction sent 0.0002.
     */
    drones: {
      freeCount: liveParams.freeProbes,
      price: weiToEth(liveParams.probePrice),
      maxCount: liveParams.maxProbesPerPlayer,
    },
    attack: {
      epochBlocks: params.epochBlocks,
      sectorSpanKm: params.sectorSpanKm,
      interceptionRadiusSectors: params.interceptRadiusMilliSectors / 1000,
      defenseSpeedKmPerBlock: params.defenseSpeedKmPerBlock,
    },
    payout: { rewardAsset: { kind: 'ETH' } },
  }
}

/**
 * What `settleCreator` pays (ТЗ §14.6) — the same arithmetic the contract
 * does. The settled flag is a separate fact: after the payout the figure
 * is still this number, so a reload can print what went to the wallet
 * instead of a zero.
 */
function creatorSettlementOf(
  lobby: ChainLobby,
  config: ChainLobbyConfig,
  _params: ChainGameParams,
  outcome: AttackOutcome | null,
): number {
  const ending = toLobbyEnding(lobby.ending)

  /*
   * A round that never ran gives the bounty back. The protocol fee the
   * creator paid at mint stays with the treasury.
   */
  if (ending === 'UNPLAYED' || ending === 'CANCELLED') {
    return weiToEth(config.startPrizePool)
  }
  if (ending !== 'COMPLETED') return 0

  /*
   * On a COMPLETED round the creator gets the fee they earned for filling the
   * operation, and — on an interception — whatever rounding dust the split
   * between an exact tie left behind. The bounty does *not* come back on a
   * miss any more: an unwon pool goes to the Global Defense Pool, and
   * `resolveLobby` has already zeroed `rewardPool` as it left (ТЗ §18).
   */
  const paidToWinners = outcome?.intercepted ? outcome.rewardPerWinner * outcome.winners.length : 0
  const dust = outcome?.intercepted ? Math.max(0, weiToEth(lobby.rewardPool) - paidToWinners) : 0
  return weiToEth(lobby.creatorFeeAccrued) + dust
}

export function toLobby(
  lobby: ChainLobby,
  config: ChainLobbyConfig,
  params: ChainGameParams,
  participants: readonly Address[],
  reveal: LobbyReveal | null,
  outcome: AttackOutcome | null,
  liveParams: ChainGameParams = params,
): Lobby {
  return {
    id: lobby.id,
    // On chain a lobby id is derived from the creator and a nonce rather
    // than from a transaction hash — a contract cannot know its own tx hash
    // — so the two coincide only in the emulator. Everything that matters
    // reads the id, and the creating transaction is still recoverable from
    // the LobbyCreated log.
    creationTxHash: lobby.id,
    creator: lobby.creator,
    createdAtBlock: Number(lobby.createdAtBlock),
    status: toLobbyStatus(lobby.status),
    ending: toLobbyEnding(lobby.ending),
    config: toLobbyConfig(config, params, liveParams),
    participantCount: lobby.participantCount,
    participantAddresses: [...participants],
    currentEpochId: lobby.attackId === ZERO_HASH ? null : lobby.epochId,
    activeAttackId: lobby.attackId === ZERO_HASH ? null : lobby.attackId,
    outcome,
    creatorSettlement: creatorSettlementOf(lobby, config, params, outcome),
    creatorSettled: lobby.creatorSettled,
    reveal,
  }
}

export const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hash

export function toParticipant(
  lobbyId: Hash,
  address: Address,
  participant: ChainParticipant,
  /** The probe allowance is the protocol's, so this reads params, not the lobby. */
  params: ChainGameParams,
  revealed: boolean,
  isViewer: boolean,
  /**
   * Whether the chain has marked this participant's attempt the winning one.
   *
   * It has to be passed in because it does not live on the participant
   * record: the contract writes `isWinner` onto the *defense attempt* when
   * the reveal resolves the round. Without it `payoutState` could only ever
   * be PAID or NONE, and a winner who had not claimed yet would read as
   * owed nothing — which is precisely the state the Claim Reward control
   * exists for.
   */
  isWinner = false,
): Participant {
  const owned = params.freeProbes + participant.probesPurchased
  const remaining = Math.max(0, owned - participant.probesUsed)

  // Which actions a defender took is public on chain — probe allowances are
  // enforced there — so `actionCount` is honest for everyone. The *content*
  // of those actions is what stays private, and none of it is here.
  const visible = isViewer || revealed
  return {
    lobbyId,
    address,
    joinTxHash: ZERO_HASH,
    joinedAtBlock: Number(participant.joinedAtBlock),
    freeDronesRemaining: remaining,
    purchasedDrones: participant.probesPurchased,
    actionCount: participant.probesUsed + (participant.defenseIndex > 0 ? 1 : 0),
    probeIds: visible ? probeIdsFor(lobbyId, address, participant.probesUsed) : [],
    defenseAttemptIds: visible && participant.defenseIndex > 0 ? [`${lobbyId}-d${participant.defenseIndex - 1}`] : [],
    payoutState: participant.claimed ? 'PAID' : isWinner ? 'PENDING' : 'NONE',
    paidIn: weiToEth(participant.paidIn),
    probesPaid: weiToEth(participant.probesPaid),
    refunded: participant.refunded,
    lastProbeBlock: Number(participant.lastProbeBlock ?? 0),
  }
}

function probeIdsFor(lobbyId: Hash, address: Address, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${lobbyId}-${address}-p${index}`)
}

export function toAttack(
  attack: ChainAttack,
  derivedStatus: number,
  blockTimeMs: number,
  chainRef: { blockNumber: number; timestamp: number },
  /**
   * Which operation is watching this attack.
   *
   * Passed in rather than read off the attack, because the attack belongs
   * to the epoch and does not know: it is faced by every team playing that
   * epoch at once (see `ChainAttack`).
   */
  lobbyId: Hash,
): Attack {
  const launchBlock = Number(attack.launchBlock)
  const impactBlock = Number(attack.impactBlock)
  return {
    id: attack.id,
    lobbyId,
    epochId: attack.epochId,
    launchBlock,
    // Block timestamps are only estimated forwards for display; nothing in
    // the protocol is decided by them.
    launchTimestamp: chainRef.timestamp + (launchBlock - chainRef.blockNumber) * blockTimeMs,
    impactBlock,
    impactTimestamp: chainRef.timestamp + (impactBlock - chainRef.blockNumber) * blockTimeMs,
    flightDurationBlocks: attack.flightBlocks,
    status: toAttackStatus(derivedStatus),
  }
}

export function toTrajectory(traj: ChainTrajectory): AttackTrajectory {
  return {
    pointA: { x: wuToKm(traj.startX), y: wuToKm(traj.startY) },
    pointB: { x: wuToKm(traj.targetX), y: wuToKm(traj.targetY) },
    impactAngleRadians: microRadToRad(traj.impactAngleMicroRad),
    launchBearingRadians: microRadToRad(traj.launchBearingMicroRad),
    lengthKm: wuToKm(traj.lengthWu),
    speedKmPerBlock: wuToKm(traj.speedWuPerBlock),
  }
}

export function toOutcome(attackId: string, outcome: ChainOutcome, flightBlocks: number, launchBlock: number): AttackOutcome {
  const interceptionBlock = outcome.intercepted ? scaledToBlock(outcome.interceptionBlockScaled) : null
  return {
    attackId,
    intercepted: outcome.intercepted,
    interceptionPoint: outcome.intercepted
      ? { x: wuToKm(outcome.interceptX), y: wuToKm(outcome.interceptY) }
      : null,
    interceptionBlock,
    interceptionProgress:
      interceptionBlock !== null && flightBlocks > 0 ? (interceptionBlock - launchBlock) / flightBlocks : null,
    interceptionRadiusKm: wuToKm(outcome.interceptRadiusWu),
    winners: [...outcome.winners],
    rewardPerWinner: weiToEth(outcome.rewardPerWinner),
    resolvedAtBlock: Number(outcome.resolvedAtBlock),
    resolvedAtTimestamp: Number(outcome.resolvedAtTimestamp) * 1000,
  }
}

export function toDefenseAttempt(
  lobbyId: Hash,
  attackId: string,
  index: number,
  attempt: ChainDefenseAttempt,
  world: WorldGeometry,
): DefenseAttempt {
  return {
    id: `${lobbyId}-d${index}`,
    lobbyId,
    attackId,
    participant: attempt.participant,
    // Zero until the reveal, for every reader including the defender who
    // placed it — the contract has no plaintext to return before then.
    defensePoint: attempt.revealed
      ? worldToDefensePoint({ x: wuToKm(attempt.x), y: wuToKm(attempt.y) }, world)
      : null,
    sealedPoint: null,
    submittedAtBlock: Number(attempt.submittedAtBlock),
    submittedAtTimestamp: Number(attempt.submittedAtTimestamp) * 1000,
    txHash: ZERO_HASH,
  }
}

/**
 * One defender's result, in the shape the result screen reads.
 *
 * `interceptionProgress` is recomputed from the interception block rather
 * than stored twice: the contract ranks by arrival time and records the
 * entry block, and a progress fraction is a presentation of that, not a
 * second fact about it.
 */
export function toDefenseResult(
  attemptId: string,
  attempt: ChainDefenseAttempt,
  launchBlock: number,
  flightBlocks: number,
  interceptRadiusKm: number,
  trajectory?: AttackTrajectory | null,
): DefenseResult {
  const entered = attempt.intercepted || attempt.interceptionBlockScaled > 0n
  const storedPass = entered ? scaledToBlock(attempt.interceptionBlockScaled) : null
  const interceptionBlock = recoverPassBlock(storedPass, attempt, launchBlock, flightBlocks, trajectory)
  const arrivalBlock = scaledToBlock(attempt.arrivalBlockScaled)
  const missDistanceKm = wuToKm(attempt.missDistanceWu)

  return {
    attemptId,
    participant: attempt.participant,
    status: attempt.revealed ? (attempt.intercepted ? 'intercepted' : 'missed') : 'pending',
    interceptionProgress:
      interceptionBlock !== null && flightBlocks > 0 ? (interceptionBlock - launchBlock) / flightBlocks : null,
    interceptionBlock,
    interceptionPoint: entered
      ? { x: wuToKm(attempt.interceptX), y: wuToKm(attempt.interceptY) }
      : null,
    missDistanceKm: attempt.revealed ? missDistanceKm : null,
    arrivalBlock: attempt.revealed ? arrivalBlock : null,
    isWinner: attempt.isWinner,
    reason: describeResult(attempt, interceptRadiusKm, missDistanceKm, arrivalBlock, interceptionBlock),
  }
}

/**
 * Reconstruct the pass block from the stored intercept point.
 *
 * `Geometry.evaluateDefense` once divided `entryT` by TIME_SCALE a second
 * time, so every on-path miss stored ~launch as the pass. The intercept
 * coordinates themselves were right. When the stored clock sits on launch
 * and the point does not, the point is the fact.
 */
function recoverPassBlock(
  stored: number | null,
  attempt: ChainDefenseAttempt,
  launchBlock: number,
  flightBlocks: number,
  trajectory: AttackTrajectory | null | undefined,
): number | null {
  if (stored === null) return null
  if (attempt.intercepted || !trajectory || flightBlocks <= 0) return stored
  const dx = trajectory.pointB.x - trajectory.pointA.x
  const dy = trajectory.pointB.y - trajectory.pointA.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= 0) return stored
  const ix = wuToKm(attempt.interceptX)
  const iy = wuToKm(attempt.interceptY)
  const t = Math.min(
    1,
    Math.max(0, ((ix - trajectory.pointA.x) * dx + (iy - trajectory.pointA.y) * dy) / lengthSquared),
  )
  const fromPoint = launchBlock + t * flightBlocks
  if (Math.abs(stored - launchBlock) < 1 && fromPoint - launchBlock > 2) return fromPoint
  return stored
}

function describeResult(
  attempt: ChainDefenseAttempt,
  interceptRadiusKm: number,
  missDistanceKm: number,
  arrivalBlock: number,
  interceptionBlock: number | null,
): string {
  if (!attempt.revealed) return 'The attack has not been revealed yet, so its trajectory is still sealed.'
  if (attempt.intercepted) {
    return `The threat was inside the ${Math.round(interceptRadiusKm)} km radius at submit block ${arrivalBlock.toFixed(1)}.`
  }
  if (missDistanceKm <= interceptRadiusKm || interceptionBlock !== null) {
    const passed = interceptionBlock !== null ? ` at block ${interceptionBlock.toFixed(1)}` : ''
    if (arrivalBlock < (interceptionBlock ?? arrivalBlock)) {
      return `Defense was submitted at block ${arrivalBlock.toFixed(1)}, before the threat reached this altitude${passed}.`
    }
    return `Defense was submitted at block ${arrivalBlock.toFixed(1)}, after the threat had already passed through${passed}.`
  }
  return `Defense Point stayed ${Math.round(missDistanceKm)} km from the threat at submit, outside the ${Math.round(interceptRadiusKm)} km interception radius.`
}

/**
 * Where defenders committed, per sector.
 *
 * Empty for the whole life of a round and filled in at the reveal, because
 * a per-sector count is a coarse coordinate: publishing one mid-flight
 * would let anybody watching the map narrow down where the defenders — and
 * by inference the threat — are.
 */
export function toActivityMap(attempts: DefenseAttempt[], columns: number, rows: number): ActivityCell[] {
  const cells: ActivityCell[] = []
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      cells.push({ sector: { column, row }, defenseAttemptCount: 0 })
    }
  }
  for (const attempt of attempts) {
    if (!attempt.defensePoint) continue
    const { column, row } = attempt.defensePoint.sector
    const cell = cells[row * columns + column]
    if (cell) cell.defenseAttemptCount += 1
  }
  return cells
}

/**
 * Half of the packed Defense Point, and the one number this file shares with
 * `Geometry.POINT_LIMB_BITS` in Solidity.
 *
 * It is 64 because the word is *encrypted* before it is a transaction
 * argument, and CoFHE's widest encrypted integer is `euint128`. Two 128-bit
 * limbs make a 161-bit number that no confidential layer here can hold; two
 * 64-bit limbs make 97 bits, with thirty bits of headroom on each coordinate
 * over the largest board this protocol has run. See the Solidity side for
 * the full reasoning — the two must agree exactly or every revealed point
 * lands somewhere else.
 */
const POINT_LIMB_BITS = 64n
const POINT_LIMB_MASK = (1n << POINT_LIMB_BITS) - 1n

/** A Defense Point as the single confidential word the contract stores. */
export function packDefensePoint(point: DefensePoint, world: WorldGeometry): bigint {
  const { x, y } = defensePointToWorld(point, world)
  return (kmToWu(x) & POINT_LIMB_MASK) | (kmToWu(y) << POINT_LIMB_BITS)
}

export function unpackDefensePoint(packed: bigint, world: WorldGeometry): DefensePoint {
  const x = wuToKm(packed & POINT_LIMB_MASK)
  const y = wuToKm(packed >> POINT_LIMB_BITS)
  return worldToDefensePoint({ x, y }, world)
}

export function pointFromWu(x: bigint, y: bigint): Point2D {
  return { x: wuToKm(x), y: wuToKm(y) }
}

export function toLobbyReveal(
  attackId: string,
  trajectory: AttackTrajectory,
  outcome: ChainOutcome,
): LobbyReveal {
  return {
    attackId,
    trajectory,
    revealedBy: outcome.revealedBy,
    revealedAtBlock: Number(outcome.resolvedAtBlock),
    revealedAtTimestamp: Number(outcome.resolvedAtTimestamp) * 1000,
  }
}
