import { describe, expect, it } from 'vitest'
import {
  ATTACK_INCOMING_BLOCKS,
  canRevealAttack,
  defenseBlockedReason,
  deriveLobbyPhase,
  isOperationOver,
  lobbyPhaseLabel,
  probePurchaseBlockedReason,
  reconBlockedReason,
  refundCause,
  showsReconnaissance,
  operationStatusLabel,
  type LobbyPhase,
} from '../../game/lobbyPhase'
import type { DefenseAttempt, DefensePoint, Lobby } from '../../game/types'

const point: DefensePoint = { sector: { column: 1, row: 1 }, offsetX: 0.5, offsetY: 0.5 }
const submitted = { id: 'a', participant: '0xa', defensePoint: point } as unknown as DefenseAttempt

/**
 * The slice of a lobby the phase is derived from.
 *
 * `participantCount`/`minPlayers`/`deadline` are here because one phase —
 * the deadline passing with too few defenders (ТЗ §18) — is not visible in
 * the status byte at all: on chain that lobby is still OPEN until somebody
 * sends `cancelLobby`. Defaults put every case comfortably inside the
 * "enough defenders, deadline ahead" corner so a test only states the fact
 * it is about.
 */
function lobbyOf(
  status: Lobby['status'],
  { participantCount = 5, minPlayers = 2, deadline = 10_000, deadlineBlock = 0 } = {},
) {
  return {
    status,
    participantCount,
    config: { participation: { minPlayers, deadline, deadlineBlock } },
  } as unknown as Parameters<typeof deriveLobbyPhase>[0]
}

function attack(status: 'PENDING' | 'LAUNCHED' | 'RESOLVED', launchBlock = 1000) {
  return { status, launchBlock }
}

describe('lobby phase (ТЗ §15)', () => {
  it('is OPEN while applications are being accepted', () => {
    expect(deriveLobbyPhase(lobbyOf('OPEN'), null, 100)).toBe('OPEN')
  })

  it('waits for the attack once applications close and before the launch is near', () => {
    expect(deriveLobbyPhase(lobbyOf('READY'), null, 100)).toBe('WAITING_FOR_ATTACK')
    expect(deriveLobbyPhase(lobbyOf('ACTIVE'), attack('PENDING', 1000), 100)).toBe('WAITING_FOR_ATTACK')
  })

  it('switches to ATTACK INCOMING as the launch block approaches (ТЗ §4.4)', () => {
    const launchBlock = 1000
    expect(deriveLobbyPhase(lobbyOf('ACTIVE'), attack('PENDING', launchBlock), launchBlock - ATTACK_INCOMING_BLOCKS)).toBe(
      'ATTACK_INCOMING',
    )
    expect(
      deriveLobbyPhase(lobbyOf('ACTIVE'), attack('PENDING', launchBlock), launchBlock - ATTACK_INCOMING_BLOCKS - 1),
    ).toBe('WAITING_FOR_ATTACK')
  })

  it('is ATTACK ACTIVE in flight and RESULT once resolved', () => {
    expect(deriveLobbyPhase(lobbyOf('ACTIVE'), attack('LAUNCHED'), 1001)).toBe('ATTACK_ACTIVE')
    expect(deriveLobbyPhase(lobbyOf('ACTIVE'), attack('RESOLVED'), 2000)).toBe('RESULT')
    expect(deriveLobbyPhase(lobbyOf('RESOLVED'), attack('RESOLVED'), 2000)).toBe('RESULT')
  })

  it('reports cancellation ahead of everything else', () => {
    expect(deriveLobbyPhase(lobbyOf('CANCELLED'), attack('PENDING'), 100)).toBe('CANCELLED')
  })

  it('does not claim the launch is near when the block feed has not arrived', () => {
    expect(deriveLobbyPhase(lobbyOf('ACTIVE'), attack('PENDING'), null)).toBe('WAITING_FOR_ATTACK')
  })

  it('labels every phase exactly as ТЗ §15 names it', () => {
    const labels = (['OPEN', 'WAITING_FOR_ATTACK', 'ATTACK_INCOMING', 'ATTACK_ACTIVE', 'RESULT'] as LobbyPhase[]).map(
      lobbyPhaseLabel,
    )
    expect(labels).toEqual(['OPEN', 'WAITING FOR ATTACK', 'ATTACK INCOMING', 'ATTACK ACTIVE', 'RESULT'])
  })
})

describe('refundCause (ТЗ §18)', () => {
  function lobby(overrides: {
    status?: Lobby['status']
    ending?: Lobby['ending']
    participantCount?: number
    minPlayers?: number
  } = {}) {
    const { status = 'CANCELLED', ending = 'UNPLAYED', participantCount = 2, minPlayers = 2 } = overrides
    return {
      status,
      ending,
      participantCount,
      config: { participation: { minPlayers } },
    } as unknown as Parameters<typeof operationStatusLabel>[0]
  }

  it('names an under-filled room, not an idle one', () => {
    expect(refundCause(lobby({ participantCount: 1, minPlayers: 2 }))).toBe('undersubscribed')
  })

  it('names the idle room when enough defenders sat and nobody acted', () => {
    expect(refundCause(lobby({ ending: 'UNPLAYED', participantCount: 2, minPlayers: 2 }))).toBe('unplayed')
  })

  it('names a protocol failure separately from either of those', () => {
    expect(refundCause(lobby({ ending: 'CANCELLED', participantCount: 2, minPlayers: 2 }))).toBe('protocol')
  })

  it('prints UNPLAYED on the status pill when the room filled and nobody acted', () => {
    expect(operationStatusLabel(lobby({ ending: 'UNPLAYED', participantCount: 2 }))).toBe('UNPLAYED')
  })

  it('keeps CANCELLED on the pill when too few joined or the protocol failed', () => {
    expect(operationStatusLabel(lobby({ participantCount: 1, minPlayers: 2 }))).toBe('CANCELLED')
    expect(operationStatusLabel(lobby({ ending: 'CANCELLED', participantCount: 2 }))).toBe('CANCELLED')
  })

  it('leaves every other status byte as the chain wrote it', () => {
    expect(operationStatusLabel(lobby({ status: 'OPEN' }))).toBe('OPEN')
    expect(operationStatusLabel(lobby({ status: 'ACTIVE' }))).toBe('ACTIVE')
  })
})

describe('Send Defense availability (ТЗ §8.5)', () => {
  const base = {
    hasJoined: true,
    // ТЗ §4.5 — the grid, and therefore Send Defense, unlocks at launch.
    lobbyPhase: 'ATTACK_ACTIVE' as LobbyPhase,
    submittedAttempt: null,
    selectedSectorId: 'B2' as string | null,
    stagedPoint: point as DefensePoint | null,
  }

  it('allows it only with every condition met', () => {
    expect(defenseBlockedReason(base)).toBeNull()
  })

  it('blocks a sector without a point (ТЗ §7.10)', () => {
    expect(defenseBlockedReason({ ...base, stagedPoint: null })).toMatch(/Defense Point/)
  })

  it('blocks with no sector chosen', () => {
    expect(defenseBlockedReason({ ...base, selectedSectorId: null, stagedPoint: null })).toMatch(/sector/i)
  })

  it('blocks a second submission for good (ТЗ §7.14, §8.5)', () => {
    expect(defenseBlockedReason({ ...base, submittedAttempt: submitted })).toMatch(/already submitted/i)
  })

  it('blocks while applications are still open, and after the operation ends', () => {
    expect(defenseBlockedReason({ ...base, lobbyPhase: 'OPEN' })).toMatch(/Applications/)
    expect(defenseBlockedReason({ ...base, lobbyPhase: 'RESULT' })).toMatch(/ended/)
  })

  it('blocks before the attack launches, however complete the pick is (ТЗ §4.5)', () => {
    expect(defenseBlockedReason({ ...base, lobbyPhase: 'WAITING_FOR_ATTACK' })).toMatch(/launches/)
    expect(defenseBlockedReason({ ...base, lobbyPhase: 'ATTACK_INCOMING' })).toMatch(/launches/)
  })

  it('blocks someone who never joined', () => {
    expect(defenseBlockedReason({ ...base, hasJoined: false })).toMatch(/Join/)
  })

  it('stays available right through the flight, up to the moment of submission (ТЗ §8.5)', () => {
    expect(defenseBlockedReason({ ...base, lobbyPhase: 'ATTACK_ACTIVE' })).toBeNull()
  })

  /*
   * The half of `PROBE_DELAY_BLOCKS` that is not about probes. A reading
   * cannot be spent on a Defense Point until the probe that produced it has
   * landed — the protocol refuses it outright, so the control has to say so
   * rather than look live and revert.
   */
  it('blocks for the probe delay after this wallet last probed, and counts it down', () => {
    expect(defenseBlockedReason({ ...base, lastProbeBlock: 100, currentBlock: 100 })).toMatch(/^Defense opens in 3 blocks/)
    expect(defenseBlockedReason({ ...base, lastProbeBlock: 100, currentBlock: 102 })).toMatch(/^Defense opens in 1 block\b/)
    expect(defenseBlockedReason({ ...base, lastProbeBlock: 100, currentBlock: 103 })).toBeNull()
    // Nothing is in the air by then: the hint arrived with its own send.
    expect(defenseBlockedReason({ ...base, lastProbeBlock: 100, currentBlock: 100 })).not.toMatch(/in flight/i)
  })

  it('does not delay a player who never probed', () => {
    expect(defenseBlockedReason({ ...base, lastProbeBlock: 0, currentBlock: 100 })).toBeNull()
  })

  /*
   * Says what the player is waiting for rather than asking them to pick a
   * sector they have not picked yet — the delay is the reason the button is
   * dead, and it outlives the placement.
   */
  it('names the delay ahead of the placement clauses', () => {
    expect(
      defenseBlockedReason({
        ...base,
        selectedSectorId: null,
        stagedPoint: null,
        lastProbeBlock: 100,
        currentBlock: 101,
      }),
    ).toMatch(/^Defense opens in/)
  })
})

describe('Recon Probe availability (ТЗ §4.4, §6.1, §9.4)', () => {
  const base = {
    hasJoined: true,
    lobbyPhase: 'ATTACK_ACTIVE' as LobbyPhase,
    probesRemaining: 2,
    submittedAttempt: null as DefenseAttempt | null,
  }

  it('opens when the attack launches, and not before (ТЗ §4.4)', () => {
    expect(reconBlockedReason(base)).toBeNull()
    for (const phase of ['OPEN', 'WAITING_FOR_ATTACK', 'ATTACK_INCOMING'] as LobbyPhase[]) {
      expect(reconBlockedReason({ ...base, lobbyPhase: phase })).toMatch(/launches/)
    }
  })

  it('closes at this player’s own Send Defense, not at impact (ТЗ §9.4)', () => {
    expect(reconBlockedReason({ ...base, submittedAttempt: submitted })).toMatch(/submitted/i)
  })

  it('blocks when the player has none left, or never joined', () => {
    expect(reconBlockedReason({ ...base, probesRemaining: 0 })).toMatch(/no recon probes/i)
    expect(reconBlockedReason({ ...base, hasJoined: false })).toMatch(/join/i)
  })

  /*
   * The wait is counted, not described.
   *
   * This used to read "the previous probe is still in flight", which was
   * true when `DELAY_BLOCKS` gated the read and became a lie when the hint
   * started arriving with its own transaction. Nothing is in the air by
   * then; the reading is in hand and simply cannot be spent yet. Pinning
   * the number is what stops the old sentence coming back.
   */
  it('counts the cooldown down in blocks rather than claiming a probe is in flight', () => {
    expect(reconBlockedReason({ ...base, lastProbeBlock: 100, currentBlock: 100 })).toBe('Next probe in 3 blocks')
    expect(reconBlockedReason({ ...base, lastProbeBlock: 100, currentBlock: 102 })).toBe('Next probe in 1 block')
    expect(reconBlockedReason({ ...base, lastProbeBlock: 100, currentBlock: 103 })).toBeNull()
    expect(reconBlockedReason({ ...base, lastProbeBlock: 100, currentBlock: 100 })).not.toMatch(/in flight/i)
  })

  it('blocks once the operation is over', () => {
    expect(reconBlockedReason({ ...base, lobbyPhase: 'RESULT' })).toMatch(/ended/)
    expect(reconBlockedReason({ ...base, lobbyPhase: 'CANCELLED' })).toMatch(/ended/)
  })
})

/**
 * ТЗ §4 — the control that produces the outcome cannot require the outcome.
 *
 * These are here because the bug they cover was invisible to every other
 * test in the suite: the emulator resolves an attack eagerly at its impact
 * block, so a lobby has an outcome before anybody reveals, while on chain
 * the outcome *is* the reveal's product. Gating Reveal on the outcome
 * therefore passed locally and dead-ended every real operation at impact.
 */
describe('canRevealAttack (ТЗ §4)', () => {
  const base = { lobbyPhase: 'RESULT' as const, revealLoaded: true, isScored: false }

  it('offers the reveal on a finished round nobody has revealed', () => {
    expect(canRevealAttack(base)).toBe(true)
  })

  it('does not require the operation to already have an outcome', () => {
    // There is no outcome argument at all — the shape is the guarantee.
    expect(Object.keys(base)).toEqual(['lobbyPhase', 'revealLoaded', 'isScored'])
  })

  it('stops offering it once somebody has taken it', () => {
    expect(canRevealAttack({ ...base, isScored: true })).toBe(false)
  })

  it('waits for the chain to answer before offering anything', () => {
    // Otherwise every already-revealed operation flashes a Reveal button on
    // load, in the gap before the first read comes back.
    expect(canRevealAttack({ ...base, revealLoaded: false })).toBe(false)
  })

  it('offers nothing while the round is still running or was cancelled', () => {
    for (const phase of ['OPEN', 'WAITING_FOR_ATTACK', 'ATTACK_INCOMING', 'ATTACK_ACTIVE', 'CANCELLED'] as const) {
      expect(canRevealAttack({ ...base, lobbyPhase: phase })).toBe(false)
    }
  })
})

/**
 * ТЗ §7-§8 — the guess and the answer must not share the board.
 *
 * The case these are here for is the one no other test could see: a page
 * opened on an operation that finished a week ago. The round's own state
 * says "over" immediately, but the reveal is a separate read that takes a
 * moment to come back — and read as "nobody has revealed", that moment put
 * the reconnaissance corridor across the map for the first seconds of every
 * finished operation, right up until the real trajectory replaced it.
 */
describe('showsReconnaissance (ТЗ §7-§8)', () => {
  const base = { lobbyPhase: 'ATTACK_ACTIVE' as LobbyPhase, revealLoaded: true, isScored: false }

  it('keeps the estimate up while the threat is still unknown', () => {
    for (const phase of ['WAITING_FOR_ATTACK', 'ATTACK_INCOMING', 'ATTACK_ACTIVE'] as const) {
      expect(showsReconnaissance({ ...base, lobbyPhase: phase })).toBe(true)
    }
  })

  it('takes it off once the round has been scored', () => {
    expect(showsReconnaissance({ ...base, lobbyPhase: 'RESULT', isScored: true })).toBe(false)
  })

  it('holds it back on a finished round the chain has not answered for yet', () => {
    expect(showsReconnaissance({ lobbyPhase: 'RESULT', revealLoaded: false, isScored: false })).toBe(false)
  })

  it('puts it back when the chain confirms nobody has revealed', () => {
    // The one window where the guess is still the best thing anyone has:
    // the attack has landed, and no one has opened the geometry.
    expect(showsReconnaissance({ lobbyPhase: 'RESULT', revealLoaded: true, isScored: false })).toBe(true)
  })

  it('shows nothing on an operation that never flew', () => {
    for (const phase of ['CANCELLED', 'UNDERSUBSCRIBED'] as const) {
      expect(showsReconnaissance({ ...base, lobbyPhase: phase, revealLoaded: false })).toBe(false)
    }
  })
})

/**
 * ТЗ §3 — buying probes and sending them are different windows.
 *
 * The pair matters more than either half. Reconnaissance stays open right
 * through the flight, up to a player's own Send Defense; purchase closes at
 * the launch. If purchase were open for as long as sending is, a defender
 * who prepared for nothing could watch the launch, then buy a full allowance
 * and a fix with it — and preparing for an attack would cost the same as
 * reacting to one.
 *
 * `buyProbes` enforces exactly this window on chain, so these two rules
 * being consistent with each other is what keeps the UI honest rather than
 * what keeps the protocol safe.
 */
describe('probePurchaseBlockedReason (ТЗ §3)', () => {
  const base = { hasJoined: true, lobbyPhase: 'OPEN' as LobbyPhase, probesOwned: 3, maxProbes: 6 }

  it('is open while applications are still being accepted', () => {
    expect(probePurchaseBlockedReason(base)).toBeNull()
  })

  it('is open once applications close, while the attack is only scheduled', () => {
    // The launch lands a full epoch after `startOperation`, so this is a
    // real preparation window rather than a technicality.
    expect(probePurchaseBlockedReason({ ...base, lobbyPhase: 'WAITING_FOR_ATTACK' })).toBeNull()
    expect(probePurchaseBlockedReason({ ...base, lobbyPhase: 'ATTACK_INCOMING' })).toBeNull()
  })

  it('closes the moment the attack launches', () => {
    expect(probePurchaseBlockedReason({ ...base, lobbyPhase: 'ATTACK_ACTIVE' })).toMatch(/launched/i)
  })

  it('closes on an operation that has ended', () => {
    expect(probePurchaseBlockedReason({ ...base, lobbyPhase: 'RESULT' })).toMatch(/ended/i)
    expect(probePurchaseBlockedReason({ ...base, lobbyPhase: 'CANCELLED' })).toMatch(/ended/i)
  })

  it('asks a non-participant to join first', () => {
    expect(probePurchaseBlockedReason({ ...base, hasJoined: false })).toMatch(/join/i)
  })

  it('stops at the protocol allowance', () => {
    expect(probePurchaseBlockedReason({ ...base, probesOwned: 8 })).toMatch(/maximum/i)
  })

  /**
   * The two windows overlap on purpose, and only in one direction: there is
   * no phase where a probe may be bought but not sent that is *also* a phase
   * where one may be sent but not bought.
   */
  it('never leaves buying open after sending has opened', () => {
    for (const phase of ['OPEN', 'WAITING_FOR_ATTACK', 'ATTACK_INCOMING', 'ATTACK_ACTIVE', 'RESULT', 'CANCELLED'] as const) {
      const canBuy = probePurchaseBlockedReason({ ...base, lobbyPhase: phase }) === null
      const canSend =
        reconBlockedReason({
          hasJoined: true,
          lobbyPhase: phase,
          probesRemaining: 3,
          submittedAttempt: null,
        }) === null
      expect(canBuy && canSend, `${phase} allows both`).toBe(false)
    }
  })
})

/**
 * ТЗ §18 — the deadline passing with too few defenders.
 *
 * The one transition in the whole lifecycle that changes no on-chain byte.
 * `cancelLobby` is what moves the status, and until somebody sends it the
 * lobby is still literally OPEN — which is why the screen used to head an
 * operation that could never run with "OPEN", invite people to join it, and
 * tell the defenders already inside that they were waiting for something.
 *
 * It is also the state in which everybody's entry fee is stuck on the
 * contract, so getting it wrong is not cosmetic.
 */
describe('an under-filled operation past its deadline (ТЗ §18)', () => {
  const past = { participantCount: 1, minPlayers: 3, deadline: 1_000 }
  const now = 5_000

  it('is not OPEN once the deadline has passed without the minimum', () => {
    expect(deriveLobbyPhase(lobbyOf('OPEN', past), null, 100, now)).toBe('UNDERSUBSCRIBED')
    expect(lobbyPhaseLabel('UNDERSUBSCRIBED')).toBe('NOT ENOUGH DEFENDERS')
  })

  it('stays OPEN while the deadline is still ahead, however few have joined', () => {
    expect(deriveLobbyPhase(lobbyOf('OPEN', { ...past, deadline: now + 1 }), null, 100, now)).toBe('OPEN')
  })

  it('stays OPEN past the deadline when enough defenders did join', () => {
    // This one is on its way to ACTIVE, not to cancellation.
    expect(deriveLobbyPhase(lobbyOf('OPEN', { ...past, participantCount: 3 }), null, 100, now)).toBe('OPEN')
  })

  it('reports OPEN when no clock was supplied, rather than guessing', () => {
    expect(deriveLobbyPhase(lobbyOf('OPEN', past), null, 100)).toBe('OPEN')
  })

  it('counts as over everywhere an ended operation does', () => {
    expect(isOperationOver('UNDERSUBSCRIBED')).toBe(true)

    // No control may act on an operation that cannot run — in particular
    // buying probes, which would be spending money on a refund queue.
    expect(
      probePurchaseBlockedReason({
        hasJoined: true,
        lobbyPhase: 'UNDERSUBSCRIBED',
        probesOwned: 0,
        maxProbes: 6,
      }),
    ).toMatch(/ended/i)
    expect(
      defenseBlockedReason({
        hasJoined: true,
        lobbyPhase: 'UNDERSUBSCRIBED',
        submittedAttempt: null,
        selectedSectorId: 'B2',
        stagedPoint: point,
      }),
    ).toMatch(/ended/i)
  })
})

/**
 * The operation that runs while the chain still calls it OPEN.
 *
 * An attack is bound to its operation at creation and flies on its own, so
 * the OPEN -> ACTIVE byte is only the money settling — and that happens as a
 * side effect of the first player's action. The phase has to follow the
 * *attack*, or the screen would show a join form over a threat already in
 * the sky, with every control locked and therefore nothing able to settle
 * it: an operation that could never leave OPEN.
 */
describe('an operation whose deadline block has passed (self-scheduled attacks)', () => {
  const closed = { deadline: 5_000, deadlineBlock: 900 }

  it('is still OPEN before the deadline block, whatever the wall clock says', () => {
    expect(deriveLobbyPhase(lobbyOf('OPEN', closed), attack('PENDING', 1000), 899, 9_999_999)).toBe('OPEN')
  })

  it('follows the attack once the deadline block passes, without waiting for a status change', () => {
    expect(deriveLobbyPhase(lobbyOf('OPEN', closed), attack('PENDING', 1000), 950, 1_000)).toBe('WAITING_FOR_ATTACK')
    expect(deriveLobbyPhase(lobbyOf('OPEN', closed), attack('LAUNCHED', 1000), 1_010, 1_000)).toBe('ATTACK_ACTIVE')
    expect(deriveLobbyPhase(lobbyOf('OPEN', closed), attack('RESOLVED', 1000), 1_200, 1_000)).toBe('RESULT')
  })

  it('still reports an under-filled operation as such rather than running it', () => {
    expect(
      deriveLobbyPhase(lobbyOf('OPEN', { ...closed, participantCount: 1 }), attack('LAUNCHED', 1000), 1_010, 1_000),
    ).toBe('UNDERSUBSCRIBED')
  })

  it('leaves an operation with no deadline block on the old rule', () => {
    // Emulator mode, and anything created before the protocol scheduled its
    // own attacks: applications closing still needs a transition, so the
    // screen keeps saying OPEN until one lands.
    expect(deriveLobbyPhase(lobbyOf('OPEN', { deadline: 5_000 }), attack('LAUNCHED', 1000), 1_010, 9_999)).toBe('OPEN')
  })
})
