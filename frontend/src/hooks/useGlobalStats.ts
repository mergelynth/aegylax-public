import { useEffect, useRef, useState } from 'react'
import { getGameStats } from '../game/gameService'
import type { GameStats } from '../game/types'
import { useBlockchainClient } from './useBlockchainClient'

/**
 * Whether two reads say the same thing.
 *
 * `getGameStats` builds a fresh object every call, so storing it unconditionally
 * meant a new identity — and therefore a re-render of the header, every metric
 * in it and the Event Horizon timer — on *every block*, whether or not a single
 * figure had moved. Most blocks move nothing: attacks resolve on epoch
 * boundaries, and an epoch is a hundred-odd blocks long.
 *
 * `currentBlock` is deliberately part of the comparison rather than excluded
 * from it — it is the one field that genuinely does change every block, and the
 * epoch readout is derived from the same read — but everything else is what
 * makes the comparison worth doing at all.
 */
function isSameStats(a: GameStats | null, b: GameStats): boolean {
  if (a === null) return false
  return (
    a.activeLobbies === b.activeLobbies &&
    a.totalLobbies === b.totalLobbies &&
    a.totalAttacks === b.totalAttacks &&
    a.interceptedAttacks === b.interceptedAttacks &&
    a.missedAttacks === b.missedAttacks &&
    a.currentBlock === b.currentBlock &&
    a.currentEpoch === b.currentEpoch &&
    a.globalDefensePool === b.globalDefensePool &&
    a.globalDefenseLobbyId === b.globalDefenseLobbyId
  )
}

/**
 * Global stats (spec §12, §47) — read through the abstraction, never from a
 * directly-mutated cache. Initial load, then push-driven: game events
 * refresh immediately, and `subscribeToBlocks` catches aggregate numbers
 * that only change via lazy settlement on a read (no event fires when a
 * deadline silently passes with no lobbies to read from elsewhere).
 *
 * Two guards keep that from turning into a treadmill. Reads are **coalesced**,
 * so a block push arriving while the previous read is still in flight is
 * dropped rather than queued — against a public RPC a slow read used to leave
 * a growing backlog of identical requests behind it. And the result is stored
 * only when it **differs**, so the quiet blocks between epoch boundaries — which
 * is nearly all of them — cost nothing on screen.
 */
export function useGlobalStats(): GameStats | null {
  const client = useBlockchainClient()
  const [stats, setStats] = useState<GameStats | null>(null)
  /* Read inside `refresh` without making it a dependency of the effect —
     re-subscribing on every stats change would defeat the point. */
  const latest = useRef<GameStats | null>(null)

  useEffect(() => {
    let cancelled = false
    let inFlight = false

    const refresh = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const next = await getGameStats(client)
        if (cancelled || isSameStats(latest.current, next)) return
        latest.current = next
        setStats(next)
      } catch {
        // A read that failed is the next block's problem: the feed is a
        // stream, so there is always another attempt coming and the last
        // good figures stay on screen in the meantime.
      } finally {
        inFlight = false
      }
    }

    refresh()
    const unsubscribeEvents = client.subscribeToEvents('all', refresh)
    const unsubscribeBlocks = client.subscribeToBlocks(refresh)

    return () => {
      cancelled = true
      unsubscribeEvents()
      unsubscribeBlocks()
    }
  }, [client])

  return stats
}
