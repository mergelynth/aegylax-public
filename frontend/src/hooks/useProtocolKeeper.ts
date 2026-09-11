import { useEffect, useRef, useState } from 'react'
import type { BlockchainClient } from '../blockchain'
import { canRevealAttack, type LobbyPhase } from '../game/lobbyPhase'
import type { Hash, Lobby } from '../game/types'
import { useBlockchainClient } from './useBlockchainClient'
import { usesBackendKeeper } from './useReveal'
import { useWallet } from './useWallet'

/**
 * The reveal, taken rather than waited for (ТЗ §4, §10).
 *
 * The protocol has no server, and one step of it genuinely needs somebody to
 * act: after an attack lands, its geometry sits sealed until a transaction
 * carries the confidential network's attested plaintexts back on chain.
 * Until that happens the operation has no trajectory, no winner and no
 * claimable reward — it is finished in every sense except the one that pays.
 *
 * That is a poor thing to leave to a button. The player most likely to be
 * looking at the screen when an attack lands is a defender who just lost,
 * and asking them to pay gas to find out is asking the wrong person at the
 * wrong moment. So this is the daemon the missing backend would have been:
 * while anyone with a stake has the page open, the reveal happens on its
 * own, and everybody watching sees the result arrive.
 *
 * **What it is not.** It computes nothing. The trajectory is not derived
 * here, the winner is not decided here, and no coordinate is reconstructed
 * in the browser — every one of those is the contract's, and this only sends
 * the transaction that lets the contract do it. A daemon that worked out the
 * answer and reported it would be a second source of truth for the one
 * number the whole game turns on.
 *
 * **Why it is safe to run in every tab at once.** The reveal is
 * permissionless and idempotent by design: the first caller publishes for
 * everyone, and the adapter skips each step somebody has already taken (see
 * `performReveal`). Losing the race is the ordinary outcome, not a failure —
 * whoever won it did the identical thing, and the next read shows it. The
 * guards below exist to keep the *cost* down, not to keep the result
 * correct.
 *
 * Three of them, and each closes a way a wallet could be opened without
 * being asked:
 *
 *   - **only participants and creators — when the reveal costs gas.** A
 *     passer-by reading an operation they have nothing to do with never has
 *     their wallet opened or their gas spent. Where a backend keeper is
 *     configured the reveal is not a transaction at all: the page posts a
 *     nudge and the keeper's own wallet signs, so the reason for the guard
 *     is gone and anybody with the operation open helps finish it. That is
 *     the case that matters most — the round with no stakeholder watching is
 *     exactly the one that used to sit unrevealed.
 *   - **once per attack per session while it is in flight,** from a set
 *     that outlives the component, so a remount or a StrictMode
 *     double-mount waits for the first send rather than opening a second
 *     `unlockRound` beside it.
 *   - **only when the chain says it is needed** — `canRevealAttack` has
 *     already confirmed the round is over and nobody has revealed.
 *
 * **Failure is bounded, not terminal.** A daemon that retries a failing
 * transaction every block is a wallet prompt every block, so the old rule was
 * to give up after one attempt and leave the manual control as the only way
 * back. That rule was written when a reveal was four transactions and the
 * likely failure was a revert — something that fails identically forever.
 *
 * It is now two transactions with a *round trip to the covalidator quorum
 * between them*, and the likely failure has changed with it: the quorum
 * learns about the unlock by watching the chain, so "not processed yet" is a
 * normal answer for a few seconds and an ordinary one to fail on. That
 * failure is transient, and giving up on it stranded the operation in the one
 * state this hook exists to prevent — a finished round with no result, no
 * trajectory on the map and no reward claimable, until somebody noticed the
 * button.
 *
 * So an attack gets a budget of automatic tries, counted in a map that
 * outlives the component. A successful send is never retried — that used to
 * fire `revealAndResolve` a second time twelve seconds later, a third wallet
 * prompt for work that had already been done. The manual control never
 * consults the map, so a player can always retry deliberately.
 *
 * The budget has two settings, because the two modes are not paying the same
 * price for a retry. Signing costs a wallet prompt, so three prompts spread
 * over half a minute is the worst case worth inflicting. Nudging a backend
 * keeper costs an HTTP request against a job that is already deduplicated
 * per operation, so it can be both quicker and more persistent — which is
 * what turns "the reveal will arrive" into a wait measured in seconds.
 */

/** Automatic attempts per attack, per session, when each one opens a wallet. */
export const MAX_ATTEMPTS = 3
/**
 * How long to wait before trying again.
 *
 * Comfortably longer than the covalidator's usual ingestion lag, so a retry
 * is a genuinely new attempt rather than the same one repeated into the same
 * empty answer.
 */
export const RETRY_DELAY_MS = 12_000

/** Automatic attempts when the reveal is a free nudge rather than a transaction. */
export const MAX_NUDGES = 10
/**
 * How long to wait before nudging again.
 *
 * The keeper waits for the covalidator quorum inside its own pass now, so a
 * nudge that comes back without a result means that pass gave up — and the
 * next one is worth starting promptly rather than in twelve seconds. Its
 * per-operation deduplication is what makes a short interval safe: a nudge
 * arriving while the work is in flight joins it instead of duplicating it.
 */
export const NUDGE_RETRY_DELAY_MS = 3_000

/** Automatic attempts spent on each attack this session, by `lobbyId:attackId`. */
const attempts = new Map<string, number>()
/** Reveals already running for an attack — remounts join rather than double-send. */
const inFlight = new Set<string>()
/** Reveals that already landed in this tab; a lagging `isScored` must not retry them. */
const succeeded = new Set<string>()

export interface ProtocolKeeper {
  /** True while this tab is carrying the reveal. */
  busy: boolean
  /** Why the automatic attempt failed, if it did. The manual control stays available. */
  error: string | null
}

export function useProtocolKeeper(input: {
  lobby: Lobby | null
  attackId: string | null
  /** Null before the operation has loaded — nothing to decide yet. */
  phase: LobbyPhase | null
  /** Whether the chain has answered `getAttackReveal` for this attack. */
  revealLoaded: boolean
  /** Whether *this operation* has been scored — see `canRevealAttack`. */
  isScored: boolean
  /** Perform the reveal — the same call the manual control makes. */
  reveal: () => Promise<void>
  /** Re-read the operation once the result is on chain. */
  onRevealed: () => Promise<void> | void
}): ProtocolKeeper {
  const { lobby, attackId, phase, revealLoaded, isScored, reveal, onRevealed } = input
  const client = useBlockchainClient()
  const { address } = useWallet()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * The callbacks are held in a ref rather than depended on.
   *
   * `reveal` and `onRevealed` are rebuilt on most renders, and a dependency
   * on either would re-run this effect constantly — which, with the
   * once-only set as the only thing standing between it and a wallet prompt,
   * is closer to the edge than it should be. The effect depends on the
   * *facts* that decide whether a reveal is due; the callbacks are just how
   * it is carried out.
   */
  const actions = useRef({ reveal, onRevealed })
  actions.current = { reveal, onRevealed }

  /*
   * Every dependency below is a primitive, and that is load-bearing.
   *
   * A dependency on the `lobby` object would re-run this effect on every new
   * identity — which is every refresh that returns a structurally identical
   * lobby, unless something upstream is deduplicating them. Re-running is
   * not merely wasteful here: the cleanup sets `cancelled`, so a re-render
   * arriving while the reveal is in flight abandons its `onRevealed` and its
   * error reporting, and the once-only guard then refuses to try again. The
   * screen is left with a reveal that was sent, never re-read, and never
   * reported.
   *
   * So the effect depends on the facts it actually branches on, reduced to
   * values that compare by equality.
   */
  const lobbyId = lobby?.id ?? null
  const involved = lobby !== null && address !== null && hasStake(lobby, address)

  /**
   * Whether this hook is still on screen — real unmount only.
   *
   * Set from its own effect so StrictMode's mount/unmount/mount leaves it
   * true, which a `cancelled` flag scoped to the working effect cannot do.
   */
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /**
   * Bumped after a failed attempt, to re-run the effect below.
   *
   * The effect's other dependencies are all facts about the chain, and a
   * failed reveal changes none of them — the round is still finished, still
   * unscored, still due. Without a dependency that moves on failure there is
   * nothing to re-trigger on, and the retry would never happen no matter what
   * the attempt budget allowed.
   */
  const [retry, setRetry] = useState(0)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!lobbyId || !attackId || phase === null) return
    // Emulator mode settles on read; there is nothing to carry.
    if (!isKeeperCapable(client)) return
    if (!canRevealAttack({ lobbyPhase: phase, revealLoaded, isScored })) return
    // Free means the backend keeper's wallet signs, not this one — so the
    // stake test, which exists to protect a stranger's gas, does not apply.
    const free = usesBackendKeeper(client)
    if (!free && !involved) return

    const budget = free ? MAX_NUDGES : MAX_ATTEMPTS
    const delay = free ? NUDGE_RETRY_DELAY_MS : RETRY_DELAY_MS

    const key = `${lobbyId}:${attackId}`
    if (inFlight.has(key) || succeeded.has(key)) return
    const spent = attempts.get(key) ?? 0
    if (spent >= budget) return
    attempts.set(key, spent + 1)
    inFlight.add(key)

    setBusy(true)
    setError(null)

    /*
     * Deliberately not cancelled on cleanup.
     *
     * The obvious shape here is a `cancelled` flag flipped by the effect's
     * teardown, and it is wrong for this particular job: by the time
     * teardown could run, the reveal transaction has been *sent*. Abandoning
     * its follow-up does not un-send it — it just means the operation never
     * gets re-read and a failure is never reported, while the once-only
     * guard refuses to try again. The screen is then left showing a
     * finished round with no result, which is the exact state this hook
     * exists to prevent.
     *
     * Teardown is also not rare. A parent that hands back a new client or
     * lobby object re-runs the effect, and React StrictMode tears every
     * effect down once on mount by design.
     *
     * So the work always finishes, and only the state writes are guarded —
     * against a genuine unmount, tracked by a ref that survives the
     * StrictMode remount rather than by a per-effect closure.
     */
    void (async () => {
      let failed = false
      try {
        await actions.current.reveal()
        succeeded.add(key)
        await actions.current.onRevealed()
      } catch (err) {
        failed = true
        if (mounted.current) setError(err instanceof Error ? err.message : String(err))
      } finally {
        inFlight.delete(key)
        if (mounted.current) setBusy(false)
      }

      /*
       * Ask again shortly, and only if this attempt actually failed.
       *
       * `reveal` used to swallow errors and this timer used to fire either
       * way. A send that had already landed then got a second
       * `revealAndResolve` twelve seconds later — the third wallet prompt —
       * because `isScored` had not caught up yet. Success stands down;
       * failure is what the budget is for. The chain is still the stop
       * condition on the next run: a reveal that worked makes
       * `canRevealAttack` false.
       */
      if (!failed || !mounted.current) return
      if ((attempts.get(key) ?? 0) >= budget) return
      retryTimer.current = setTimeout(() => setRetry((n) => n + 1), delay)
    })()
  }, [client, lobbyId, attackId, involved, phase, revealLoaded, isScored, retry])

  // A pending retry must not outlive the screen — it would wake a wallet
  // prompt on an operation the player has navigated away from.
  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current)
    },
    [],
  )

  return { busy, error }
}

/**
 * Whether this wallet has anything at stake in the operation.
 *
 * The creator and the defenders, and nobody else. It is the same test
 * `useProtocolAdvance` applies to the transitions it takes automatically,
 * and for the same reason: spending somebody's gas on an operation they are
 * only reading is not a service.
 */
function hasStake(lobby: Lobby, address: string): boolean {
  const self = address.toLowerCase()
  return (
    lobby.creator.toLowerCase() === self ||
    lobby.participantAddresses.some((participant) => participant.toLowerCase() === self)
  )
}

/** Contract mode. The emulator resolves the same transitions lazily on every read. */
function isKeeperCapable(client: BlockchainClient): boolean {
  return typeof (client as Partial<{ maintain: unknown }>).maintain === 'function'
}

/** Exposed for tests: the guard has to outlive components, so it must be resettable. */
export function __resetKeeperGuard(lobbyId?: Hash, attackId?: string): void {
  if (lobbyId && attackId) {
    const key = `${lobbyId}:${attackId}`
    attempts.delete(key)
    inFlight.delete(key)
    succeeded.delete(key)
  } else {
    attempts.clear()
    inFlight.clear()
    succeeded.clear()
  }
}
