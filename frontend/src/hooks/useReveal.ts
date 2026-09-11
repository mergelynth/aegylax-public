import { useCallback, useEffect, useRef, useState } from 'react'
import { appConfig } from '../config/env'
import { getAttackReveal, revealAttack } from '../game/gameService'
import type { AttackRevealData, Hash } from '../game/types'
import { shareJob } from '../utils/shareJob'
import type { BlockchainClient } from '../blockchain/types'
import { useBlockchainClient } from './useBlockchainClient'
import { useWallet } from './useWallet'

export interface UseRevealResult {
  /** The trajectory and everyone's Defense Points — null until somebody has revealed. */
  data: AttackRevealData | null
  /**
   * Whether the chain has answered at least once for the current attack.
   *
   * `data === null` on its own is ambiguous — it means both "nobody has
   * revealed" and "we have not asked yet" — and the difference decides
   * whether the screen is watching a reveal happen or reading one back. See
   * `LobbyPage`, which uses exactly this to know whether to perform the
   * impact or simply show it.
   */
  loaded: boolean
  /**
   * Whether this operation has been *scored*, as opposed to whether the
   * epoch's geometry is public. See `AttackRevealData.scored` — `data` can be
   * non-null with a drawable trajectory while this is still false.
   */
  scored: boolean
  /** True while this client is sending the reveal transaction. */
  busy: boolean
  error: string | null
  /** Ask the protocol to open the geometry. Only the first caller ever needs to. */
  request: () => Promise<void>
}

/** In-flight reveals, by `lobbyId:attackId`. Outlives the hook — see `request`. */
const revealJobs = new Map<string, Promise<void>>()

/** Exposed for tests: the guard has to outlive components, so it must be resettable. */
export function __resetRevealJobs(): void {
  revealJobs.clear()
}

/**
 * The reveal (ТЗ §4) — something one player *does*, and everyone else
 * simply reads.
 *
 * Two halves, and the split is the whole point. `request()` is a write: it
 * moves the sealed geometry into the operation's own on-chain state, and
 * only the first person to press it pays for or performs it. `data` is an
 * ordinary public read that runs on mount and keeps itself current, so
 * every other client — including one opening the operation a week later —
 * finds the trajectory already there and needs no button at all.
 *
 * That is why nothing here remembers whether *this* client asked. Whether
 * the reveal has happened is a fact about the operation, not about the
 * session, and reading it back rather than latching it locally is what
 * makes it survive a reload and be true in every browser at once.
 */
export function useReveal(lobbyId: Hash | null, attackId: string | null): UseRevealResult {
  const client = useBlockchainClient()
  const { address } = useWallet()
  const [data, setData] = useState<AttackRevealData | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestKey = `${lobbyId ?? ''}:${attackId ?? ''}`
  const [loadedKey, setLoadedKey] = useState(requestKey)
  const currentKeyRef = useRef(requestKey)
  currentKeyRef.current = requestKey

  // A different operation or attack is a different reveal — carrying the
  // last one over would draw one attack's trajectory on another's map, and
  // carrying `loaded` over would make the new one look already-answered.
  if (loadedKey !== requestKey) {
    setLoadedKey(requestKey)
    setData(null)
    setLoaded(false)
    setError(null)
  }

  const fetch = useCallback(async () => {
    const requested = `${lobbyId ?? ''}:${attackId ?? ''}`
    if (!lobbyId || !attackId) {
      setData(null)
      return
    }
    try {
      const next = await getAttackReveal(client, lobbyId, attackId)
      if (currentKeyRef.current !== requested) return
      setData(next)
      setLoaded(true)
    } catch (err) {
      if (currentKeyRef.current !== requested) return
      setLoaded(true)
      const text = err instanceof Error ? err.message : String(err)
      if (!/^not found$/i.test(text) && !/\b404\b/.test(text)) setError(text)
    }
  }, [client, lobbyId, attackId])

  /*
   * Read on mount, then follow the chain. The block feed rather than the
   * event stream alone: the reveal can be performed in another tab or by
   * another player entirely, and this client should pick it up without
   * having been listening at the moment it happened.
   */
  useEffect(() => {
    fetch()
    const unsubscribeBlocks = client.subscribeToBlocks(() => fetch())
    const unsubscribeEvents = client.subscribeToEvents('AttackRevealed', () => fetch())
    return () => {
      unsubscribeBlocks()
      unsubscribeEvents()
    }
  }, [client, fetch])

  /**
   * Ask the protocol to open the geometry.
   *
   * On chain this is the keeper's job — the page never signs it. Emulator
   * mode has no keeper, so the same press still writes locally.
   */
  const request = useCallback(async () => {
    if (!lobbyId || !attackId) {
      setError('Nothing to reveal.')
      return
    }
    return shareJob(revealJobs, `${lobbyId}:${attackId}`, async () => {
      setBusy(true)
      setError(null)
      try {
        if (usesBackendKeeper(client)) {
          await nudgeKeeper(lobbyId)
        } else {
          if (!address) {
            setError('Sign in before revealing the attack.')
            return
          }
          await revealAttack(client, address, { lobbyId, attackId })
        }
        await fetch()
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err)
        if (!/^not found$/i.test(text) && !/\b404\b/.test(text)) setError(text)
        throw err
      } finally {
        setBusy(false)
      }
    })
  }, [client, address, lobbyId, attackId, fetch])

  return { data, loaded, scored: data?.scored ?? false, busy, error, request }
}

/**
 * Contract mode: the backend keeper signs unlock/reveal, not the player's wallet.
 *
 * Exported because it is not only this hook's question. Whether asking for a
 * reveal opens a wallet or posts a form decides who is allowed to ask — see
 * `useProtocolKeeper`, which gates its automatic attempt on gas being spent.
 */
export function usesBackendKeeper(client: BlockchainClient): boolean {
  return client.mode === 'contract' && typeof (client as { maintain?: unknown }).maintain === 'function'
}

/**
 * Ask the keeper to advance *this* operation now.
 *
 * The id matters. Without it the keeper sweeps every lobby to answer one
 * page, and can answer out of a sweep that had already walked past this one
 * — returning `ok` for work it had not done, which the page then reports as
 * a reveal in progress.
 */
async function nudgeKeeper(lobbyId: Hash): Promise<void> {
  const response = await fetch(`${appConfig.apiBaseUrl}/api/keeper/reveal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lobbyId }),
  })
  const body = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null
  if (!response.ok || !body?.ok) {
    throw new Error(body?.error || 'The keeper did not start the reveal. Try again in a moment.')
  }
}
