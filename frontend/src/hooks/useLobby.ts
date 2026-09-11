import { useCallback, useEffect, useRef, useState } from 'react'
import { getLobby, getLobbyParticipants } from '../game/gameService'
import type { Hash, Lobby, Participant } from '../game/types'
import { keepIfUnchanged } from '../utils/identity'
import { useBlockchainClient } from './useBlockchainClient'
import { useWallet } from './useWallet'

export interface UseLobbyResult {
  lobby: Lobby | null
  participants: Participant[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

function sameLobbyId(a: string | undefined, b: string | null): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase())
}

function sameRequestedId(a: Hash | null, b: Hash | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * Subscribes to one lobby's public state (spec §16): refreshed on relevant
 * events, and on every block for time-driven transitions (deadlines, epoch
 * ticks) that fire without an event.
 *
 * Every refresh returns freshly-built objects, so storing them blindly
 * would hand React a new identity on every block whether or not anything
 * changed — and the Operation screen re-renders the whole playfield off
 * these. `keepIfUnchanged` keeps the previous object when the new one is
 * identical, so a quiet block costs nothing.
 */
export function useLobby(lobbyId: Hash | null): UseLobbyResult {
  const client = useBlockchainClient()
  const { address } = useWallet()
  const [lobby, setLobby] = useState<Lobby | null>(null)
  const [participants, setParticipants] = useState<Participant[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [loadedId, setLoadedId] = useState<Hash | null>(lobbyId)
  const currentIdRef = useRef(lobbyId)
  currentIdRef.current = lobbyId

  /*
   * Drop the previous operation the instant the URL changes, before paint.
   *
   * Waiting for the fetch would keep the last lobby on screen for the whole
   * RPC round-trip — on a public RPC that is a couple of seconds of the
   * wrong countdown, grid and Command Center after the address bar has
   * already moved. Resetting here is the React "adjust state while
   * rendering" pattern: same component, new identity, empty until the
   * matching read lands. In-flight replies for the old id are ignored
   * below via `currentIdRef`.
   */
  if (!sameRequestedId(loadedId, lobbyId)) {
    setLoadedId(lobbyId)
    setLobby(null)
    setParticipants([])
    setError(null)
    setLoading(Boolean(lobbyId))
  }

  const refresh = useCallback(async () => {
    const requested = lobbyId
    const isCurrent = () =>
      requested ? sameLobbyId(requested, currentIdRef.current) : currentIdRef.current === null
    if (!requested) {
      setLobby(null)
      setParticipants([])
      setError(null)
      setLoading(false)
      return
    }
    try {
      const nextLobby = await getLobby(client, requested)
      if (!isCurrent()) return
      setLobby((current) => keepIfUnchanged(current, nextLobby))
      try {
        const nextParticipants = await getLobbyParticipants(client, requested, address)
        if (!isCurrent()) return
        setParticipants((current) => keepIfUnchanged(current, nextParticipants))
        setError(null)
      } catch (err) {
        // Show the operation even when a participant struct cannot be
        // decoded — that mismatch used to leave this hook on `loading`
        // forever, which the page rendered as a missing lobby.
        if (!isCurrent()) return
        setError(err instanceof Error ? err.message : String(err))
      }
    } catch (err) {
      if (!isCurrent()) return
      setLobby(null)
      setParticipants([])
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [client, lobbyId, address])

  useEffect(() => {
    setLoading(true)
    refresh()
    const unsubscribeEvents = client.subscribeToEvents('all', (log) => {
      const payload = log.payload as { lobbyId?: Hash }
      if (sameLobbyId(payload.lobbyId, lobbyId)) refresh()
    })
    const unsubscribeBlocks = client.subscribeToBlocks(refresh)
    return () => {
      unsubscribeEvents()
      unsubscribeBlocks()
    }
  }, [refresh, client, lobbyId])

  return { lobby, participants, loading, error, refresh }
}
