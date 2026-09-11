import { useCallback, useEffect, useState } from 'react'
import type { ContractBlockchainClient } from '../blockchain/contract/ContractBlockchainClient'
import type { EmulatorBlockchainClient } from '../blockchain/EmulatorBlockchainClient'
import type { BlockchainClient } from '../blockchain/types'
import { appConfig } from '../config/env'
import { getConfiguredContractAddress } from '../contracts/addresses'
import type { Address, Lobby } from '../game/types'
import { filterSummaries, foldLobbySummaries, foldPlayerLobbies, tallySummaries } from './emulatorFold'
import { useBlockchainClient } from './useBlockchainClient'

/**
 * Every operation the protocol has opened, and the ones this wallet is in.
 *
 * Both come from `api/indexer/` when it is running, which folds them out of
 * the protocol's own event log. The contract can answer the same question —
 * page `getLobbyIds`, then `getLobby` for each — and this hook does that
 * when the index is down, so a local `npm run dev` against the chain still
 * has a list. The backend remains the cheaper path: one request, already
 * filtered.
 *
 * Nothing here is a source of truth for money or state. A summary carries
 * what the events said when the operation was opened and what has happened to
 * it since; the moment somebody follows a link, the lobby page reads the
 * contract itself.
 */

export type LobbyStatus = 'open' | 'active' | 'finished' | 'cancelled'

/** How many operations sit in each status — the figures on the filter tabs. */
export interface DirectoryCounts {
  open: number
  active: number
  finished: number
  cancelled: number
  all: number
}

export interface LobbySummary {
  id: `0x${string}`
  name: string
  creator: string
  entryPriceWei: string
  startPrizePoolWei: string
  /** Unix seconds. */
  registrationDeadline: number
  participants: number
  /** Seats in total, and the floor to start — null until the backend has read them. */
  maxPlayers: number | null
  minPlayers: number | null
  /**
   * What winners share, as the contract computes it — with a Global Defense
   * draw's jackpot folded in, since the draw does not hold it until the
   * round starts. Null on old operations. See `drawPrizePool`.
   */
  rewardPoolWei: string | null
  /** The jackpot behind a protocol draw. Null on every player operation. */
  drawBountyWei: string | null
  status: LobbyStatus
  intercepted: boolean | null
  endedReason: string | null
  createdBlock: number
  startedBlock: number | null
  endedBlock: number | null
}

/** One wallet's relationship to an operation: a creator need not take a seat. */
export interface PlayerLobby extends LobbySummary {
  joined: boolean
  created: boolean
}

export type DirectoryStatus = 'idle' | 'loading' | 'ready' | 'unavailable'

/**
 * Whether this build has anywhere to ask.
 *
 * Contract mode needs the backend index. The emulator lists the rooms that
 * live in this tab, so the screen is offered there too.
 */
export function directoryAvailable(): boolean {
  return true
}

/**
 * A backend answering is not the same as a backend answering about *us*.
 *
 * The indexer holds the deployment manifest it read at boot. A redeploy
 * rewrites that manifest, and a process started before it keeps folding the
 * previous contract's log — happily, correctly, and about a protocol this
 * build is not playing. The answers stay well-formed, so nothing fails:
 * the directory simply fills with another deployment's rooms while the HUD,
 * which reads the chain directly, shows an empty protocol beside it.
 *
 * So the address is compared rather than assumed. A mismatch is treated as
 * no backend at all, which drops the caller onto the chain read it already
 * falls back to when the index is down — a shorter list, and this
 * deployment's.
 *
 * Answers with no `contract` are from a backend older than this check and
 * are let through: refusing them would break the directory on every
 * deployment that has not been redeployed yet.
 */
function servesThisDeployment(body: { contract?: unknown } | null): boolean {
  const theirs = typeof body?.contract === 'string' ? body.contract.toLowerCase() : null
  if (!theirs) return true
  const ours = getConfiguredContractAddress()?.toLowerCase()
  if (!ours) return true
  return theirs === ours
}

/**
 * The backend index, if one is answering about *this* deployment.
 *
 * Exported for `useDrawBounty`, which needs one row's worth of the same
 * fold. Nothing here is a source of truth for money — see the note above.
 */
export async function ask<T>(path: string): Promise<T | null> {
  const bases = appConfig.apiBaseUrl ? [appConfig.apiBaseUrl, ''] : ['']
  for (const base of bases) {
    try {
      const response = await fetch(`${base}${path}`)
      const body = (await response.json().catch(() => null)) as ({ ok: boolean } & T) | null
      if (!response.ok || !body || body.ok !== true) continue
      if (!servesThisDeployment(body as { contract?: unknown })) continue
      return body
    } catch {
      // This origin has no backend; try the next, then the chain.
    }
  }
  return null
}

function asEmulator(client: BlockchainClient): EmulatorBlockchainClient | null {
  if (client.mode !== 'emulator') return null
  return client as EmulatorBlockchainClient
}

function asContract(client: BlockchainClient): ContractBlockchainClient | null {
  if (client.mode !== 'contract') return null
  const contract = client as ContractBlockchainClient
  if (typeof contract.listDirectoryPage !== 'function') return null
  return contract
}

/**
 * Newest rooms, capped. The contract stores ids oldest-first; the directory
 * shows the other end of that array, which is what a visitor is choosing
 * between. Sixty is the same ceiling the indexer uses for live reads.
 */
const CHAIN_WINDOW = 60

async function loadChainWindow(client: BlockchainClient, includeMembers: boolean): Promise<Lobby[] | null> {
  const contract = asContract(client)
  if (!contract) return null
  try {
    const probe = await contract.listDirectoryPage(0, 1, includeMembers)
    if (probe.total === 0) return []
    const start = Math.max(0, probe.total - CHAIN_WINDOW)
    if (start === 0 && probe.lobbies.length >= probe.total) return probe.lobbies
    const page = await contract.listDirectoryPage(start, CHAIN_WINDOW, includeMembers)
    return page.lobbies
  } catch {
    return null
  }
}

export interface UseLobbyDirectoryResult {
  status: DirectoryStatus
  lobbies: LobbySummary[]
  /** How many match the filter and the search, not how many were returned. */
  total: number
  /** Per-status totals for the tab figures, matching the search, not the status filter. */
  counts: DirectoryCounts | null
  syncing: boolean
  /** Whether anything matched is still unfetched. */
  hasMore: boolean
  loadingMore: boolean
  loadMore: () => void
}

/**
 * One page. Twenty rows is about two screens of scrolling — long enough that
 * paging is rare, short enough that the first paint is not a hundred rows
 * nobody asked for.
 */
export const PAGE_SIZE = 20

export function useLobbyDirectory(filter: LobbyStatus | 'all', query = ''): UseLobbyDirectoryResult {
  const client = useBlockchainClient()
  const [status, setStatus] = useState<DirectoryStatus>('idle')
  const [lobbies, setLobbies] = useState<LobbySummary[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<DirectoryCounts | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [page, setPage] = useState(0)

  // A new filter or a new search is a different question, so it starts at the
  // first page rather than continuing somebody else's scroll.
  useEffect(() => {
    setPage(0)
  }, [filter, query])

  useEffect(() => {
    const emulator = asEmulator(client)
    if (emulator) {
      const refresh = () => {
        const summaries = foldLobbySummaries(emulator.inspect().lobbies)
        const matched = filterSummaries(summaries, filter, query)
        const start = page * PAGE_SIZE
        setLobbies(matched.slice(0, start + PAGE_SIZE))
        setTotal(matched.length)
        setCounts(tallySummaries(filterSummaries(summaries, 'all', query)))
        setSyncing(false)
        setStatus('ready')
      }
      refresh()
      return emulator.subscribeToBlocks(refresh)
    }

    let cancelled = false
    setStatus((current) => (current === 'ready' && page > 0 ? current : 'loading'))

    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) })
    if (filter !== 'all') params.set('status', filter)
    if (query.trim()) params.set('q', query.trim())

    void (async () => {
      const body = await ask<{
        lobbies: LobbySummary[]
        total: number
        syncing: boolean
        counts?: DirectoryCounts
      }>(`/api/lobbies?${params}`)
      if (cancelled) return
      if (body) {
        // Appending only on a later page: page zero is a fresh answer to a new
        // question, and merging it into the old one would show both.
        setLobbies((current) => (page === 0 ? body.lobbies : [...current, ...body.lobbies]))
        setTotal(body.total)
        setCounts(body.counts ?? fallbackCounts(filter, body.total))
        setSyncing(body.syncing)
        setStatus('ready')
        return
      }

      const window = await loadChainWindow(client, false)
      if (cancelled) return
      if (!window) {
        setStatus('unavailable')
        return
      }
      const summaries = foldLobbySummaries(window)
      const matched = filterSummaries(summaries, filter, query)
      const start = page * PAGE_SIZE
      setLobbies(matched.slice(0, start + PAGE_SIZE))
      setTotal(matched.length)
      setCounts(tallySummaries(filterSummaries(summaries, 'all', query)))
      setSyncing(false)
      setStatus('ready')
    })()

    return () => {
      cancelled = true
    }
  }, [client, filter, query, page])

  const loadMore = useCallback(() => setPage((value) => value + 1), [])

  return {
    status,
    lobbies,
    total,
    counts,
    syncing,
    hasMore: lobbies.length < total,
    loadingMore: status === 'loading' && page > 0,
    loadMore,
  }
}

function fallbackCounts(filter: LobbyStatus | 'all', total: number): DirectoryCounts {
  const counts: DirectoryCounts = { open: 0, active: 0, finished: 0, cancelled: 0, all: total }
  if (filter !== 'all') counts[filter] = total
  return counts
}

export interface UsePlayerLobbiesResult {
  status: DirectoryStatus
  /** Still taking applications, or in flight — the ones worth a link. */
  live: PlayerLobby[]
  /** Finished or cancelled, newest first, capped by the backend. */
  past: PlayerLobby[]
}

export function usePlayerLobbies(address: Address | null): UsePlayerLobbiesResult {
  const client = useBlockchainClient()
  const [status, setStatus] = useState<DirectoryStatus>('idle')
  const [live, setLive] = useState<PlayerLobby[]>([])
  const [past, setPast] = useState<PlayerLobby[]>([])

  useEffect(() => {
    if (!address) {
      setStatus('unavailable')
      return
    }

    const emulator = asEmulator(client)
    if (emulator) {
      const refresh = () => {
        const snapshot = emulator.inspect()
        const mine = foldPlayerLobbies(snapshot.lobbies, snapshot.participants, address)
        setLive(mine.live)
        setPast(mine.past)
        setStatus('ready')
      }
      refresh()
      return emulator.subscribeToBlocks(refresh)
    }

    let cancelled = false
    setStatus('loading')

    void (async () => {
      const body = await ask<{ live: PlayerLobby[]; past: PlayerLobby[] }>(`/api/players/${address}/lobbies`)
      if (cancelled) return
      if (body) {
        setLive(body.live)
        setPast(body.past)
        setStatus('ready')
        return
      }

      const window = await loadChainWindow(client, true)
      if (cancelled) return
      if (!window) {
        setStatus('unavailable')
        return
      }
      const seated = window.flatMap((lobby) =>
        lobby.participantAddresses.map((member) => ({ lobbyId: lobby.id, address: member })),
      )
      const mine = foldPlayerLobbies(window, seated, address)
      setLive(mine.live)
      setPast(mine.past)
      setStatus('ready')
    })()

    return () => {
      cancelled = true
    }
  }, [address, client])

  return { status, live, past }
}

/** "Sunrise Watch", or the short id for an operation whose author named it nothing. */
export function lobbyTitle(lobby: LobbySummary): string {
  const name = lobby.name.trim()
  return name.length > 0 ? name : `Operation ${lobby.id.slice(2, 8)}`
}
