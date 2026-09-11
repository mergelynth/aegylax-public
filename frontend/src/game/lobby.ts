import { protocolLimits as defaultProtocolLimits, type ProtocolLimits } from '../config/env'
import { formatEth } from '../utils/format'
import type { Lobby, LobbyConfig, LobbyStatus } from './types'

/**
 * Lobby state machine (spec §43):
 *   CREATED -> OPEN -> READY -> ACTIVE -> RESOLVED
 *   OPEN -> CANCELLED (minimum participants not met by deadline)
 * Final cancellation/refund semantics are TODO (§18, §57).
 */
const TRANSITIONS: Record<LobbyStatus, LobbyStatus[]> = {
  CREATED: ['OPEN'],
  OPEN: ['READY', 'CANCELLED'],
  READY: ['ACTIVE'],
  ACTIVE: ['RESOLVED'],
  RESOLVED: [],
  CANCELLED: [],
}

export function canTransition(from: LobbyStatus, to: LobbyStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

/**
 * Computes what a lobby's status should become given the current time.
 * Only handles the OPEN -> READY/CANCELLED deadline transition — ACTIVE
 * and RESOLVED are driven by attack generation/resolution, not the clock.
 */
export function nextLobbyStatus(
  lobby: Pick<Lobby, 'status' | 'participantCount' | 'config'>,
  nowMs: number,
): LobbyStatus {
  if (lobby.status === 'OPEN' && nowMs >= lobby.config.participation.deadline) {
    return lobby.participantCount >= lobby.config.participation.minPlayers ? 'READY' : 'CANCELLED'
  }
  return lobby.status
}

export function canJoinLobby(
  lobby: Pick<Lobby, 'status' | 'participantCount' | 'config'>,
  nowMs: number,
  /**
   * The chain's head, when the caller has it.
   *
   * Applications close on a *block* — that is the deadline the contract
   * enforces, and the one its attack was scheduled from. The timestamp is
   * what the creator picked and what the screen shows; going by it alone
   * would offer a Join button the chain refuses (or hide one it would still
   * accept) whenever blocks run faster or slower than assumed.
   */
  currentBlock: number | null = null,
): boolean {
  const { deadline, deadlineBlock, maxPlayers } = lobby.config.participation
  const stillOpen =
    deadlineBlock > 0 && currentBlock !== null ? currentBlock < deadlineBlock : nowMs < deadline

  return lobby.status === 'OPEN' && stillOpen && lobby.participantCount < maxPlayers
}

/**
 * How long applications stay open, in ms.
 *
 * The block is the authority — same clock `canJoinLobby` uses — so a Global
 * Defense draw whose on-chain timestamp was stamped "now" at mint still
 * counts down to its real deadline instead of reading as already closed.
 */
export function msUntilApplicationsClose(
  participation: { deadline: number; deadlineBlock: number },
  nowMs: number,
  currentBlock: number | null,
  blockTimeMs: number,
): number {
  const { deadline, deadlineBlock } = participation
  if (deadlineBlock > 0 && currentBlock !== null && blockTimeMs > 0) {
    return Math.max(0, (deadlineBlock - currentBlock) * blockTimeMs)
  }
  return Math.max(0, deadline - nowMs)
}

export interface LobbyConfigValidationError {
  field: string
  message: string
}

/**
 * Long enough for a real name, short enough to stay one line in the hero.
 *
 * The contract's limit is 48 *bytes* — `bytes(c.name).length` in
 * `ProtocolRules.validateConfig` — so this is a byte budget, not a character
 * count. The two agree only for ASCII. A Cyrillic name costs two bytes per
 * letter and an emoji four, which is why the check below weighs the encoded
 * name rather than counting its characters: anything else greys the button
 * green and lets the transaction revert on chain instead.
 */
export const MAX_LOBBY_NAME_BYTES = 48

/** What the contract will measure: the name's length once UTF-8 encoded. */
export function lobbyNameByteLength(name: string): number {
  return new TextEncoder().encode(name).length
}

export function formatPlayerCount(count: number): string {
  return `${count} ${count === 1 ? 'player' : 'players'}`
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = minutes / 60
  if (hours < 24) return `${Number(hours.toFixed(1))} h`
  return `${Number((hours / 24).toFixed(1))} days`
}

/**
 * The single authority on whether a Defense Operation config is legal
 * (spec §15). It runs in three places on purpose:
 *
 *   1. live, per keystroke, in the Create Defense Operation form;
 *   2. again when the creator presses "Launch Defense";
 *   3. again inside the blockchain layer's `createLobby` write, which is
 *      the only path that can actually mint a lobby.
 *
 * Only (3) is security. A payload edited in DevTools, a modified bundle,
 * or a direct client call all land there, so every protocol boundary is
 * re-checked against `limits` rather than trusted from the caller.
 *
 * `limits` defaults to the protocol config this build was configured with;
 * it is injectable so tests (and, later, a contract-sourced protocol
 * config) can supply their own.
 */
export function validateLobbyConfig(
  config: LobbyConfig,
  nowMs: number,
  limits: ProtocolLimits = defaultProtocolLimits,
): LobbyConfigValidationError[] {
  const errors: LobbyConfigValidationError[] = []
  const { name, participation, economics, drones, attack } = config

  // --- Creator-controlled: valid only inside the protocol's ranges ---------
  // Whitespace is not a name: trimming here is what makes " " illegal, and
  // the same trim is what the creation path stores.
  if (name.trim().length === 0) {
    errors.push({ field: 'name', message: 'Give the operation a name.' })
  } else if (lobbyNameByteLength(name.trim()) > MAX_LOBBY_NAME_BYTES) {
    errors.push({
      field: 'name',
      message: `Operation name is too long — it must fit in ${MAX_LOBBY_NAME_BYTES} bytes (accented and non-Latin letters take more than one).`,
    })
  }
  if (participation.minPlayers < limits.minPlayers) {
    errors.push({
      field: 'participation.minPlayers',
      message: `Minimum allowed by protocol: ${formatPlayerCount(limits.minPlayers)}.`,
    })
  }
  if (participation.minPlayers > limits.maxPlayers) {
    errors.push({
      field: 'participation.minPlayers',
      message: `Maximum allowed by protocol: ${formatPlayerCount(limits.maxPlayers)}.`,
    })
  }
  if (participation.maxPlayers > limits.maxPlayers) {
    errors.push({
      field: 'participation.maxPlayers',
      message: `Maximum allowed by protocol: ${formatPlayerCount(limits.maxPlayers)}.`,
    })
  }
  if (participation.maxPlayers < participation.minPlayers) {
    errors.push({
      field: 'participation.maxPlayers',
      message: 'Max players must be greater than or equal to min players.',
    })
  }
  if (participation.entryPrice < limits.minEntryPrice || participation.entryPrice > limits.maxEntryPrice) {
    errors.push({
      field: 'participation.entryPrice',
      message: `Entry fee must be between ${formatEth(limits.minEntryPrice)} and ${formatEth(limits.maxEntryPrice)}.`,
    })
  }
  /*
   * A deadline that is not a number at all, which every check below would
   * wave through.
   *
   * `NaN` fails no comparison — `NaN <= now` and `NaN - now < min` are both
   * false — so a cleared date picker produced a config this validator
   * declared legal, at all three layers including the one guarding the
   * write. It has to be rejected by kind before it can be compared by value.
   */
  if (!Number.isFinite(participation.deadline)) {
    errors.push({ field: 'participation.deadline', message: 'Set an application deadline.' })
  } else if (participation.deadline <= nowMs) {
    errors.push({ field: 'participation.deadline', message: 'Application deadline must be in the future.' })
  } else if (participation.deadline - nowMs < limits.minRegistrationDurationMs) {
    errors.push({
      field: 'participation.deadline',
      message: `Applications must stay open for at least ${formatDuration(limits.minRegistrationDurationMs)}.`,
    })
  } else if (participation.deadline - nowMs > limits.maxRegistrationDurationMs) {
    errors.push({
      field: 'participation.deadline',
      message: `Applications cannot stay open longer than ${formatDuration(limits.maxRegistrationDurationMs)}.`,
    })
  }
  if (economics.prizePool < limits.minStartPrizePool) {
    errors.push({
      field: 'economics.prizePool',
      message:
        limits.minStartPrizePool > 0
          ? `Minimum allowed by protocol: ${formatEth(limits.minStartPrizePool)}.`
          : 'Start prize pool cannot be negative.',
    })
  }
  if (economics.creatorFeePercent < 0 || economics.creatorFeePercent > limits.maxCreatorFeePercent) {
    errors.push({
      field: 'economics.creatorFeePercent',
      message: `Creator fee must be between 0% and ${limits.maxCreatorFeePercent}%.`,
    })
  }
  /*
   * Recon terms are no longer the creator's to choose (ТЗ §3), so they are
   * checked the way the protocol fee is: as values that must match what the
   * protocol says, rather than as a range a creator picked inside.
   *
   * The epoch's attack is one threat shared by every operation playing it,
   * so what a probe buys is worth the same in all of them. A creator who
   * could price recon would not be pricing their own operation — they would
   * be deciding where everybody buys the epoch's intelligence.
   */
  if (drones.freeCount !== limits.freeReconProbes) {
    errors.push({
      field: 'drones.freeCount',
      message: `Free recon probes are protocol-set: ${limits.freeReconProbes}.`,
    })
  }
  if (drones.maxCount !== limits.maxReconProbes) {
    errors.push({
      field: 'drones.maxCount',
      message: `Recon probes per attack are protocol-set: ${limits.maxReconProbes}.`,
    })
  }
  if (drones.price !== limits.reconProbePrice) {
    errors.push({
      field: 'drones.price',
      message: `Recon probe price is protocol-set: ${formatEth(limits.reconProbePrice)}.`,
    })
  }

  // --- Protocol-controlled: the creator may not set these at all -----------
  // The form never renders them; anything that reaches here with a
  // different value came from outside the UI and is rejected.
  if (economics.protocolJoinFee !== limits.joinFee) {
    errors.push({
      field: 'economics.protocolJoinFee',
      message: 'Protocol join fee is set by the protocol and cannot be changed.',
    })
  }
  if (attack.epochBlocks !== limits.epochBlocks) {
    errors.push({
      field: 'attack.epochBlocks',
      message: 'Epoch length is set by the protocol and cannot be changed.',
    })
  }
  if (attack.sectorSpanKm !== limits.sectorSpanKm) {
    errors.push({
      field: 'attack.sectorSpanKm',
      message: 'Sector scale is set by the protocol and cannot be changed.',
    })
  }
  if (attack.interceptionRadiusSectors !== limits.interceptionRadiusSectors) {
    errors.push({
      field: 'attack.interceptionRadiusSectors',
      message: 'Interception radius is set by the protocol and cannot be changed.',
    })
  }
  if (attack.defenseSpeedKmPerBlock !== limits.defenseSpeedKmPerBlock) {
    errors.push({
      field: 'attack.defenseSpeedKmPerBlock',
      message: 'Interceptor speed is set by the protocol and cannot be changed.',
    })
  }

  return errors
}
