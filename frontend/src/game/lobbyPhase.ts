import type { Attack, DefenseAttempt, DefensePoint, Lobby } from './types'
import { PROBE_DELAY_BLOCKS } from './recon'

/**
 * The state machine the Operation screen renders (ТЗ §15).
 *
 * It is not stored anywhere: the phase is a reading of the chain's own
 * `LobbyStatus` plus the attack's status. Deriving it keeps the single
 * source of truth on chain and makes the UI states impossible to get out
 * of step with it — there is no second place holding a copy that could
 * drift.
 *
 * There used to be a parallel `PlayerPhase` here, rendered as a "You"
 * readout on the Command Center. ТЗ §3.2 removed that readout as a
 * duplicate — what the player has done is already visible on the two
 * controls and the Defense bubble — and the machine went with it rather
 * than staying on as state nothing displays.
 */

/**
 * OPEN               — applications are being accepted.
 * UNDERSUBSCRIBED    — the deadline passed without the minimum defenders
 *                      (ТЗ §18). The operation cannot run; all it can do now
 *                      is be cancelled so refunds unlock.
 * WAITING_FOR_ATTACK — applications closed, an attack is scheduled ahead.
 * ATTACK_INCOMING    — the launch is imminent (ТЗ §4).
 * ATTACK_ACTIVE      — in flight; the grid is live and Defense is open (ТЗ §4.5).
 * RESULT             — resolved and revealed (ТЗ §11).
 * CANCELLED          — the operation will not pay out as a contest. Three
 *                      stories share this status byte: too few defenders,
 *                      enough joined but nobody sent a probe or intercept,
 *                      or the protocol itself failed the round. The reason
 *                      lives on `ending` and the player count — see
 *                      `refundCause`.
 */
export type LobbyPhase =
  | 'OPEN'
  | 'UNDERSUBSCRIBED'
  | 'WAITING_FOR_ATTACK'
  | 'ATTACK_INCOMING'
  | 'ATTACK_ACTIVE'
  | 'RESULT'
  | 'CANCELLED'

/** How close to launch the countdown switches into its Attack Incoming state (ТЗ §4.4). */
export const ATTACK_INCOMING_BLOCKS = 15

export function deriveLobbyPhase(
  lobby: Pick<Lobby, 'status' | 'participantCount' | 'config'>,
  attack: Pick<Attack, 'status' | 'launchBlock'> | null,
  currentBlock: number | null,
  /**
   * Wall-clock now — the fallback deadline, and the only one an emulator
   * operation has.
   *
   * A deadline passing changes no on-chain byte either way: the lobby stays
   * OPEN until somebody's action settles its money or cancels it. Against
   * the contract the *block* deadline decides (see `applicationsClosed`);
   * this is what answers when there is no block deadline to read. Optional
   * so callers that only care about the attack keep working, and because a
   * caller with no clock to hand is better off reading OPEN than guessing.
   */
  nowMs?: number,
): LobbyPhase {
  if (lobby.status === 'CANCELLED') return 'CANCELLED'
  if (lobby.status === 'RESOLVED') return 'RESULT'
  if (lobby.status === 'OPEN') {
    if (!applicationsClosed(lobby, currentBlock, nowMs)) return 'OPEN'

    /*
     * ТЗ §18 — an operation past its deadline with too few defenders is not
     * "open", whatever the chain's status byte still says.
     *
     * Reporting OPEN here was wrong in the way that matters: it is the
     * exact state in which everybody's entry fee is stuck on the contract
     * and the only thing left to do is cancel so it can be claimed. A
     * screen headed OPEN invites people to join an operation that can never
     * run, and tells the defenders already in it that they are waiting for
     * something.
     */
    if (lobby.participantCount < lobby.config.participation.minPlayers) return 'UNDERSUBSCRIBED'

    /*
     * Only an operation that scheduled its own attack runs while the status
     * byte still says OPEN. Without a deadline block there is nothing in
     * the sky yet — the emulator, and any operation created before the
     * protocol worked this way, still wait for a transition to be sent —
     * and calling that "under way" would start a countdown to an attack
     * that does not exist.
     */
    const selfScheduled = lobby.config.participation.deadlineBlock > 0 && currentBlock !== null
    if (!selfScheduled) return 'OPEN'

    /*
     * Otherwise: falls through to the attack, deliberately.
     *
     * OPEN is a status the chain can sit in *after* an operation is really
     * running. The attack is scheduled when the operation is created and
     * flies on its own; the OPEN -> ACTIVE byte is only the money settling,
     * and that happens as a side effect of the first player's action. Going
     * by the byte would leave the screen showing a join form over an attack
     * already in the sky — with the controls locked, so nothing could ever
     * settle it and the operation would never leave OPEN.
     */
  }

  return derivePhaseFromAttack(attack, currentBlock)
}

/**
 * Whether the application window is over.
 *
 * The block is the authority — it is the deadline the protocol enforces and
 * the one the attack's epoch was derived from. The timestamp is the
 * fallback for the two cases with no block deadline to read: emulator mode,
 * and an operation created before the protocol scheduled its own attacks.
 */
function applicationsClosed(
  lobby: Pick<Lobby, 'config'>,
  currentBlock: number | null,
  nowMs: number | undefined,
): boolean {
  const { deadline, deadlineBlock } = lobby.config.participation
  if (deadlineBlock > 0 && currentBlock !== null) return currentBlock >= deadlineBlock
  return nowMs !== undefined && nowMs >= deadline
}

function derivePhaseFromAttack(
  attack: Pick<Attack, 'status' | 'launchBlock'> | null,
  currentBlock: number | null,
): LobbyPhase {
  // No attack to read yet: applications have closed and the operation has
  // not been told what it is facing.
  if (!attack) return 'WAITING_FOR_ATTACK'
  if (attack.status === 'RESOLVED') return 'RESULT'
  if (attack.status === 'LAUNCHED') return 'ATTACK_ACTIVE'

  const blocksToLaunch = currentBlock === null ? Number.POSITIVE_INFINITY : attack.launchBlock - currentBlock
  return blocksToLaunch <= ATTACK_INCOMING_BLOCKS ? 'ATTACK_INCOMING' : 'WAITING_FOR_ATTACK'
}

/** Human-facing label for each phase — the exact wording ТЗ §15 asks for. */
export function lobbyPhaseLabel(phase: LobbyPhase): string {
  switch (phase) {
    case 'OPEN':
      return 'OPEN'
    case 'UNDERSUBSCRIBED':
      // Names the fact rather than the pending transaction: what happened is
      // that not enough people joined, and "awaiting cancellation" would
      // describe the paperwork instead of the outcome.
      return 'NOT ENOUGH DEFENDERS'
    case 'WAITING_FOR_ATTACK':
      return 'WAITING FOR ATTACK'
    case 'ATTACK_INCOMING':
      return 'ATTACK INCOMING'
    case 'ATTACK_ACTIVE':
      return 'ATTACK ACTIVE'
    case 'RESULT':
      return 'RESULT'
    case 'CANCELLED':
      return 'CANCELLED'
  }
}

/** Phases in which the operation is over, whatever the chain's status byte says. */
export function isOperationOver(phase: LobbyPhase): boolean {
  return phase === 'RESULT' || phase === 'CANCELLED' || phase === 'UNDERSUBSCRIBED'
}

/**
 * Why a cancelled operation is giving the money back (ТЗ §18).
 *
 * `LobbyStatus.CANCELLED` is one byte covering three stories, and folding
 * them into "not enough defenders joined" was the bug: a room that filled,
 * flew, and then had nobody send a probe or intercept is UNPLAYED for a
 * different reason, and the tagline has to say so.
 *
 *   undersubscribed — the deadline passed short of `minPlayers`.
 *   unplayed        — enough people sat, but nobody acted.
 *   protocol        — the attack could not be completed or published.
 */
export type RefundCause = 'undersubscribed' | 'unplayed' | 'protocol'

export function refundCause(
  lobby: Pick<Lobby, 'ending' | 'participantCount' | 'config'>,
): RefundCause {
  if (lobby.ending === 'CANCELLED') return 'protocol'
  if (lobby.participantCount < lobby.config.participation.minPlayers) return 'undersubscribed'
  return 'unplayed'
}

/**
 * The word on the operation's status pill.
 *
 * Chain `LobbyStatus` is what every running phase prints. CANCELLED is the
 * exception: it is one byte covering three endings, and printing it on a
 * room that filled and then sat idle names the paperwork instead of what
 * happened. UNPLAYED is the protocol's own name for that case.
 */
export function operationStatusLabel(
  lobby: Pick<Lobby, 'status' | 'ending' | 'participantCount' | 'config'>,
): string {
  if (lobby.status !== 'CANCELLED') return lobby.status
  return refundCause(lobby) === 'unplayed' ? 'UNPLAYED' : 'CANCELLED'
}

/**
 * Whether Send Defense may fire (ТЗ §8.5). Every clause is a separate
 * reason so the button can say which one is missing instead of just going
 * grey — and the emulator re-checks all of them on the write, so this only
 * decides what the control looks like.
 *
 * The `ATTACK_ACTIVE` gate is ТЗ §4.5: grid selection unlocks when the
 * attack launches, so there is no window in which a Defense Point could be
 * placed and sent against an attack that is not yet in the sky.
 */
/**
 * Blocks left on the probe cooldown, or null when it has run out.
 *
 * Both callers used to say the probe was "still in flight", which was true
 * when `DELAY_BLOCKS` gated the *read*. It does not any more: the hint is
 * granted by the transaction that computes it, so by the time a player sees
 * this the reading is already in their hands and nothing is in the air.
 * What survived is the rule the delay became — a reading cannot be *spent*
 * for this many blocks, on another probe or on a Defense Point.
 *
 * Telling somebody to wait for an answer they are holding is worse than
 * saying nothing: they refresh, they check the wallet, they assume it broke.
 * So the wait is named and counted instead.
 */
export function probeCooldownBlocks(lastProbeBlock: number | undefined, currentBlock: number | null | undefined): number | null {
  const last = lastProbeBlock ?? 0
  if (last <= 0 || currentBlock == null) return null
  const remaining = last + PROBE_DELAY_BLOCKS - currentBlock
  return remaining > 0 ? remaining : null
}

/** "3 blocks" / "1 block" — the unit the rest of the operation screen counts in. */
function blocks(count: number): string {
  return `${count} block${count === 1 ? '' : 's'}`
}

export function defenseBlockedReason(input: {
  hasJoined: boolean
  lobbyPhase: LobbyPhase
  submittedAttempt: DefenseAttempt | null
  selectedSectorId: string | null
  stagedPoint: DefensePoint | null
  /** Block this participant last sent a probe. 0 if they never have. */
  lastProbeBlock?: number
  currentBlock?: number | null
}): string | null {
  if (!input.hasJoined) return 'Join the operation to send Defense'
  if (input.submittedAttempt) return 'Defense already submitted'
  if (isOperationOver(input.lobbyPhase)) return 'This operation has ended'
  if (input.lobbyPhase === 'OPEN') return 'Applications are still open'
  if (input.lobbyPhase !== 'ATTACK_ACTIVE') return 'Defense opens when the attack launches'
  /*
   * The half of `PROBE_DELAY_BLOCKS` that is not about probes.
   *
   * Reconnaissance costs time, not just an allowance: a reading cannot be
   * spent on a Defense Point until the probe that produced it has landed.
   * The protocol refuses this outright (`AegylaxGame.submitDefense`), so
   * without the clause here the button would look live and revert.
   *
   * It sits above the placement clauses on purpose — a player waiting out
   * the delay should be told what they are waiting for, not asked to pick a
   * sector they have already picked.
   */
  const cooldown = probeCooldownBlocks(input.lastProbeBlock, input.currentBlock)
  if (cooldown !== null) {
    return `Defense opens in ${blocks(cooldown)} — a reading cannot be spent the moment it arrives`
  }
  if (!input.selectedSectorId) return 'Select a sector first'
  if (!input.stagedPoint) return 'Place a Defense Point inside the sector'
  return null
}

/**
 * Whether the Reveal control should be offered (ТЗ §4).
 *
 * Two conditions, and the interesting one is what is *absent*: the
 * operation's outcome. This used to require `lobby.outcome !== null`, which
 * looks reasonable and is wrong on a real chain — there the outcome does not
 * exist until somebody reveals, because it is the reveal that resolves the
 * round. Requiring one to offer the button that produces it meant the button
 * never appeared in contract mode, and every operation dead-ended at impact
 * with its reward permanently unclaimable.
 *
 * The emulator hid the bug by resolving eagerly at the impact block, so its
 * outcome was non-null before any reveal. That divergence is the whole
 * reason this is a named rule with a test rather than a condition inline in
 * a component.
 *
 * `revealLoaded` carries the other half: `revealed === null` on its own
 * cannot tell "nobody has revealed" from "we have not asked the chain yet",
 * and the second is briefly true on every load — which would flash a Reveal
 * button on operations that were revealed weeks ago.
 */
export function canRevealAttack(input: {
  lobbyPhase: LobbyPhase
  /** The chain has answered `getAttackReveal` at least once for this attack. */
  revealLoaded: boolean
  /**
   * Whether **this operation** has been scored — not whether the epoch's
   * geometry is public.
   *
   * The distinction is what keeps the control correct when two teams share an
   * epoch. Publishing the trajectory is one transaction for the world, so the
   * second team routinely finds it already done; scoring is one transaction
   * per team, and until theirs lands nobody in it has a verdict or a
   * claimable reward. Keying this on "has anything been revealed" would take
   * the control away from every operation but the first, permanently, and
   * strand its pool.
   */
  isScored: boolean
}): boolean {
  return input.lobbyPhase === 'RESULT' && input.revealLoaded && !input.isScored
}

/**
 * Whether the map still carries a reconnaissance picture (ТЗ §3, §7-§8).
 *
 * The corridor and its marks are a guess at where the threat is while
 * nobody can see it. The reveal answers that question, and an answer and a
 * guess must not share the board: left up beside the real trajectory, the
 * estimate reads as a second claim about where the attack went, and the
 * player is invited to compare a probability with a fact.
 *
 * The trap is the same one `canRevealAttack` is built around, and it is why
 * this is a named rule rather than `verdict !== null` inline in the page.
 * The reveal's absence means two things — "nobody has revealed" and "this
 * client has not finished asking" — and on a reload of an operation that
 * finished long ago the second is true for the first seconds. Read as the
 * first, it paints the corridor across a map that is about to draw the real
 * trajectory underneath it: the wrong picture, on exactly the operations
 * that have a right one waiting.
 *
 * Whether the round is over needs no read — it is in the operation's own
 * state, which is in hand before anything renders — so a finished operation
 * shows no reconnaissance until the reveal read has spoken. When it does
 * speak and says nobody has revealed, the estimate goes back up: that is
 * the one window where the guess is still the best thing anyone has.
 */
export function showsReconnaissance(input: {
  lobbyPhase: LobbyPhase
  /** The chain has answered `getAttackReveal` at least once for this attack. */
  revealLoaded: boolean
  /** Whether **this operation** has been scored — see `canRevealAttack`. */
  isScored: boolean
}): boolean {
  if (input.isScored) return false
  if (isOperationOver(input.lobbyPhase)) return input.revealLoaded
  return true
}

/**
 * Whether Recon Probes may still be *bought* (ТЗ §3).
 *
 * A different window from sending one, and deliberately the opposite end of
 * the operation. Probes are equipment: they are bought while there is still
 * time to prepare — applications open, or closed with the attack scheduled
 * but not yet airborne — and they are *spent* during the flight.
 *
 * Allowing a purchase mid-flight would collapse that distinction in the
 * attacker's favour. Reconnaissance stays open right up to a player's own
 * Send Defense, so a defender who prepared for nothing could watch the
 * launch, then buy a full allowance and a fix with it. Preparing for an
 * attack and reacting to one are meant to cost different things.
 *
 * The contract enforces exactly this window in `buyProbes`, so this only
 * decides what the control looks like.
 */
export function probePurchaseBlockedReason(input: {
  hasJoined: boolean
  lobbyPhase: LobbyPhase
  probesOwned: number
  maxProbes: number
}): string | null {
  if (!input.hasJoined) return 'Join the operation to buy Recon Probes'
  if (isOperationOver(input.lobbyPhase)) return 'This operation has ended'
  if (input.lobbyPhase === 'ATTACK_ACTIVE') return 'The attack has launched — probes can no longer be bought'
  if (input.probesOwned >= input.maxProbes) return 'Maximum Recon Probes reached'
  return null
}

/**
 * Whether a Recon Probe may be sent (ТЗ §4.4, §6.1).
 *
 * Reconnaissance is bounded at both ends by the attack itself: it opens
 * when the attack launches — there is nothing in flight to scan before
 * that — and it closes at the player's own Send Defense (§9.4), not at
 * impact. Probes therefore stay useful right through the flight, which is
 * the whole of the play between launch and submission.
 */
export function reconBlockedReason(input: {
  hasJoined: boolean
  lobbyPhase: LobbyPhase
  probesRemaining: number
  submittedAttempt: DefenseAttempt | null
  /** Block this participant last sent a probe. 0 if they never have. */
  lastProbeBlock?: number
  currentBlock?: number | null
}): string | null {
  if (!input.hasJoined) return 'Join the operation to send Recon Probes'
  if (isOperationOver(input.lobbyPhase)) return 'This operation has ended'
  if (input.lobbyPhase !== 'ATTACK_ACTIVE') return 'Reconnaissance opens when the attack launches'
  if (input.submittedAttempt) return 'Defense is submitted — reconnaissance is closed'
  if (input.probesRemaining <= 0) return 'No Recon Probes available'
  const cooldown = probeCooldownBlocks(input.lastProbeBlock, input.currentBlock)
  if (cooldown !== null) return `Next probe in ${blocks(cooldown)}`
  return null
}
