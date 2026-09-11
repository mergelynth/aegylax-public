import { ethToWei } from '../blockchain/contract/codec'
import { getConfiguredContractAddress } from '../contracts/addresses'
import { drawPrizePool, isProtocolOwnedLobby } from '../game/globalDefense'
import type { Address, Lobby, Participant } from '../game/types'
import { sameAddress } from '../utils/address'
import type { DirectoryCounts, LobbyStatus, LobbySummary, PlayerLobby } from './useLobbyDirectory'
import type { PlayerRecord } from './usePlayerRecord'

/** Same bound the log fold uses — twelve marks fill one row at panel width. */
const RECENT_ROUNDS = 12

/**
 * This tab's operations, as the directory already knows how to draw them.
 *
 * Newest first. Status is the four words the page filters on, not the
 * chain's six: CREATED/OPEN are joinable, READY/ACTIVE are in flight.
 */
export function foldLobbySummaries(lobbies: readonly Lobby[]): LobbySummary[] {
  return [...lobbies]
    .sort((a, b) => b.createdAtBlock - a.createdAtBlock)
    .map(toSummary)
}

export function filterSummaries(
  lobbies: readonly LobbySummary[],
  filter: LobbyStatus | 'all',
  query: string,
): LobbySummary[] {
  const needle = query.trim().toLowerCase()
  return lobbies.filter((lobby) => {
    if (filter !== 'all' && lobby.status !== filter) return false
    if (!needle) return true
    return lobby.name.toLowerCase().includes(needle) || lobby.id.toLowerCase().includes(needle)
  })
}

/** Tab figures: how many of each status, after search, before the status filter. */
export function tallySummaries(lobbies: readonly LobbySummary[]): DirectoryCounts {
  const counts: DirectoryCounts = { open: 0, active: 0, finished: 0, cancelled: 0, all: 0 }
  for (const lobby of lobbies) {
    counts[lobby.status] += 1
    counts.all += 1
  }
  return counts
}

export function foldPlayerLobbies(
  lobbies: readonly Lobby[],
  participants: readonly Pick<Participant, 'address' | 'lobbyId'>[],
  address: Address,
): { live: PlayerLobby[]; past: PlayerLobby[] } {
  const seated = new Set(
    participants.filter((row) => sameAddress(row.address, address)).map((row) => row.lobbyId),
  )
  const live: PlayerLobby[] = []
  const past: PlayerLobby[] = []
  for (const lobby of foldLobbySummaries(lobbies)) {
    const created = sameAddress(lobby.creator, address)
    const joined = seated.has(lobby.id)
    if (!created && !joined) continue
    const row: PlayerLobby = { ...lobby, created, joined }
    if (lobby.status === 'open' || lobby.status === 'active') live.push(row)
    else past.push(row)
  }
  return { live, past }
}

/**
 * What this wallet did in this tab, counted the same way the backend fold
 * counts a chain: seats taken, rounds that were actually a contest, money
 * the protocol received and paid back.
 */
export function foldPlayerRecord(
  lobbies: readonly Lobby[],
  participants: readonly Participant[],
  address: Address,
): PlayerRecord {
  const mine = participants.filter((row) => sameAddress(row.address, address))
  const opened = lobbies.filter((lobby) => sameAddress(lobby.creator, address))
  const byLobby = new Map(mine.map((row) => [row.lobbyId, row]))

  let stakedWei = 0n
  let wonWei = 0n
  let returnedWei = 0n
  let creatorFeesWei = 0n
  let probesBought = 0
  let probesSent = 0
  let defensesSubmitted = 0
  let firstBlock: number | null = null
  let lastBlock: number | null = null

  const touch = (block: number) => {
    if (firstBlock === null || block < firstBlock) firstBlock = block
    if (lastBlock === null || block > lastBlock) lastBlock = block
  }

  for (const lobby of opened) {
    touch(lobby.createdAtBlock)
    if (lobby.creatorSettled && lobby.creatorSettlement > 0) {
      creatorFeesWei += ethToWei(lobby.creatorSettlement)
    }
  }

  for (const row of mine) {
    touch(row.joinedAtBlock)
    stakedWei += ethToWei(row.paidIn)
    probesBought += row.purchasedDrones
    probesSent += row.probeIds.length
    defensesSubmitted += row.defenseAttemptIds.length
    if (row.refunded) returnedWei += ethToWei(row.paidIn)
  }

  const contested = lobbies
    .filter((lobby) => lobby.status === 'RESOLVED' && lobby.ending !== 'UNPLAYED' && byLobby.has(lobby.id))
    .filter((lobby) => someoneActed(participants, lobby.id))
    .sort((a, b) => a.createdAtBlock - b.createdAtBlock)

  let interceptions = 0
  let currentStreak = 0
  let bestStreak = 0
  const recentRounds: boolean[] = []

  for (const lobby of contested) {
    const hit = Boolean(lobby.outcome?.winners.some((winner) => sameAddress(winner, address)))
    recentRounds.push(hit)
    if (hit) {
      interceptions += 1
      currentStreak += 1
      if (currentStreak > bestStreak) bestStreak = currentStreak
      if (lobby.outcome) wonWei += ethToWei(lobby.outcome.rewardPerWinner)
    } else {
      currentStreak = 0
    }
  }

  return {
    address: address.toLowerCase() as Address,
    operationsCreated: opened.length,
    operationsJoined: mine.length,
    operationsLeft: 0,
    roundsPlayed: contested.length,
    interceptions,
    currentStreak,
    bestStreak,
    probesBought,
    probesSent,
    defensesSubmitted,
    recentRounds: recentRounds.slice(-RECENT_ROUNDS),
    stakedWei: stakedWei.toString(),
    wonWei: wonWei.toString(),
    creatorFeesWei: creatorFeesWei.toString(),
    returnedWei: returnedWei.toString(),
    firstBlock,
    lastBlock,
  }
}

function someoneActed(participants: readonly Participant[], lobbyId: Lobby['id']): boolean {
  return participants.some(
    (row) => row.lobbyId === lobbyId && (row.probeIds.length > 0 || row.defenseAttemptIds.length > 0),
  )
}

function toSummary(lobby: Lobby): LobbySummary {
  const entry = lobby.config.participation.entryPrice
  const start = lobby.config.economics.prizePool
  /*
   * A Global Defense draw holds none of its bounty until the round starts,
   * so `start` is 0 for the whole application window and stays 0 forever on
   * a room that never filled. `drawPrizePool` folds the jackpot back in;
   * without it every protocol row in this directory reads "Pool 0 ETH"
   * beside a trophy showing the pile it is playing for.
   */
  const pool = drawPrizePool({
    lobbyPool: start + entry * lobby.participantCount,
    startPrizePool: start,
    protocolOwned: isProtocolOwnedLobby(lobby.creator, getConfiguredContractAddress()),
    drawBounty: lobby.drawBounty,
  })
  const status = toDirectoryStatus(lobby)
  return {
    id: lobby.id,
    name: lobby.config.name,
    creator: lobby.creator,
    entryPriceWei: ethToWei(entry).toString(),
    startPrizePoolWei: ethToWei(start).toString(),
    registrationDeadline: Math.floor(lobby.config.participation.deadline / 1000),
    participants: lobby.participantCount,
    maxPlayers: lobby.config.participation.maxPlayers,
    minPlayers: lobby.config.participation.minPlayers,
    rewardPoolWei: ethToWei(pool).toString(),
    drawBountyWei: lobby.drawBounty ? ethToWei(lobby.drawBounty).toString() : null,
    status,
    intercepted: lobby.outcome ? lobby.outcome.intercepted : null,
    endedReason: lobby.ending === 'NONE' ? null : lobby.ending.toLowerCase(),
    createdBlock: lobby.createdAtBlock,
    startedBlock: lobby.status === 'OPEN' || lobby.status === 'CREATED' ? null : lobby.createdAtBlock,
    endedBlock: status === 'finished' || status === 'cancelled' ? lobby.createdAtBlock : null,
  }
}

function toDirectoryStatus(lobby: Lobby): LobbyStatus {
  if (lobby.status === 'CANCELLED') return 'cancelled'
  if (lobby.status === 'RESOLVED') return 'finished'
  if (lobby.status === 'ACTIVE' || lobby.status === 'READY') return 'active'
  return 'open'
}
