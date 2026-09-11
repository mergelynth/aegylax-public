import type {
  AllEventPayloadMap,
  BlockchainClient,
  EventLog,
  GameEventName,
  TransactionRecord,
} from '../blockchain/types'
import type {
  ActivityCell,
  Address,
  Attack,
  AttackEpoch,
  AttackRevealData,
  DefenseAttempt,
  DefensePoint,
  GameStats,
  GlobalDefenseDraw,
  Hash,
  Lobby,
  LobbyConfig,
  Participant,
  ReconProbeRecord,
} from './types'

/**
 * The only bridge between the game domain and the blockchain abstraction
 * (spec §50, §62). Every function here takes a `BlockchainClient` as an
 * explicit argument — nothing imports the emulator or contract client
 * directly — so swapping `VITE_BLOCKCHAIN_MODE` never touches this file.
 */

function extractEvent<TName extends GameEventName>(
  record: TransactionRecord,
  name: TName,
): AllEventPayloadMap[TName] | undefined {
  const match = record.events.find((event): event is EventLog<TName> => event.name === name)
  return match?.payload
}

async function submitAndConfirm(
  client: BlockchainClient,
  submit: () => Promise<TransactionRecord>,
): Promise<TransactionRecord> {
  const submitted = await submit()
  const confirmed = await client.waitForTransaction(submitted.hash)
  if (confirmed.status !== 'confirmed') {
    throw new Error(confirmed.errorMessage ?? `Transaction ${confirmed.hash} did not confirm`)
  }
  return confirmed
}

export async function createLobby(
  client: BlockchainClient,
  from: Address,
  config: LobbyConfig,
): Promise<{ lobby: Lobby; tx: TransactionRecord }> {
  /*
   * ТЗ §17 — the creator pays the bounty *and* the protocol's creation fee.
   *
   * The fee is charged once, at mint, and is never refunded — even if the
   * room never fills. Joiners pay the author, not the protocol.
   *
   * In contract mode this figure is only advisory — `ContractBlockchainClient`
   * re-reads the fee off the chain's live params and pays that, because the
   * contract compares integers and a float round-trip through wei cannot be
   * trusted to land back on the same one.
   */
  const value = config.economics.prizePool + config.economics.protocolJoinFee
  const tx = await submitAndConfirm(client, () => client.writeContract('createLobby', { config, value }, from))
  const event = extractEvent(tx, 'LobbyCreated')
  if (!event) throw new Error('createLobby confirmed without a LobbyCreated event')

  const lobby = await readCreatedLobby(client, event.lobbyId)
  if (!lobby) throw new Error('Lobby not found immediately after creation')
  return { lobby, tx }
}

/** How long the read after a creation keeps insisting the lobby is there. */
const CREATED_LOBBY_ATTEMPTS = 6
const CREATED_LOBBY_DELAY_MS = 500

/**
 * The lobby a confirmed `LobbyCreated` says exists.
 *
 * The transaction confirmed and the chain emitted the event, so an empty
 * answer here is never "no such lobby" — it is a read that reached a node
 * which has not caught up with the write yet. The only correct response to
 * that is to ask again rather than to report a failed creation for a lobby
 * the player has already paid for.
 */
async function readCreatedLobby(client: BlockchainClient, lobbyId: Hash): Promise<Lobby | null> {
  for (let attempt = 0; attempt < CREATED_LOBBY_ATTEMPTS; attempt++) {
    const lobby = await client.readContract('getLobby', { lobbyId })
    if (lobby) return lobby
    await new Promise((resolve) => setTimeout(resolve, CREATED_LOBBY_DELAY_MS))
  }
  return null
}

export async function joinLobby(
  client: BlockchainClient,
  from: Address,
  lobbyId: Hash,
  value: number,
): Promise<{ tx: TransactionRecord }> {
  const tx = await submitAndConfirm(client, () => client.writeContract('joinLobby', { lobbyId, value }, from))
  return { tx }
}

/**
 * Leave Operation (ТЗ §5). The protocol decides whether the seat is still
 * giveable and what comes back; this only names the operation.
 */
export async function leaveLobby(
  client: BlockchainClient,
  from: Address,
  lobbyId: Hash,
): Promise<{ tx: TransactionRecord; refunded: number | null }> {
  const tx = await submitAndConfirm(client, () => client.writeContract('leaveLobby', { lobbyId }, from))
  const event = extractEvent(tx, 'LobbyLeft')
  return { tx, refunded: event?.refunded ?? null }
}

export async function buyDrone(
  client: BlockchainClient,
  from: Address,
  lobbyId: Hash,
  value: number,
): Promise<{ tx: TransactionRecord }> {
  const tx = await submitAndConfirm(client, () => client.writeContract('buyDrone', { lobbyId, value }, from))
  return { tx }
}

/**
 * Send Recon Probe (ТЗ §3). One probe, the whole working area, no target in
 * the request — and the answer comes back readable by the wallet that paid
 * for it and by nobody else.
 *
 * How that privacy is achieved belongs to the blockchain adapter, not here:
 * against the emulator it is a sealed envelope, against the contract it is
 * a confidential handle the player decrypts through Inco. The game domain
 * asks for a probe and receives one answer shape either way.
 */
export function sendReconProbe(
  client: BlockchainClient,
  from: Address,
  params: { lobbyId: Hash; attackId: string; probeId: string; aimDegrees?: number | null },
): Promise<{ tx: TransactionRecord; probe: ReconProbeRecord | null }> {
  return client.sendReconProbe(from, params)
}

/**
 * Send Defense (ТЗ §5). The coordinates never travel as a readable
 * argument; what comes back is the locked attempt plus this player's own
 * point, for their own screen to draw.
 */
export function submitDefenseAttempt(
  client: BlockchainClient,
  from: Address,
  params: { lobbyId: Hash; attackId: string; defensePoint: DefensePoint },
): Promise<{ tx: TransactionRecord; attempt: DefenseAttempt | null; defensePoint: DefensePoint | null }> {
  return client.submitDefense(from, params)
}

/**
 * Claim Reward (ТЗ §17.2). The amount comes back from the chain's own
 * events rather than from anything computed here — the prize from
 * `RewardClaimed`, and the Creator Fee from `CreatorSettled` when the
 * author also won.
 */
export async function claimReward(
  client: BlockchainClient,
  from: Address,
  params: { lobbyId: Hash; attackId: string },
): Promise<{ tx: TransactionRecord; amount: number | null }> {
  const tx = await submitAndConfirm(client, () => client.writeContract('claimReward', params, from))
  const prize = extractEvent(tx, 'RewardClaimed')?.amount ?? 0
  const fee = extractEvent(tx, 'CreatorSettled')?.amount ?? 0
  const amount = prize + fee
  return { tx, amount: amount > 0 ? amount : null }
}

/**
 * Claim Refund (ТЗ §18) — what a cancelled operation owes this wallet:
 * a defender's `paidIn`, and the creator's launch deposit if they are
 * the author. One call covers both, so the author is not left on a
 * second button.
 *
 * The amount comes back off the chain's own `RefundClaimed` event for the
 * same reason `claimReward` reads its own: what the protocol actually paid
 * is the only figure worth showing, and recomputing it here would be a
 * second source of truth that can disagree with the first.
 */
export async function claimRefund(
  client: BlockchainClient,
  from: Address,
  lobbyId: Hash,
): Promise<{ tx: TransactionRecord; amount: number | null }> {
  const tx = await submitAndConfirm(client, () => client.writeContract('claimRefund', { lobbyId }, from))
  const event = extractEvent(tx, 'RefundClaimed')
  return { tx, amount: event?.amount ?? null }
}

/**
 * The creator's settlement (ТЗ §14.6) — the Creator Fee on a round that
 * ran, when the author did not also take the prize through `claimReward`.
 */
export async function settleCreator(
  client: BlockchainClient,
  from: Address,
  lobbyId: Hash,
): Promise<{ tx: TransactionRecord; amount: number | null }> {
  const tx = await submitAndConfirm(client, () => client.writeContract('settleCreator', { lobbyId }, from))
  const event = extractEvent(tx, 'CreatorSettled') ?? extractEvent(tx, 'DefensePoolFunded')
  return { tx, amount: event?.amount ?? null }
}

/**
 * Open the protocol's Global Defense draw (ТЗ §18). Permissionless: the
 * first caller to notice it is due sends this, and everybody else reads the
 * lobby it created.
 */
export async function openGlobalDefense(
  client: BlockchainClient,
  from: Address,
): Promise<{ tx: TransactionRecord; lobbyId: Hash | null; epochId: number | null }> {
  const tx = await submitAndConfirm(client, () => client.writeContract('openGlobalDefense', {}, from))
  const event = extractEvent(tx, 'GlobalDefenseOpened')
  return { tx, lobbyId: event?.lobbyId ?? null, epochId: event?.epochId ?? null }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function getGameStats(client: BlockchainClient): Promise<GameStats> {
  return client.readContract('getGameStats', {})
}

export function getGlobalDefenseDraw(client: BlockchainClient): Promise<GlobalDefenseDraw> {
  return client.readContract('getGlobalDefenseDraw', {})
}

export function getLobby(client: BlockchainClient, lobbyId: Hash): Promise<Lobby | null> {
  return client.readContract('getLobby', { lobbyId })
}

/**
 * The public defender list. `viewer` is what decides whose action
 * breakdown comes back unredacted — your own, and after the reveal,
 * everyone's (ТЗ §4).
 */
export function getLobbyParticipants(
  client: BlockchainClient,
  lobbyId: Hash,
  viewer: Address | null,
): Promise<Participant[]> {
  return client.readContract('getLobbyParticipants', { lobbyId, viewer })
}

export function getParticipant(
  client: BlockchainClient,
  lobbyId: Hash,
  address: Address,
  viewer: Address | null,
): Promise<Participant | null> {
  return client.readContract('getParticipant', { lobbyId, address, viewer })
}

export function getActivityMap(client: BlockchainClient, lobbyId: Hash, attackId: string): Promise<ActivityCell[]> {
  return client.readContract('getActivityMap', { lobbyId, attackId })
}

export function getAttackEpoch(client: BlockchainClient, lobbyId: Hash, epochId: number): Promise<AttackEpoch | null> {
  return client.readContract('getAttackEpoch', { lobbyId, epochId })
}

export function getAttack(client: BlockchainClient, lobbyId: Hash, attackId: string): Promise<Attack | null> {
  return client.readContract('getAttack', { lobbyId, attackId })
}

/**
 * Reveal Attack (ТЗ §4) — the write that opens a finished attack's real
 * geometry into the operation's own state, for every client at once.
 *
 * A write rather than a read because it changes what the protocol will
 * tell people from then on. The first caller pays for it and everyone
 * benefits; a second caller is rejected because there is nothing left to
 * open.
 */
export async function revealAttack(
  client: BlockchainClient,
  from: Address,
  params: { lobbyId: Hash; attackId: string },
): Promise<{ tx: TransactionRecord }> {
  const tx = await submitAndConfirm(client, () => client.writeContract('revealAttack', params, from))
  return { tx }
}

/**
 * The revealed attack (ТЗ §4). Null until somebody has actually revealed
 * it — asking before then is not an error, it simply has no answer, which
 * is why this is a read every client repeats rather than a one-shot.
 */
export function getAttackReveal(
  client: BlockchainClient,
  lobbyId: Hash,
  attackId: string,
): Promise<AttackRevealData | null> {
  return client.readContract('getAttackReveal', { lobbyId, attackId })
}

/**
 * Every Defense Attempt on an attack. Before the reveal none of them carry
 * a plaintext point — `viewer`'s own comes back sealed to `viewer`, and the
 * rest come back closed entirely (ТЗ §7, §11). After the reveal they are
 * all public. The redaction is the chain's, not this function's.
 */
export function getDefenseAttempts(
  client: BlockchainClient,
  lobbyId: Hash,
  attackId: string,
  viewer: Address | null,
): Promise<DefenseAttempt[]> {
  return client.readContract('getDefenseAttempts', { lobbyId, attackId, viewer })
}
