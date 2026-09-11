/**
 * Core AEGYLAX game-domain data model (spec §52). Every entity here is a
 * plain, serializable value — no class instances, no React state, no
 * blockchain-client references. Pure functions elsewhere in `game/`
 * operate on these types; `game/gameService.ts` is the only place that
 * turns them into blockchain reads/writes.
 */

import type { SealedEnvelope } from './sealing'

export type Address = `0x${string}`
export type Hash = `0x${string}`

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------

/** CREATED is transient (creation tx not yet confirmed) — never persisted. */
export type LobbyStatus = 'CREATED' | 'OPEN' | 'READY' | 'ACTIVE' | 'RESOLVED' | 'CANCELLED'

/**
 * How an operation ended, which is a different question from what state it is
 * in (ТЗ §18) — the chain's `GameTypes.Ending`.
 *
 * `LobbyStatus` is the state machine: it decides which transitions are legal
 * and whether money may still move, and it has two terminal values. There are
 * three ways an operation can actually end, and folding them into two meant
 * "nobody could be bothered to play" and "the protocol failed to run the
 * round" were the same word on screen and the same rule in settlement.
 *
 *   COMPLETED — the round happened: somebody acted, the attack flew and
 *     landed, the operation was scored. Zero interceptions is an ordinary
 *     COMPLETED — the threat won. Nothing is refunded, and an unwon pool goes
 *     to the Global Defense Pool rather than home to the creator.
 *   UNPLAYED  — nobody played: no valid action from anybody, or too few
 *     defenders to start at all. Every wei goes back.
 *   CANCELLED — the protocol failed the round: the attack could not be
 *     completed or published inside the grace window. Every wei goes back,
 *     and it is deliberately a distinct name from UNPLAYED — one of these is
 *     the room's doing and the other is ours.
 *
 * `NONE` while the operation is still running.
 */
export type LobbyEnding = 'NONE' | 'COMPLETED' | 'UNPLAYED' | 'CANCELLED'

export interface RewardAssetConfig {
  /** TODO: only ETH is implemented. ERC-20 / NFT / other rewards are SOON. */
  kind: 'ETH'
}

export interface LobbyConfig {
  /**
   * Creator-chosen name for the operation — required, and what the
   * operation is called everywhere in the UI. The lobby id (its creation
   * transaction hash) stays the only identifier; names are neither unique
   * nor addressable.
   */
  name: string
  participation: {
    minPlayers: number
    maxPlayers: number
    /** ETH */
    entryPrice: number
    /**
     * Unix ms — the time the creator picked, and what the screen shows.
     *
     * Not what the protocol closes applications on. It cannot be: a
     * timestamp has no epoch, and the epoch is what an attack is scheduled
     * against.
     */
    deadline: number
    /**
     * The block applications close on — the authoritative deadline.
     *
     * This is what makes the attack a fact rather than an errand. Because
     * it is a block, the contract derives the attack's epoch when the
     * operation is *created*: the threat launches on its epoch boundary and
     * lands on the next whether or not anybody sends another transaction,
     * and every client counts down to the same block.
     *
     * 0 for an operation created before the protocol worked this way, and
     * in emulator mode where the wall clock is the only deadline there is.
     */
    deadlineBlock: number
  }
  economics: {
    /** ETH, funded by the creator at lobby-creation time. */
    prizePool: number
    creatorFeePercent: number
    /**
     * ETH, protocol creation fee paid by the author at mint. Never refunded.
     */
    protocolJoinFee: number
  }
  drones: {
    freeCount: number
    /** ETH */
    price: number
    maxCount: number
  }
  /**
   * Protocol-owned attack rules, copied onto the operation at creation so
   * its terms cannot change underneath its participants. The creator sets
   * none of them and `validateLobbyConfig` rejects any that differ from
   * the protocol's own (ТЗ §10.3).
   */
  attack: {
    epochBlocks: number
    /** Side of one sector in km — the playfield's only declared scale. */
    sectorSpanKm: number
    /** `DEFENSE_INTERCEPTION_RADIUS`, in sectors (ТЗ §10.2). */
    interceptionRadiusSectors: number
    /** Unused in scoring (snapshot is the submit block). Kept in the params layout. */
    defenseSpeedKmPerBlock: number
  }
  payout: {
    rewardAsset: RewardAssetConfig
    /** TODO: exact payout distribution rule beyond "prize pool goes to the resolved winner(s)". */
  }
}

export interface Lobby {
  /** Always equal to creationTxHash (spec §14). */
  id: Hash
  creationTxHash: Hash
  creator: Address
  createdAtBlock: number
  status: LobbyStatus
  /** How it ended, once it has — see `LobbyEnding`. 'NONE' while running. */
  ending: LobbyEnding
  config: LobbyConfig
  participantCount: number
  participantAddresses: Address[]
  currentEpochId: number | null
  /**
   * The operation's one attack. An operation schedules exactly one
   * attack when applications close, and ends when that attack resolves —
   * `RESULT` is a terminal state, not a lap counter (ТЗ §15).
   */
  activeAttackId: string | null
  /** Populated when the attack resolves — the verdict, not the geometry (ТЗ §12). */
  outcome: AttackOutcome | null
  /**
   * What the creator is owed (ТЗ §14.6): the author commission on a round
   * that ran, or the bounty back when it never ran. The protocol creation
   * fee stays with the treasury either way. The cancelled figure is claimed
   * through `claimRefund` (or already paid in `cancelLobby`); the commission
   * through `settleCreator`. Still this number after it has been paid —
   * `creatorSettled` is the flag that it already went to the wallet. Zero
   * only while the operation is still running.
   */
  creatorSettlement: number
  /**
   * Whether the creator has already taken it. Chain state rather than a
   * local flag, for the same reason `payoutState` is: a settled operation
   * has to still read as settled after a reload and in every other tab.
   */
  creatorSettled: boolean
  /**
   * The Global Defense jackpot standing behind this draw, while the lobby
   * is not the thing holding it.
   *
   * Protocol draws only, and null on every player-created operation. The
   * pile sits in `globalDefensePool` until `commitDrawBounty` escrows it at
   * activation, so `config.economics.prizePool` is 0 for the whole
   * application window — the one stretch where the figure decides whether
   * anybody joins. While the room is OPEN this is the idle pool; once it has
   * ended unplayed it is what the draw was opened with. `drawPrizePool`
   * turns the pair into the one number a screen should print.
   */
  drawBounty?: number | null
  /**
   * The revealed attack geometry, written into the operation's own state by
   * the *first* player who asks for it (ТЗ §4).
   *
   * Null for the whole life of the operation and for as long afterwards as
   * nobody has pressed Reveal. Once it is non-null the geometry is public
   * protocol state: every client reads it on load, nobody needs to reveal
   * again, and the trajectory can be replayed forever.
   */
  reveal: LobbyReveal | null
}

/**
 * What the first Reveal writes on chain (ТЗ §4).
 *
 * It carries the trajectory itself — startPoint, targetPoint and everything
 * derived from them — because that is precisely the half of the attack the
 * protocol was holding back. Recording who asked and when makes the reveal
 * an event in the operation's history rather than a flag.
 */
export interface LobbyReveal {
  attackId: string
  trajectory: AttackTrajectory
  revealedBy: Address
  revealedAtBlock: number
  /** Block timestamp of the reveal, not wall-clock time on the client. */
  revealedAtTimestamp: number
}

// ---------------------------------------------------------------------------
// Participant
// ---------------------------------------------------------------------------

/**
 * `NONE` — nothing owed.
 * `PENDING` — this participant won and may claim (ТЗ §17.2).
 * `PAID` — the reward has been claimed; a second claim is rejected (§17.4).
 */
export type PayoutState = 'NONE' | 'PENDING' | 'PAID'

export interface Participant {
  lobbyId: Hash
  address: Address
  joinTxHash: Hash
  joinedAtBlock: number
  freeDronesRemaining: number
  purchasedDrones: number
  /**
   * How many private actions this address has sent (ТЗ §4).
   *
   * The one thing about a defender's play that is public mid-round, and
   * deliberately the *only* thing: a transaction happened, and there were
   * this many of them. Which of those were Recon Probes and which was the
   * Defense is exactly what §4 says an observer must not be able to work
   * out, so the breakdown below is redacted for everyone but the owner
   * until the operation reveals.
   */
  actionCount: number
  /**
   * One id per Recon Probe this participant has spent (ТЗ §1.1) — probes
   * are not aimed, so there is no sector on them. Empty on a participant
   * read by anybody but themselves, until the reveal.
   */
  probeIds: string[]
  /** Same redaction as `probeIds`: its length alone would name the action. */
  defenseAttemptIds: string[]
  payoutState: PayoutState
  /**
   * Everything this address has paid into the operation — entry, the
   * author's commission and every Recon Probe it bought (ТЗ §18).
   *
   * It is the refund basis, which is why it is a stored number rather than
   * something a screen recomputes from the config: probes are bought one at
   * a time and a config read a week later is not evidence of what somebody
   * actually paid. Public, because a chain cannot hide what an address sent.
   */
  paidIn: number
  /**
   * Of `paidIn`, the part spent on Recon Probes.
   *
   * Tracked rather than recomputed from a count and the current price,
   * because the price is protocol-owned and may be governed between a
   * purchase and a refund. The Leave control reads this on a protocol-owned
   * draw so it names what leaving actually pays back.
   */
  probesPaid: number
  /**
   * Whether this participant has already taken the refund a cancelled
   * operation owes them (ТЗ §18). Mirrors `payoutState` for the reward: the
   * protocol's own record, so REFUNDED survives a reload and a second
   * refund is impossible to stage from the UI.
   */
  refunded: boolean
  /**
   * Block this participant last sent a probe. 0 if they never have.
   * A second send before `lastProbeBlock + PROBE_DELAY_BLOCKS` is refused.
   */
  lastProbeBlock: number
}

// ---------------------------------------------------------------------------
// Epochs & attacks
// ---------------------------------------------------------------------------

export interface AttackEpoch {
  lobbyId: Hash
  epochId: number
  startBlock: number
  endBlock: number
  seed: Hash
  attackIds: string[]
}

/**
 * PENDING — scheduled at a future epoch boundary, nothing in flight yet.
 * LAUNCHED — in flight; its geometry is still sealed (ТЗ §3.3).
 * RESOLVED — flight over and judged; the geometry is available to anyone
 *            who asks for the reveal (ТЗ §12, §13).
 */
export type AttackStatus = 'PENDING' | 'LAUNCHED' | 'RESOLVED'

/** Playfield coordinates in km, as laid out by `game/world.ts`. */
export interface Point2D {
  x: number
  y: number
}

/**
 * The part of an attack the protocol keeps to itself until the player asks
 * for the reveal (ТЗ §3.3-3.5, §13). Everything a defender is allowed to
 * learn before then comes from reconnaissance, never from reading the
 * attack.
 */
export interface AttackTrajectory {
  /** startPoint — on the working area's outer edge (ТЗ §3.1). */
  pointA: Point2D
  /** targetPoint — on Earth's surface (ТЗ §3.2). */
  pointB: Point2D
  /**
   * Where `pointB` sits on the globe, as an angle from the +x axis.
   *
   * Redundant with `pointB` in the canonical world, and deliberately so:
   * Earth is drawn as a scene object at the bottom of the viewport rather
   * than at a grid coordinate, so the reveal needs an orientation-free way
   * to land the impact exactly on the painted rim. The angle is that way;
   * `pointB` remains what interception is computed against.
   */
  impactAngleRadians: number
  /**
   * Where the launch sits as seen from Earth's centre, same convention.
   * The reveal draws the approach around the *painted* globe; without this
   * angle it used `pointA` projected through the grid, and a chord between
   * two different Earths looked like it came from the wrong side of the sky.
   */
  launchBearingRadians?: number
  /** `distance(pointA, pointB)` — different for every attack (ТЗ §5.2). */
  lengthKm: number
  /**
   * `lengthKm / flightDurationBlocks` (ТЗ §5.4). Sealed along with the
   * geometry rather than published on `Attack`: speed times the epoch is
   * the distance from Earth to the launch point, so a public speed would
   * be a public half of the hidden trajectory.
   */
  speedKmPerBlock: number
}

/**
 * The public half of an attack: its schedule and nothing else. There is no
 * `trajectory` field to forget to strip — the geometry only ever travels as
 * an `AttackRevealData`, which the chain refuses to produce before
 * resolution (ТЗ §3.4-3.5, §13).
 */
export interface Attack {
  id: string
  lobbyId: Hash
  epochId: number
  launchBlock: number
  launchTimestamp: number
  /** Always `launchBlock + flightDurationBlocks`, i.e. the next epoch boundary (ТЗ §5.3). */
  impactBlock: number
  impactTimestamp: number
  flightDurationBlocks: number
  status: AttackStatus
}

/** The revealed result of an operation's attack (ТЗ §11, §12, §16). */
export interface AttackOutcome {
  attackId: string
  intercepted: boolean
  /**
   * Where along the trajectory the winning defense first entered its
   * interception radius, or null when the attack reached Earth (ТЗ §11.5).
   */
  interceptionPoint: Point2D | null
  /**
   * The winning interception, as a block number and as a 0..1 fraction
   * through the flight. Null when nothing intercepted. This is the number
   * §11.6 ranks defenders by: earliest takes the round.
   */
  interceptionBlock: number | null
  interceptionProgress: number | null
  /** The protocol-defined radius the comparison used (ТЗ §10.2). */
  interceptionRadiusKm: number
  /**
   * The winner (ТЗ §11.6): whoever hit the threat earliest — highest, since
   * arrival is the submit block. An array because that block can hold any
   * number of hits, and they split the pool.
   */
  winners: Address[]
  /** ETH each winner may claim. 0 when the attack reached Earth (ТЗ §17.1). */
  rewardPerWinner: number
  resolvedAtBlock: number
  /**
   * The block timestamp of the impact (ТЗ §6).
   *
   * This is the operation's permanent clock reading, and the planet's
   * orientation is a pure function of it: `earthPosition = f(timestamp)`.
   * Recording it on the outcome — chain state, not a client cache — is what
   * makes a resolved operation show the *same* face of Earth on every
   * reload, in every browser, a month later.
   */
  resolvedAtTimestamp: number
}

/**
 * Everything the protocol sealed, handed over at once when a player asks
 * for the reveal (ТЗ §13, §14).
 *
 * It exists as one value because the reveal is one event: there is no state
 * in which the trajectory is public but the Defense Points are not, and
 * building it as a single read is what makes that impossible to get wrong.
 */
export interface AttackRevealData {
  attackId: string
  /** ТЗ §13.2-13.4 — startPoint, targetPoint and the trajectory between them. */
  trajectory: AttackTrajectory
  outcome: AttackOutcome
  /** ТЗ §14.2 — every participant's Defense Point, no longer redacted. */
  attempts: DefenseAttempt[]
  /** ТЗ §14.3-14.5 — HIT/MISS and the interception time behind each one. */
  results: DefenseResult[]
  revealedAtBlock: number
  /**
   * The flight's own clock. A timing miss puts the threat back on the trail
   * at the defender's submit; without launch and duration that point cannot
   * be recovered from the geometry alone.
   */
  launchBlock: number
  flightDurationBlocks: number
  /**
   * Whether **this operation** has been scored, as distinct from whether the
   * epoch's geometry is public.
   *
   * They are two different events and they used to be conflated, at real cost.
   * One threat crosses the playfield per epoch, and publishing where it went
   * is a single transaction for the whole world: the moment anybody sends it,
   * `getTrajectory` answers for everyone, forever, with no wallet involved.
   * Scoring a *team* is a separate transaction per team, and it is the only
   * part that needs this operation's own defenders decrypted.
   *
   * Treating "revealed" as one fact meant an operation showed nothing at all —
   * empty sky, sealed result — until its own scoring landed, even when the
   * trajectory it was waiting for had been public on chain for minutes. The
   * data was there to read and the screen was refusing to read it.
   *
   * So a reveal now arrives in two stages. `trajectory` is filled as soon as
   * the epoch is open, and `scored` says whether `outcome`, `attempts` and
   * `results` mean anything yet. Every consumer that shows a verdict checks
   * it; the ones that only draw the flight path do not have to.
   */
  scored: boolean
}

// ---------------------------------------------------------------------------
// Map / sectors
// ---------------------------------------------------------------------------

export interface Sector {
  column: number
  row: number
}

export interface MapGridConfig {
  columns: number
  rows: number
}

export interface SectorBounds {
  sector: Sector
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

/**
 * Public activity on one sector.
 *
 * Reconnaissance is deliberately absent: a Recon Probe sweeps the whole
 * working area rather than a sector (ТЗ §1.1), so there is no sector for it
 * to be counted against. Where defenders committed is the only per-sector
 * activity the protocol has to show.
 */
export interface ActivityCell {
  sector: Sector
  defenseAttemptCount: number
}

// ---------------------------------------------------------------------------
// Recon Probes ("drones" in the domain model)
// ---------------------------------------------------------------------------

/**
 * What one Recon Probe brings back (ТЗ §1.2).
 *
 * A probe is a shutter: it returns a noisy snapshot of where the attack is
 * *now*. The cloud is the search corridor; `mark` is that snapshot, already
 * offset, never the exact coordinate Reveal will draw. Several probes over
 * the flight form a trail because the attack is moving.
 */
export interface ReconProbeResult {
  /**
   * Where to look, in degrees clockwise from east with +y down — the same
   * convention the scene uses, measured from Earth's centre outward.
   */
  bearingDegrees: number
  /** Eight-point compass label for the same bearing. */
  direction: string
  /**
   * Where the noisy chord meets Earth, same convention as `bearingDegrees`.
   * The cloud is this chord, not the radial through Earth's centre.
   */
  impactBearingDegrees?: number
  /** Half-width of the uncertainty cone this reading leaves, in degrees. */
  uncertaintyDegrees: number
  confidencePercent: number
  /** Grid sectors with a raised chance of carrying the threat's path (ТЗ §1.2). */
  sectorIds: string[]
  generatedAtBlock: number
  epochId: number
  /**
   * Occupancy snapshot at the probe's send time, already offset off the
   * true chord. Present from the first probe.
   */
  mark?: Point2D
}

export interface ReconProbeRecord extends ReconProbeResult {
  id: string
  lobbyId: Hash
  attackId: string
  probeId: string
  requestedBy: Address
  txHash: Hash
}

export interface DronePurchase {
  lobbyId: Hash
  participant: Address
  droneId: string
  txHash: Hash
  purchasedAtBlock: number
  price: number
}

// ---------------------------------------------------------------------------
// Defense / PPO
// ---------------------------------------------------------------------------

/**
 * Where a defender puts their interceptor (ТЗ §7).
 *
 * A sector plus a fraction along each of that sector's own axes, rather
 * than absolute coordinates: the pair `{ sector, offset }` is the same
 * place on every device and at every grid size, and it makes the two-step
 * pick — choose a sector, then a point inside it — the literal shape of
 * the data. `game/world.ts` is the only thing that turns it into km.
 */
export interface DefensePoint {
  sector: Sector
  /** 0..1 across the sector's column axis. */
  offsetX: number
  /** 0..1 down the sector's row axis. */
  offsetY: number
}

export interface DefenseAttempt {
  id: string
  lobbyId: Hash
  attackId: string
  participant: Address
  /**
   * The coordinate in the clear — and therefore null for every attempt,
   * including your own, until somebody has revealed (ТЗ §7, §11).
   *
   * The protocol never stores this: what it holds is the sealed point the
   * player submitted, which resolution opens internally and Reveal opens
   * publicly. So there is no read, no event and no persisted record from
   * which a plaintext Defense Point can be lifted mid-round.
   */
  defensePoint: DefensePoint | null
  /**
   * The same coordinate, sealed to the reader's own key — set only when the
   * reader *is* the owner, and only while `defensePoint` is still null.
   *
   * This is what lets a defender's own screen redraw their locked point
   * after a reload without the protocol handing plaintext coordinates to
   * the browser (ТЗ §11). `openOwnDefensePoint` is the only thing that
   * opens it.
   */
  sealedPoint: SealedEnvelope | null
  submittedAtBlock: number
  submittedAtTimestamp: number
  txHash: Hash
}

/**
 * `intercepted` — the threat entered this Defense Point's interception
 * radius before impact (ТЗ §11.2-11.3).
 * `missed` — it never did, and this attempt earns nothing (ТЗ §17.1).
 * `pending` — the attack has not resolved yet, so there is no answer to give.
 */
export type DefenseResolutionStatus = 'pending' | 'intercepted' | 'missed'

export interface DefenseResult {
  attemptId: string
  participant: Address
  status: DefenseResolutionStatus
  /**
   * When the threat first entered this point's interception radius, as a
   * 0..1 fraction through the flight and as a block. Null only when it
   * never entered — a spatial miss. A late intercept still has a time:
   * that is how "on the path, too late" is told apart from "never close"
   * (ТЗ §5, §11.5).
   */
  interceptionProgress: number | null
  interceptionBlock: number | null
  /** Where on the trajectory that entry happened. Null when it never entered. */
  interceptionPoint: Point2D | null
  /** Closest the Defense Point ever came to the trajectory — how near a miss was. */
  missDistanceKm: number | null
  /**
   * When the snapshot was taken — the submit block. Null while pending.
   */
  arrivalBlock: number | null
  /**
   * A snapshot hit is a win. Every defender whose radius contained the
   * threat *at their submit* has `status: 'intercepted'` and this flag;
   * they split the pool.
   */
  isWinner: boolean
  reason: string
}

// ---------------------------------------------------------------------------
// Economics
// ---------------------------------------------------------------------------

/**
 * The four money flows of an operation, kept separate on purpose (ТЗ §14).
 *
 * The Start Prize Pool is the creator's bounty. Entry fees fold into the
 * reward pool in full when the round starts. The author's commission is a
 * separate payment, collected at join.
 */
export interface PrizePool {
  lobbyId: Hash
  /** Creator-funded bounty — the reward pool itself (§14.1). */
  startPrizePool: number
  /** Entry fees collected from participants (§14.2). */
  entryFeesCollected: number
  /** Creator's cut of the entry fees; paid whatever the outcome (§14.4, §14.6). */
  creatorFeeReserved: number
  /** Protocol's cut (§14.5). */
  protocolFeeReserved: number
  /**
   * Entry fees left after both fees. TODO (§14.12): the final economy has
   * not said where this goes — it is deliberately not swept into the
   * reward pool, and never leaves this operation (§14.11).
   */
  entryFeeResidual: number
  /** What winners share on a successful interception. */
  distributable: number
}

// ---------------------------------------------------------------------------
// Global stats
// ---------------------------------------------------------------------------

export interface GameStats {
  activeLobbies: number
  /** Lifetime count of defense operations ever created — never decremented when one resolves or is cancelled. */
  totalLobbies: number
  /** Lifetime count of attacks the protocol has generated, including the current unresolved one. */
  totalAttacks: number
  interceptedAttacks: number
  missedAttacks: number
  currentBlock: number
  /**
   * The protocol's current epoch — its position in the blockchain
   * timeline, not a count of anything. Derived chain-side from
   * `currentBlock` via the same `getEpochFromBlock` math the attack
   * generator uses, so every client reads one identical number instead
   * of each recomputing an approximation locally.
   */
  currentEpoch: number
  /**
   * The Global Defense Pool (ТЗ §18) — every COMPLETED round the threat
   * won, waiting to be played for again. ETH. Never owner-withdrawable.
   */
  globalDefensePool: number
  /**
   * The protocol's own draw operation for this interval, if somebody has
   * already called `openGlobalDefense`. Null while the pool is waiting.
   */
  globalDefenseLobbyId: Hash | null
}

/**
 * When the Global Defense Pool is next played for (ТЗ §18).
 *
 * `lobbyId` is null until somebody sends `openGlobalDefense` — the protocol
 * has no keeper, so opening the draw is permissionless and the first client
 * to notice it is due sends the transaction.
 */
export interface GlobalDefenseDraw {
  nextEpoch: number
  /** 0 means the cadence is off and the pool only accumulates. */
  interval: number
  pool: number
  lobbyId: Hash | null
}
