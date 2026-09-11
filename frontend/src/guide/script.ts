/**
 * The guided tour, written down once (ТЗ §23-§24).
 *
 * Two things make this a script rather than a slideshow.
 *
 * The first is that every step names a *state of the real product* — which
 * screen is on stage, which of the sandbox's rooms it is standing in,
 * whether the Create dialog is up — and the page's only job is to make that
 * true. Nothing is drawn twice.
 *
 * The second is that it branches. A visitor gets into a round two ways and
 * a round ends two ways, and both halves of both are real: creating a room
 * is not joining one, and a hit is not a miss. So the tour asks, at exactly
 * those two points, and walks whichever it is told.
 *
 * The product itself is inert while the tour runs — the guide's own PREV,
 * NEXT and the two choices are the only controls. That is the whole
 * interaction model: the system performs, the visitor watches and decides
 * where the story goes.
 */

export type GuideScreen = 'home' | 'operations' | 'lobby'

/**
 * Which of the sandbox's rooms a lobby step is standing in.
 *
 * `entry` is not a room but a reference to one: whichever the walk came in
 * through — the room you created, or the room you joined. It exists so the
 * steps between the fork and the launch stay in the room the visitor was
 * just looking at, instead of silently swapping to a different operation
 * with a different name.
 */
export type GuideRoom =
  | 'entry'
  | 'mine'
  | 'open'
  | 'seated'
  | 'active'
  | 'sighted'
  | 'scouted'
  | 'won'
  | 'early'
  | 'late'
  | 'stray'

/**
 * The two decisions, and the four paths they make.
 *
 * `create` / `join` is how you get into a round; `hit` / `miss` is how it
 * ends. They are independent, so a walk is one of each.
 */
export type EntryBranch = 'create' | 'join'
export type OutcomeBranch = 'hit' | 'miss'
export type GuideBranch = EntryBranch | OutcomeBranch

export interface GuideChoiceOption {
  label: string
  /** One line on what picking this shows. */
  description: string
  branch: GuideBranch
}

export interface GuideChoice {
  question: string
  options: [GuideChoiceOption, GuideChoiceOption]
}

export interface GuideStep {
  id: string
  screen: GuideScreen
  /** Required when `screen` is 'lobby'. */
  room?: GuideRoom
  /** Whether the real Create Operation dialog is open on this step. */
  createModal?: boolean
  /**
   * The element being explained, as a `data-guide` selector. Null for a
   * step about the screen as a whole.
   */
  target: string | null
  title: string
  /**
   * One paragraph, or several.
   *
   * An array where a step has more than one thing to say — the opening
   * screen covers what the game is, how the money works and why the path
   * can stay hidden, and running those together makes a wall of text
   * nobody finishes.
   */
  body: string | readonly string[]
  /**
   * The accent under the body: a rule, a constraint, the stake.
   *
   * A list where a step has more than one, so the operational line and any
   * housekeeping the tour owes the reader stay visually separate.
   */
  note?: string | readonly string[]
  side?: 'top' | 'bottom' | 'left' | 'right'
  /**
   * Where the card goes when the step has no single target. `corner` keeps
   * the screen lit and moves the card clear of the command rail.
   */
  place?: 'auto' | 'corner'
  /** Set on the steps that belong to one path; absent on the shared ones. */
  branch?: GuideBranch
  /**
   * A fork. The step renders its two options instead of NEXT, and picking
   * one both chooses the path and moves on.
   */
  choice?: GuideChoice
}

// ───────────────────────────────────────────────────────────────────────
// Opening — shared by every walk
// ───────────────────────────────────────────────────────────────────────

const OPENING: GuideStep[] = [
  {
    id: 'home',
    screen: 'home',
    target: null,
    title: 'THE THREAT',
    body: [
      'An attack is in motion toward Earth. Its trajectory is sealed. Nobody can see where it will strike — not the players, not the operator, not the client.',
      'One player opens a Defense Operation and funds the initial prize. Every defender adds their entry to the pool. A successful interception takes the reward.',
      'The trajectory remains encrypted until impact. That is what keeps the operation fair. Fhenix CoFHE lets the system use the sealed trajectory without revealing it. No one gets to see the answer first.',
    ],
    note: [
      'THE MISSION: locate the threat, estimate its arrival, and commit your defense before impact.',
      'Interactive guide — the real interface on example operations. No wallet. No transactions.',
    ],
  },
  {
    id: 'jackpot',
    screen: 'home',
    target: '[data-guide="jackpot"]',
    title: 'THE GLOBAL DEFENSE POOL',
    body: 'Not every attack is intercepted. When a completed operation has no winner, its unclaimed pool moves to Global Defense instead of returning to the creator. The protocol periodically opens the accumulated pool as a free-entry operation of its own.',
    note: 'MISSED INTERCEPTIONS BUILD THE JACKPOT.',
    side: 'bottom',
  },
  {
    id: 'entry',
    screen: 'home',
    target: '[data-guide="create-operation"]',
    title: 'CHOOSE YOUR OPERATION',
    body: 'There are two ways to enter the defense network. Create operation and fund its initial pool, or join an active operation opened by another defender.',
    side: 'top',
    choice: {
      question: 'SELECT ENTRY PATH',
      options: [
        {
          label: 'CREATE OPERATION',
          description: 'Define the operation parameters and fund the initial pool.',
          branch: 'create',
        },
        {
          label: 'JOIN AN OPERATION',
          description: 'Enter an existing operation and deploy with the other defenders.',
          branch: 'join',
        },
      ],
    },
  },
]

// ───────────────────────────────────────────────────────────────────────
// Entry branches
// ───────────────────────────────────────────────────────────────────────

const CREATE_PATH: GuideStep[] = [
  {
    id: 'create-terms',
    screen: 'home',
    createModal: true,
    target: '[data-guide="create-form"]',
    title: 'SET THE PARAMETERS',
    body: [
      'You define the operation parameters: entry, player limit, deadline, and creator fee. Once the operation is launched, these parameters are fixed.',
      'The threat is not yours to define. Its trajectory is generated separately and remains sealed.',
    ],
    note: 'YOU CONTROL THE OPERATION. NOT THE THREAT.',
    side: 'left',
    branch: 'create',
  },
  {
    id: 'create-launch',
    screen: 'home',
    createModal: true,
    target: '[data-guide="create-submit"]',
    title: 'FUND THE OPERATION',
    body: 'Opening an operation requires two payments: the initial defense pool and a one-time protocol creation fee. Both leave your wallet when the operation is launched.',
    note: [
      'THE POOL FUNDS THE DEFENSE. THE CREATION FEE FUNDS THE PROTOCOL.',
      'Launch is a held press, not a click. An irreversible spend should not be one slip away.',
    ],
    side: 'top',
    branch: 'create',
  },
  {
    id: 'created',
    screen: 'lobby',
    room: 'entry',
    target: null,
    place: 'corner',
    title: 'OPERATION ACTIVE',
    body: [
      'The operation is now open. Defenders can enter before the deadline. The threat has not launched yet.',
      'Your position is committed. Once the operation activates, reconnaissance and defense are governed by the operation parameters.',
    ],
    note: 'THE OPERATION IS LIVE. THE THREAT IS NEXT.',
    branch: 'create',
  },
]

const JOIN_PATH: GuideStep[] = [
  {
    id: 'directory',
    screen: 'operations',
    target: '[data-guide="directory-list"]',
    title: 'ACTIVE OPERATIONS',
    body: 'Every operation the protocol has opened is on the register, with its entry, its pool and the slots remaining. Resolved operations stay listed so their outcome can be read back.',
    note: 'FILTER BY STATUS TO FIND OPERATIONS STILL ACCEPTING DEFENDERS.',
    side: 'top',
    branch: 'join',
  },
  {
    id: 'join-room',
    screen: 'lobby',
    room: 'open',
    target: '[data-guide="join-button"]',
    title: 'DEPLOY TO AN OPERATION',
    body: 'Your entry is paid into the operation pool. The creator’s commission is paid on top of it, never out of it, and is returned to defenders if the operation never runs.',
    note: 'APPLICATIONS CLOSE ON A BLOCK, NOT A CLOCK.',
    side: 'top',
    branch: 'join',
  },
  {
    id: 'joined',
    screen: 'lobby',
    room: 'entry',
    target: '[data-guide="lobby-panel"]',
    /*
     * Deploying is a state change, and blocks cannot be un-mined — so the
     * tour steps into an operation that is already on the other side of it
     * rather than pretending to walk one across. The step says so plainly;
     * the alternative was giving two operations the same name, which would
     * have been sleight of hand rather than a time skip.
     */
    title: 'POSITION CONFIRMED',
    body: 'Your slot is held in an operation already under way. The roster is public: who has deployed, and how many actions each defender has sent. What those actions were is not. Reconnaissance and defense are indistinguishable from outside.',
    note: 'ACTION COUNTS ARE PUBLIC. ACTION CONTENT IS SEALED.',
    side: 'left',
    branch: 'join',
  },
]

// ───────────────────────────────────────────────────────────────────────
// The operation — shared again
// ───────────────────────────────────────────────────────────────────────

const ROUND: GuideStep[] = [
  {
    id: 'pool',
    screen: 'lobby',
    room: 'entry',
    target: '[data-guide="lobby-panel"]',
    title: 'HOW THE POOL IS BUILT',
    body: 'The defense pool has two sources. The creator provides the initial pool. Every defender then adds the required entry. More defenders mean a larger reward for a successful interception.',
    note: 'MORE DEFENDERS. LARGER REWARD.',
    side: 'left',
  },
  {
    id: 'payout',
    screen: 'lobby',
    room: 'entry',
    target: '[data-guide="lobby-panel"]',
    title: 'SETTLEMENT',
    body: 'A successful interception claims the pool. Where several defenders intercept on the same block, the reward is divided between them. The creator’s commission is drawn from entries and settles separately.',
    note: 'THE EARLIEST INTERCEPTION TAKES THE OPERATION.',
    side: 'left',
  },
  {
    id: 'buy',
    screen: 'lobby',
    room: 'entry',
    target: '[data-guide="buy-probe"]',
    title: 'BEGIN RECONNAISSANCE',
    body: [
      'Recon Probes provide incomplete intelligence about the sealed attack. Your operation gives you a limited number of probes; additional probes can be acquired while reconnaissance is open.',
      'Probe prices are fixed across operations. No defender can pay more to gain priority.',
    ],
    note: 'RECONNAISSANCE CLOSES AT LAUNCH.',
    side: 'bottom',
  },
  {
    id: 'flight',
    screen: 'lobby',
    room: 'active',
    target: null,
    place: 'corner',
    /*
     * The one place the tour changes operations, and it says so.
     *
     * Blocks cannot be un-mined, so an operation cannot be walked forwards
     * and backwards through its own states — each state is held as its own
     * operation instead. Rather than hide the swap behind identical copy,
     * the accent names it.
     */
    title: 'THREAT IN FLIGHT',
    body: [
      'The attack has launched. Its origin, target, trajectory, and speed are real — but remain sealed.',
      'The defense window is now active. You cannot observe the trajectory. You can only act on the intelligence you acquired before launch.',
    ],
    note: [
      'FIND WHERE. FIND WHEN. INTERCEPT.',
      'A separate operation, at the moment yours is heading for.',
    ],
  },
  {
    id: 'recon',
    screen: 'lobby',
    room: 'active',
    target: '[data-guide="recon"]',
    title: 'WHAT A PROBE REVEALS',
    body: [
      'A probe does not reveal the trajectory. It returns a noisy estimate of where the attack was at one moment.',
      'Each probe narrows the search area. It never gives you the exact path.',
    ],
    note: 'INTELLIGENCE, NOT CERTAINTY.',
    side: 'top',
  },
  {
    id: 'bearing',
    screen: 'lobby',
    room: 'sighted',
    target: null,
    place: 'corner',
    title: 'FIRST READING: A BEARING',
    body: [
      'One probe spent. The opening reading is a sweep, and what it returns is a direction — the wide cone the threat is somewhere inside.',
      'It says which way. It says nothing about how far along that line the threat has travelled.',
    ],
    note: 'ONE READING NARROWS THE SKY. IT DOES NOT LOCATE ANYTHING.',
  },
  {
    id: 'corridor',
    screen: 'lobby',
    room: 'scouted',
    target: null,
    place: 'corner',
    title: 'EVERY READING AFTER: OCCUPANCY',
    body: [
      'From the second probe onward each reading also drops an occupancy mark — a noisy fix on where the threat was at that moment. Together they build a rough heat map along the bearing.',
      'The cone tightens where the readings agree, and the marks show where along it to look. Neither becomes the trajectory. You still make the intercept call.',
    ],
    note: 'MORE INTELLIGENCE. BETTER ODDS. NEVER CERTAINTY.',
  },
  {
    id: 'shot',
    screen: 'lobby',
    room: 'scouted',
    target: '[data-guide="intercept"]',
    title: 'COMMIT THE DEFENSE',
    body: [
      'One Defense Point per defender. You commit a position and the block you expect the threat to occupy it. The commitment is encrypted in the client and stays sealed until the operation resolves — no defender can read another’s.',
      'Scoring compares your point against the threat’s actual position at your submitted block. Correct position, wrong block, is a missed interception.',
    ],
    note: 'ONE COMMITMENT. NO REVISION.',
    side: 'top',
    choice: {
      question: 'HOW DOES THIS OPERATION RESOLVE?',
      options: [
        {
          label: 'SUCCESSFUL INTERCEPTION',
          description: 'The threat entered your radius. The pool settles to you.',
          branch: 'hit',
        },
        {
          label: 'MISSED INTERCEPTION',
          description: 'The threat reached Earth. Three ways that happens.',
          branch: 'miss',
        },
      ],
    },
  },
]

// ───────────────────────────────────────────────────────────────────────
// Outcome branches
// ───────────────────────────────────────────────────────────────────────

/**
 * The three ways a committed point fails, one screen and one operation each.
 *
 * They are the whole of the MISS branch, and they are deliberately not on
 * the HIT branch. A successful interception is one story; failing is three,
 * and the difference between them is the rule the tour exists to teach.
 * Showing all four down both paths made the win read as a footnote to a
 * catalogue of errors and the branch choice mean nothing.
 *
 * Separate operations rather than three markers on one map. Every one flies
 * the same staged trajectory and carries exactly one point, so the line does
 * not move between screens and the only thing that changed is where the
 * point sat and which block it was committed on. Three rings on one board is
 * a crowd: the eye cannot tell which one the words are about, and the two
 * timing failures — the hard idea — read as scatter rather than as a rule.
 *
 * Each points at the marker on the map, not at the panel listing it. The
 * panel says which address got which verdict; the map says where the point
 * sat relative to the path, which is the whole of what "early" and "late"
 * mean.
 */
const FAILURES: Array<{ kind: string; room: GuideRoom; anchor: string; title: string; body: string; note: string }> = [
  {
    kind: 'early',
    room: 'early',
    anchor: 'defense-early',
    title: 'TOO EARLY',
    body: 'The point sat on the path — but further along it than the threat had travelled at the block it was committed on. The interceptor reached an altitude the threat had not, and was gone before it arrived.',
    note: 'RIGHT LINE. AHEAD OF THE THREAT.',
  },
  {
    kind: 'late',
    room: 'late',
    anchor: 'defense-late',
    title: 'TOO LATE',
    body: 'The opposite error, the same result. The same line again, and this point was on it too — but behind the threat: by the committed block it had already passed through that altitude.',
    note: 'RIGHT LINE. BEHIND THE THREAT.',
  },
  {
    kind: 'stray',
    room: 'stray',
    anchor: 'defense-miss',
    title: 'MISSED',
    body: 'And the ordinary failure: a point that was never near the path. The threat did not come within the interception radius at any moment of the flight, so there is no timing to discuss.',
    note: 'WRONG LINE. NOTHING TO TIME.',
  },
]

const FAILURE_STEPS: GuideStep[] = FAILURES.map((failure) => ({
  id: `miss-${failure.kind}`,
  screen: 'lobby',
  room: failure.room,
  target: `[data-guide="${failure.anchor}"]`,
  title: failure.title,
  body: failure.body,
  note: failure.note,
  side: 'right',
  branch: 'miss',
}))

const HIT_PATH: GuideStep[] = [
  {
    id: 'hit-reveal',
    screen: 'lobby',
    room: 'won',
    target: null,
    place: 'corner',
    title: 'TARGET INTERCEPTED',
    body: 'Resolution publishes everything at once: the real trajectory, and every defender’s committed point beside it. The earliest interception takes the operation; interceptions sharing that block divide the reward.',
    note: 'FIRST DISCLOSURE OF THE TRAJECTORY.',
    branch: 'hit',
  },
  {
    id: 'hit-claim',
    screen: 'lobby',
    room: 'won',
    target: '[data-guide="intercept"]',
    title: 'CLAIM THE REWARD',
    body: 'The reward is recorded against your address on the operation itself. It cannot be claimed twice and it does not expire. One transaction moves it to your wallet.',
    note: 'OPERATION COMPLETE.',
    side: 'top',
    branch: 'hit',
  },
]

const MISS_PATH: GuideStep[] = [
  {
    id: 'miss-reveal',
    screen: 'lobby',
    room: 'early',
    target: null,
    place: 'corner',
    title: 'TARGET REACHED',
    body: 'The same disclosure, the opposite outcome. Resolution publishes the trajectory and every committed point beside it — and none of them held the threat at the block it was committed on. Earth takes the impact.',
    note: 'NO INTERCEPTION. NO REWARD.',
    branch: 'miss',
  },
  /*
   * Three ways to fail, in the order they are worth learning: the two that
   * were on the path and lost on timing, then the one that was never on it.
   * The stray comes last on purpose — it is the failure that needs no
   * explanation, and leading with it would make the other two look like
   * variations on bad aim.
   */
  ...FAILURE_STEPS,
  {
    id: 'miss-rollover',
    screen: 'lobby',
    room: 'stray',
    target: '[data-guide="lobby-panel"]',
    title: 'POOL FORFEITED',
    body: 'The pool is not refunded to defenders and does not return to the creator. It moves to Global Defense and waits there for the protocol’s own free-entry operation.',
    note: 'A COMPLETED OPERATION IS NOT A CANCELLED ONE. ONLY AN UNPLAYED OPERATION REFUNDS.',
    side: 'left',
    branch: 'miss',
  },
]

/**
 * The steps for one walk, in order.
 *
 * Assembled rather than stored, because the two decisions are independent:
 * four walks exist and writing them out would be four copies of the round
 * in the middle, drifting apart the first time one of them was edited.
 */
export function guideSequence(entry: EntryBranch, outcome: OutcomeBranch): GuideStep[] {
  return [
    ...OPENING,
    ...(entry === 'create' ? CREATE_PATH : JOIN_PATH),
    ...ROUND,
    ...(outcome === 'hit' ? HIT_PATH : MISS_PATH),
  ]
}

/** Every step that exists, for tests and lookups. */
export const ALL_STEPS: GuideStep[] = [
  ...OPENING,
  ...CREATE_PATH,
  ...JOIN_PATH,
  ...ROUND,
  ...HIT_PATH,
  ...MISS_PATH,
]

export const ENTRY_BRANCHES: EntryBranch[] = ['create', 'join']
export const OUTCOME_BRANCHES: OutcomeBranch[] = ['hit', 'miss']

export function isEntryBranch(branch: GuideBranch): branch is EntryBranch {
  return branch === 'create' || branch === 'join'
}
