import { useCallback, useEffect, useRef, useState } from 'react'
import { getAttack, getDefenseAttempts } from '../game/gameService'
import { openOwnDefensePoint } from '../game/privateActions'
import type { ActivityCell, Attack, DefenseAttempt, DefensePoint, Hash } from '../game/types'
import { sameAddress } from '../utils/address'
import { keepIfUnchanged } from '../utils/identity'
import { useBlockchainClient } from './useBlockchainClient'
import { useWallet } from './useWallet'

export interface UseOperationResult {
  /** The operation's one attack — its schedule only; the geometry is never on it (ТЗ §3.4). */
  attack: Attack | null
  /**
   * Always empty, for now.
   *
   * The per-sector heatmap that read this is off the screen until it can be
   * paged: it enumerated one cell per record with no ceiling, and this hook
   * re-fetched the whole map **on every block** to feed it. At the scale the
   * protocol is built for that is tens of thousands of rows re-read a few
   * times a minute for a panel nobody has open. The field stays so the read
   * path (`getActivityMap`, `toActivityMap`) and its callers keep compiling
   * unchanged; only the fetch is gone.
   */
  activity: ActivityCell[]
  /** Every attempt on the attack; nobody's point is plaintext here before the reveal (ТЗ §7, §11). */
  attempts: DefenseAttempt[]
  /** This wallet's own attempt, if it has submitted. The lock behind every "already submitted" state. */
  ownAttempt: DefenseAttempt | null
  /**
   * This wallet's own Defense Point, opened from the envelope the protocol
   * sealed to it (ТЗ §11).
   *
   * The screen needs this — a locked marker has to reappear after a reload,
   * and the player is entitled to see their own choice — and it is the only
   * coordinate in the app before the reveal. It is derived here rather than
   * read, because opening it is the client's own act with the client's own
   * key, not something the protocol did for it.
   */
  ownDefensePoint: DefensePoint | null
  refresh: () => Promise<void>
}

/**
 * Everything about an operation's attack, read from the chain rather than
 * remembered locally.
 *
 * `ownAttempt` in particular is deliberately a read and not a piece of
 * component state: ТЗ §9.2-9.5 say a submitted Defense can never be
 * changed or resent, and a lock that only exists in a React state variable
 * would come undone on a reload. Asking the chain is what makes the lock
 * survive one.
 */
/** See `UseOperationResult.activity` — one shared empty list, never rebuilt. */
const NO_ACTIVITY: ActivityCell[] = []

export function useOperation(lobbyId: Hash | null, attackId: string | null): UseOperationResult {
  const client = useBlockchainClient()
  const { address } = useWallet()
  const [attack, setAttack] = useState<Attack | null>(null)
  const [attempts, setAttempts] = useState<DefenseAttempt[]>([])
  const requestKey = `${lobbyId ?? ''}:${attackId ?? ''}`
  const [loadedKey, setLoadedKey] = useState(requestKey)
  const currentKeyRef = useRef(requestKey)
  currentKeyRef.current = requestKey

  if (loadedKey !== requestKey) {
    setLoadedKey(requestKey)
    setAttack(null)
    setAttempts([])
  }

  const refresh = useCallback(async () => {
    const requested = `${lobbyId ?? ''}:${attackId ?? ''}`
    if (!lobbyId || !attackId) {
      setAttack(null)
      setAttempts([])
      return
    }
    const [nextAttack, nextAttempts] = await Promise.all([
      getAttack(client, lobbyId, attackId),
      getDefenseAttempts(client, lobbyId, attackId, address),
    ])
    if (currentKeyRef.current !== requested) return
    // Blocks arrive continuously and are mostly uneventful; keeping the
    // previous object when nothing moved is what stops every one of them
    // from re-rendering the entire playfield. See `utils/identity.ts`.
    setAttack((current) => keepIfUnchanged(current, nextAttack))
    setAttempts((current) => keepIfUnchanged(current, nextAttempts))
  }, [client, lobbyId, attackId, address])

  useEffect(() => {
    refresh()
    // Launch and resolution are block-driven, not event-driven — nothing
    // "happens" when the impact block arrives except a new block — so the
    // block feed is what keeps this in step, the same way `useLobby` does.
    const unsubscribeBlocks = client.subscribeToBlocks(refresh)
    const unsubscribeEvents = client.subscribeToEvents('all', (log) => {
      const payload = log.payload as { lobbyId?: Hash }
      if (payload.lobbyId === lobbyId) refresh()
    })
    return () => {
      unsubscribeBlocks()
      unsubscribeEvents()
    }
  }, [refresh, client, lobbyId])

  const ownAttempt = address
    ? (attempts.find((attempt) => sameAddress(attempt.participant, address)) ?? null)
    : null

  return {
    attack,
    // See `UseOperationResult.activity`. A frozen module-level constant, so
    // the identity is stable and a consumer memoising on it never re-runs.
    activity: NO_ACTIVITY,
    attempts,
    ownAttempt,
    ownDefensePoint: openOwnDefensePoint(ownAttempt, address),
    refresh,
  }
}
