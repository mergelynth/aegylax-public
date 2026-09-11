import type { Address, DefensePoint, Hash } from '../../game/types'
import { getStorageItem, setStorageItem } from '../../utils/storage'

/**
 * Secrets this browser is allowed to remember about one wallet.
 *
 * On chain a Defense Point is a handle until the reveal, and a probe
 * answer is delivered once — as a confidential handle on the sending
 * transaction. Neither is re-readable from public state, so a reload that
 * did not keep a local copy showed an empty map and an unlocked Defend
 * control for a round this wallet had already played.
 *
 * Both stores are keyed by attack *and* address: nobody else's point is
 * here, and a reading from one operation must never redraw itself on
 * another.
 */

export interface PendingProbe {
  handle: Hash
  probeIndex: number
  lobbyId: Hash
  attackId: string
  probeId: string
  requestedBy: Address
  txHash: Hash
  generatedAtBlock: number
  /**
   * First block at which the hint may be decrypted.
   *
   * Equal to `generatedAtBlock` against a current deployment: `sendProbe`
   * grants the hint in the transaction that computes it. It is still
   * recorded rather than assumed, because a probe sent against an older
   * engine — or one saved by an older build of this app — is readable a
   * delay later and has to keep waiting.
   */
  readableAtBlock: number
}

export function ownPointKey(attackId: Hash, address: Address): string {
  return `${attackId}:${address.toLowerCase()}`
}

function ownPointStorageKey(attackId: Hash, address: Address): string {
  return `defense:v1:${ownPointKey(attackId, address)}`
}

export function readOwnPoint(attackId: Hash, address: Address): DefensePoint | null {
  return getStorageItem<DefensePoint>(ownPointStorageKey(attackId, address))
}

export function writeOwnPoint(attackId: Hash, address: Address, point: DefensePoint): void {
  setStorageItem(ownPointStorageKey(attackId, address), point)
}

export function pendingProbesKey(lobbyId: Hash, attackId: Hash, address: Address): string {
  return `probe-pending:v1:${lobbyId}:${attackId}:${address.toLowerCase()}`
}

export function readPendingProbes(lobbyId: Hash, attackId: Hash, address: Address): PendingProbe[] {
  return getStorageItem<PendingProbe[]>(pendingProbesKey(lobbyId, attackId, address)) ?? []
}

export function writePendingProbes(
  lobbyId: Hash,
  attackId: Hash,
  address: Address,
  probes: PendingProbe[],
): void {
  if (probes.length === 0) {
    setStorageItem(pendingProbesKey(lobbyId, attackId, address), [])
    return
  }
  setStorageItem(pendingProbesKey(lobbyId, attackId, address), probes)
}

/** Records a handle whose transaction landed but whose answer has not been read yet. */
export function addPendingProbe(probe: PendingProbe): void {
  const current = readPendingProbes(probe.lobbyId, probe.attackId as Hash, probe.requestedBy)
  if (current.some((entry) => entry.handle === probe.handle)) return
  writePendingProbes(probe.lobbyId, probe.attackId as Hash, probe.requestedBy, [...current, probe])
}

export function removePendingProbe(lobbyId: Hash, attackId: Hash, address: Address, handle: Hash): void {
  const remaining = readPendingProbes(lobbyId, attackId, address).filter((entry) => entry.handle !== handle)
  writePendingProbes(lobbyId, attackId, address, remaining)
}

/**
 * Whether this browser has already landed `unlockRound` for the operation.
 *
 * The set in the client dies with the tab, and sending the same unlock
 * again is a no-op on chain that still opens the wallet. Remembering it
 * here makes a reload — or a retry after the fetch between the two reveal
 * transactions failed — skip that prompt and go straight to the scoring
 * half.
 */
function unlockedRoundKey(lobbyId: Hash): string {
  return `unlock:v1:${lobbyId}`
}

export function wasRoundUnlocked(lobbyId: Hash): boolean {
  return getStorageItem<boolean>(unlockedRoundKey(lobbyId)) === true
}

export function rememberUnlockedRound(lobbyId: Hash): void {
  setStorageItem(unlockedRoundKey(lobbyId), true)
}
