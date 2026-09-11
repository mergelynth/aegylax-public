import { getEpochStartBlock } from './epochs'
import type { Address, Hash, Lobby } from './types'

/**
 * The emulator's stand-in for the deployed game contract — protocol-owned
 * draws are minted to this address there, and to `address(this)` on chain.
 */
export const PROTOCOL_ESCROW_ADDRESS = '0x0000000000000000000000000000000041454758' as Address

/**
 * Whether this operation is the protocol's own draw, not a player-created one.
 *
 * Creator name is not evidence — anyone can mint a lobby called "Global
 * Defense". On chain the creator is the game contract; in the emulator it is
 * `PROTOCOL_ESCROW_ADDRESS`. Either match is enough. A player lobby never is.
 */
export function isProtocolOwnedLobby(creator: string, contractAddress?: string | null): boolean {
  const a = creator.toLowerCase()
  if (a === PROTOCOL_ESCROW_ADDRESS.toLowerCase()) return true
  if (contractAddress && a === contractAddress.toLowerCase()) return true
  return false
}

/**
 * A protocol draw (or any room) that can never start: still OPEN, past
 * the deadline, short of `minPlayers`. The jackpot's leftover sits in
 * this state until a write closes it.
 */
export function isUnfilledPastDraw(
  lobby: Pick<Lobby, 'status' | 'participantCount' | 'config'>,
  blockNumber: number | null,
  nowMs: number,
): boolean {
  if (lobby.status !== 'OPEN') return false
  if (lobby.participantCount >= lobby.config.participation.minPlayers) return false
  const deadlineBlock = lobby.config.participation.deadlineBlock
  if (deadlineBlock > 0 && blockNumber !== null) return blockNumber >= deadlineBlock
  return nowMs >= lobby.config.participation.deadline
}

/**
 * What a Global Defense round is actually playing for.
 *
 * A protocol draw does not hold its bounty. `openGlobalDefense` mints the
 * room with `startPrizePool: 0` and leaves every wei in `globalDefensePool`
 * — `topUpDraw` explicitly refuses to move the pile into an OPEN draw — and
 * only `commitDrawBounty`, at activation, escrows it. That is deliberate:
 * an under-filled room cannot strand the jackpot. But it means the lobby's
 * own figures read 0 for the whole application window, and stay 0 forever
 * on a room that never filled, which is the one number a defender is
 * choosing by.
 *
 * So the jackpot is carried alongside the lobby (`Lobby.drawBounty`) and
 * folded in here rather than at each of the places that print a pool.
 *
 * `startPrizePool` is the test for whether that has already happened,
 * because `commitDrawBounty` is the only thing that ever makes a draw's
 * non-zero: until it has run the pile is outside the lobby, and after it
 * has, `lobbyPool` is the whole of it and adding again would double it.
 * Player operations funded theirs at creation and never take this branch.
 */
export function drawPrizePool(input: {
  /** What the lobby itself reports — its bounty plus entries, as the chain computes it. */
  lobbyPool: number
  /** The lobby's own bounty. Zero on a draw that has not escrowed the jackpot yet. */
  startPrizePool: number
  protocolOwned: boolean
  /**
   * The jackpot standing behind this draw: the idle pool while the room is
   * still open, and what it was playing for once it has ended unplayed.
   * Null when nothing recorded it — an old row, or a read that has not
   * landed — and then the lobby's own figure stands alone.
   */
  drawBounty?: number | null
}): number {
  const { lobbyPool, startPrizePool, protocolOwned, drawBounty } = input
  if (!protocolOwned || !drawBounty) return lobbyPool
  if (startPrizePool > 0) return lobbyPool
  return lobbyPool + drawBounty
}

/** Preferred Global Defense application window — a calendar day. */
export const GLOBAL_DEFENSE_JOIN_WINDOW_MS = 24 * 60 * 60 * 1000

export interface GlobalDefenseSchedule {
  nextEpoch: number
  /** Last block applications stay open. The threat launches the epoch after this. */
  deadlineBlock: number
  /** First block `openGlobalDefense` is accepted. */
  openFromBlock: number
  joinWindowBlocks: number
}

/**
 * How many blocks a Global Defense draw stays open for applications.
 *
 * Prefer a calendar day so there is time to notice and join. If the whole
 * interval is shorter than a day, a day-long window would eat the cadence
 * and leave nothing to accumulate toward the next draw — so the window
 * shrinks to half the interval (~500 epochs when the interval is 1000).
 */
export function globalDefenseJoinWindowBlocks(input: {
  intervalEpochs: number
  epochBlocks: number
  blockTimeMs: number
  joinWindowMs?: number
}): number {
  const joinWindowMs = input.joinWindowMs ?? GLOBAL_DEFENSE_JOIN_WINDOW_MS
  const { intervalEpochs, epochBlocks, blockTimeMs } = input
  if (intervalEpochs <= 0 || epochBlocks <= 0 || blockTimeMs <= 0) return 0
  const intervalBlocks = intervalEpochs * epochBlocks
  const preferred = Math.max(1, Math.round(joinWindowMs / blockTimeMs))
  if (intervalBlocks < preferred) return Math.max(1, Math.ceil(intervalBlocks / 2))
  return Math.min(preferred, Math.max(1, intervalBlocks - 1))
}

/**
 * When the next Global Defense lobby may be opened, and when it closes.
 *
 * The draw still plays at the next interval epoch (1000, 2000, …). Opening
 * is refused until `openFromBlock`, which is `joinWindowBlocks` before that
 * epoch — so the rest of the interval is left to accumulate prizes.
 */
export function isInGlobalDefenseJoinWindow(schedule: GlobalDefenseSchedule, blockNumber: number): boolean {
  return blockNumber >= schedule.openFromBlock && blockNumber < schedule.deadlineBlock
}

export function globalDefenseSchedule(input: {
  currentEpoch: number
  intervalEpochs: number
  epochBlocks: number
  genesisBlock: number
  blockTimeMs: number
  joinWindowMs?: number
}): GlobalDefenseSchedule | null {
  const { currentEpoch, intervalEpochs, epochBlocks, genesisBlock } = input
  if (intervalEpochs <= 0 || epochBlocks <= 0) return null
  const nextEpoch = (Math.floor(currentEpoch / intervalEpochs) + 1) * intervalEpochs
  const deadlineBlock = getEpochStartBlock(nextEpoch, epochBlocks, genesisBlock) - 1
  const joinWindowBlocks = globalDefenseJoinWindowBlocks(input)
  const openFromBlock = Math.max(0, deadlineBlock - joinWindowBlocks)
  return { nextEpoch, deadlineBlock, openFromBlock, joinWindowBlocks }
}

/**
 * What the trophy should show: every wei still in the jackpot.
 *
 * That is the idle pile plus anything a live (or leftover) draw has
 * already escrowed. A leftover room sitting outside the join window used
 * to be dropped, which painted 0 while the bounty was locked in that
 * lobby. The figure is 0 only when both halves are empty.
 */
export function resolveJackpot(input: {
  pool: number
  lobbyId: Hash | null | undefined
  lobby: Pick<Lobby, 'status' | 'creatorSettled' | 'outcome' | 'config'> | null
  /** idle = accumulating. open = join window. play = attack running or settling. */
  phase?: 'idle' | 'open' | 'play'
}): { held: number; jackpot: number } {
  const phase = input.phase ?? 'open'
  const lobbyPending = Boolean(input.lobbyId) && input.lobby === null
  if (lobbyPending && phase !== 'idle') return { held: 0, jackpot: 0 }

  const { lobby } = input
  const held =
    lobby && !lobby.creatorSettled && !(lobby.status === 'RESOLVED' && lobby.outcome?.intercepted)
      ? lobby.config.economics.prizePool
      : 0

  return { held, jackpot: held + input.pool }
}
