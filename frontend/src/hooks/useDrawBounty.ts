import { useEffect, useState } from 'react'
import { getConfiguredContractAddress } from '../contracts/addresses'
import { isProtocolOwnedLobby } from '../game/globalDefense'
import type { Lobby } from '../game/types'
import { ask, type LobbySummary } from './useLobbyDirectory'

/**
 * What a *finished* Global Defense draw was playing for.
 *
 * The chain cannot be asked. A draw's bounty never enters the lobby unless
 * the round starts — `commitDrawBounty` is what escrows it — so a room that
 * ended without ever filling handed the pile straight back to
 * `globalDefensePool`, and every figure the contract still holds about that
 * operation is 0. Reading the idle pool instead would answer with a number
 * that has grown since, and attribute later misses to a round that never
 * played for them.
 *
 * The protocol did state it, once, in `GlobalDefenseOpened` — and the
 * indexer folds exactly that (`drawBountyWei`). So this asks the index for
 * the one row, and answers null when there is no backend, which leaves the
 * screen printing the lobby's own figure rather than a guess.
 *
 * A live draw needs none of this: `ContractBlockchainClient` reads the idle
 * pool onto the lobby while it is still open, and the emulator carries the
 * figure in its own state. Both arrive as `Lobby.drawBounty`, which is why
 * this only ever runs once that is empty.
 */
export function useDrawBounty(lobby: Lobby | null): number | null {
  const [bounty, setBounty] = useState<number | null>(null)

  const id = lobby?.id ?? null
  const wanted =
    lobby !== null &&
    !lobby.drawBounty &&
    lobby.config.economics.prizePool === 0 &&
    isProtocolOwnedLobby(lobby.creator, getConfiguredContractAddress())

  useEffect(() => {
    if (!wanted || !id) {
      setBounty(null)
      return
    }

    let cancelled = false
    void (async () => {
      // The id is matched as a substring, so the row is found by the same
      // search the directory's box uses rather than a second endpoint.
      const body = await ask<{ lobbies: LobbySummary[] }>(`/api/lobbies?limit=1&q=${id}`)
      if (cancelled) return
      const row = body?.lobbies.find((entry) => entry.id.toLowerCase() === id.toLowerCase())
      const wei = row?.drawBountyWei
      setBounty(wei ? Number(wei) / 1e18 : null)
    })()

    return () => {
      cancelled = true
    }
  }, [id, wanted])

  return wanted ? bounty : null
}
