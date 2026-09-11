import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BlockchainClient } from '../blockchain'
import type { Hash, Lobby } from '../game/types'
import { useBlockchainClient } from './useBlockchainClient'
import { useEpochClock } from './useEpochClock'
import { claimProtocolAutoAttempt } from '../blockchain/protocolAutoAttempt'
import { useCountdownClock } from './useSmoothCountdown'
import { useWallet } from './useWallet'

interface KeeperCapable {
  maintain: (action: ProtocolAction, lobbyId: Hash, from: `0x${string}`) => Promise<unknown>
}

/**
 * The two transitions a player has to ask for.
 *
 * `completeAttack` is deliberately not one of them, though the contract
 * exposes it and it is equally permissionless. It is the first half of
 * revealing — the reveal flow sends it itself whenever decryption has not
 * been unlocked yet — so offering it separately would put a second button
 * next to Reveal that does part of Reveal's job, on a screen where the
 * pre-start hero (the only thing that renders these) is already gone.
 */
export type ProtocolAction = 'startOperation' | 'cancelLobby'

export interface ProtocolAdvance {
  /** The transition the chain is behind on, or null when it is up to date. */
  action: ProtocolAction | null
  /** What the button says, and what pressing it will do. */
  label: string
  description: string
  /** What the screen says instead of the button while the write is in flight. */
  pending: string
  /**
   * A transition is in flight — sent automatically on a participant's
   * behalf, or by their own press. The screen shows a status rather than a
   * control while this is true: there is nothing left to decide.
   */
  busy: boolean
  error: string | null
  run: () => Promise<void>
}

/**
 * Transitions already attempted automatically this session, `lobbyId:action`.
 *
 * Lives in `protocolAutoAttempt` so the Global Defense header keeper and
 * this hook share one guard — a leftover jackpot room must not be cancelled
 * twice because both were on screen.
 */
function isKeeperCapable(client: BlockchainClient): client is BlockchainClient & KeeperCapable {
  return typeof (client as Partial<KeeperCapable>).maintain === 'function'
}

/**
 * The transitions with nobody to make them (ТЗ §10) — taken automatically,
 * with a control as the fallback.
 *
 * Three moments in an operation are facts about the clock rather than
 * decisions anybody takes: applications close, an under-filled operation is
 * cancelled, and an attack lands. The contract makes all three permissionless
 * precisely because there is no server to notice them — but permissionless
 * still means somebody has to *send a transaction*, and with no backend that
 * somebody is a player with the page open.
 *
 * Because none of it is a decision, none of it is asked. An operation runs
 * as one continuous sequence — the deadline, the countdown to the launch,
 * the flight, the reveal — and a defender who waited out the countdown
 * should watch the attack get scheduled, not be handed a button that asks
 * them to schedule it. A control that only ever has one right answer is a
 * question not worth asking.
 *
 * Two things keep that safe, and they are what the earlier automatic version
 * lacked. It fires only for the creator and the defenders, so a passer-by
 * reading an operation never has their wallet opened or their gas spent on
 * it. And it fires once per transition per session, from a set that outlives
 * the component, so a remount cannot send the same transaction twice.
 *
 * The control stays for everything automation cannot cover: a viewer with no
 * stake who wants to push the operation along anyway, and the attempt that
 * failed — a rejected signature, an empty wallet — which is exactly when
 * something has to remain pressable. `run` never consults the once-only
 * guard, so a player may retry as often as they like.
 *
 * In emulator mode there is nothing to do: that client settles the same
 * transitions lazily on every read.
 */
export function useProtocolAdvance(
  lobby: Lobby | null,
  /** Re-read the operation the instant a transition lands. See `perform`. */
  onSettled?: () => Promise<void> | void,
): ProtocolAdvance {
  const client = useBlockchainClient()
  const { address, connect } = useWallet()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /*
   * The deadline passing is a fact about the clock, and nothing arrives to
   * announce it: the lobby on chain is byte-for-byte what it was a second
   * earlier, because the transition this hook exists to offer is precisely
   * the one nobody has sent yet.
   *
   * So the moment is read off the app's shared clock rather than from
   * `Date.now()` inside the memo. Sampling it there made the memo's answer
   * depend on when it last happened to run: an operation whose applications
   * closed while the player was watching kept the `null` it computed while
   * they were still open, so the screen dropped the countdown, said
   * "applications closed", and offered no way to close them — until a
   * reload recomputed it. Deriving the boolean here also keeps the memo
   * from re-running on every tick: it recomputes when the answer flips,
   * not four times a second.
   */
  const nowMs = useCountdownClock()
  const { blockNumber } = useEpochClock()
  /*
   * Against the block where there is one: cancelling is refused by the
   * contract until the deadline *block* has passed, so offering it off the
   * wall clock would produce a control that reverts.
   */
  const deadlineBlock = lobby?.config.participation.deadlineBlock ?? 0
  const deadlinePassed =
    lobby !== null &&
    (deadlineBlock > 0 && blockNumber !== null
      ? blockNumber >= deadlineBlock
      : nowMs >= lobby.config.participation.deadline)

  const action = useMemo<ProtocolAction | null>(() => {
    if (!lobby || !isKeeperCapable(client)) return null
    return decideAction(lobby, deadlinePassed)
  }, [client, lobby, deadlinePassed])

  const perform = useCallback(
    async (chosen: ProtocolAction) => {
      if (!lobby || !address || !isKeeperCapable(client)) return
      setBusy(true)
      setError(null)
      try {
        await client.maintain(chosen, lobby.id, address)
        /*
         * Re-read immediately rather than waiting for the next block.
         *
         * This is what makes the refund appear the moment the operation is
         * cancelled. Everything downstream of the cancellation — the status
         * tile, the tagline, and above all the Claim Refund control, which
         * only exists once `lobby.status` is CANCELLED — is derived from
         * this one read, so leaving it to the block subscription meant a
         * player watched the transaction confirm and then sat in front of an
         * unchanged screen until a block happened to arrive. Reloading the
         * page looked like the thing that fixed it.
         */
        await onSettled?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [client, lobby, address, onSettled],
  )

  /**
   * Whether this wallet has a stake in the operation.
   *
   * Only the creator and the defenders advance it without being asked. A
   * passer-by reading an operation they have nothing to do with should never
   * have their wallet open or their gas spent on it — but the control stays
   * on screen for them, so they can still push it along deliberately.
   */
  const involved = useMemo(() => {
    if (!lobby || !address) return false
    const self = address.toLowerCase()
    return (
      lobby.creator.toLowerCase() === self ||
      lobby.participantAddresses.some((participant) => participant.toLowerCase() === self)
    )
  }, [lobby, address])

  /*
   * The transition, taken rather than offered (ТЗ §10).
   *
   * Applications closing is not a decision anybody makes — it is the
   * deadline arriving — so a defender who sat through the countdown should
   * see the attack get scheduled, not a button asking them to schedule it.
   * The operation moves on its own: deadline, then the countdown to the
   * launch, then the flight, then the reveal.
   *
   * What keeps this safe is the guard, not the restraint: it fires once per
   * transition per session, from a set that a remount cannot reset, and only
   * for somebody already in the operation. Losing the race to another client
   * is the ordinary outcome rather than a failure — whoever got there first
   * made the same transition, and the next read shows it.
   */
  useEffect(() => {
    if (!action || !lobby || !address || !involved || !isKeeperCapable(client)) return

    if (!claimProtocolAutoAttempt(lobby.id, action)) return

    void perform(action)
  }, [action, lobby, address, involved, client, perform])

  /**
   * The control, pressed.
   *
   * A signed-out visitor is the case this had to grow for. `perform`
   * returns immediately without an address, so pressing the button did
   * nothing whatsoever — no wallet, no error, no busy state — which is
   * indistinguishable from a dead control, and it was sitting on the one
   * screen where the button is the only way anybody's entry fee ever comes
   * back. Now it asks them to sign in, which is what it needed all along.
   */
  const run = useCallback(async () => {
    if (!action) return
    if (!address) {
      setError(null)
      try {
        await connect()
      } catch (err) {
        // A sign-in that could not even be *started* — the provider still
        // initializing, an app id its dashboard rejects — used to reject
        // this promise into a `void` call at the caller, which is an
        // unhandled rejection and, on screen, a button that did nothing.
        setError(err instanceof Error ? err.message : String(err))
      }
      // The effect below picks it up once the session lands; if the sign-in
      // was abandoned, pressing again is the retry.
      return
    }
    await perform(action)
  }, [action, address, connect, perform])

  return { action, ...COPY[action ?? 'none'], busy, error, run }
}

/**
 * What each transition is called on the button, and what it warns about.
 *
 * The cancellation says what it unlocks rather than only what it ends: the
 * only reason a defender wants an under-filled operation cancelled is that
 * cancellation is what sends their money back (ТЗ §18).
 */
const COPY: Record<ProtocolAction | 'none', { label: string; description: string; pending: string }> = {
  /*
   * Kept, but never offered — see `decideAction`. `maintain` still accepts
   * it, so a client that wants to close applications deliberately can, and
   * the copy is here for that path rather than for a control on screen.
   */
  startOperation: {
    label: 'Close applications',
    description: 'Applications are over. This settles the operation’s fees; the attack is already scheduled.',
    pending: 'Closing applications…',
  },
  cancelLobby: {
    label: 'Cancel & refund everyone',
    description: 'Not enough defenders joined. This returns every joiner’s entry and your commission. The protocol keeps the creation fee.',
    pending: 'Not enough defenders — refunding everyone…',
  },
  none: { label: '', description: '', pending: '' },
}

/**
 * The one transition still worth sending, and the one that is gone.
 *
 * `startOperation` is no longer here. An operation is bound to its attack
 * when it is created, so closing applications settles money and nothing
 * else — and that happens by itself, as a side effect of the first probe or
 * defense of the round (or of the reveal, for a team that never acted).
 * Offering it meant spending a defender's gas on a transition the next
 * thing they did would have performed for free.
 *
 * The cancellation stays, because it is the only path that unlocks refunds
 * for an operation that can never run: nothing else will ever be sent
 * against it, so there is no later action to fold it into.
 */
function decideAction(lobby: Lobby, deadlinePassed: boolean): ProtocolAction | null {
  if (lobby.status !== 'OPEN' || !deadlinePassed) return null
  return lobby.participantCount < lobby.config.participation.minPlayers ? 'cancelLobby' : null
}
