import { derivePlayerSealingKey, unseal, type SealedEnvelope } from './sealing'
import type { Address, DefenseAttempt, DefensePoint, ReconProbeRecord } from './types'

/**
 * What a player actually sends during a round (ТЗ §4, §5).
 *
 * ТЗ §5 is explicit that these are *not* batched: a defender may send three
 * probes and then a Defense, and each one is its own transaction with its
 * own signature and its own moment in the block history. What §4 asks is
 * that none of those transactions say what they are — so every one of them
 * carries the identical outward shape, `submitPrivateAction(lobbyId,
 * envelope)`, and the operation type lives *inside* the envelope with the
 * coordinates.
 *
 * That is why `op` is a field of the sealed payload rather than a contract
 * function name. A chain with `sendReconProbe` and `submitDefense` on its
 * public surface announces which one a player called no matter how well the
 * arguments are encrypted; a chain with one entry point and a fixed-size
 * ciphertext announces only that somebody acted.
 */
export type PrivateActionRequest =
  /**
   * `aimDegrees` is where the player pointed this probe — null for the
   * opening sweep. It rides inside the sealed envelope with everything
   * else, so an observer cannot tell an aimed probe from a sweep, or a
   * probe from a Defense Submit (ТЗ §4).
   */
  | { op: 'RECON_PROBE'; attackId: string; probeId: string; aimDegrees: number | null }
  | { op: 'DEFENSE_SUBMIT'; attackId: string; defensePoint: DefensePoint }

export type PrivateActionOp = PrivateActionRequest['op']

/**
 * What the private computation hands back, sealed to the one wallet that
 * paid for it (ТЗ §11).
 *
 * A Recon Probe's answer is the whole reason the action exists and it is
 * private information: two defenders who each sent two probes hold two
 * different pictures, and neither may read the other's. A Defense Submit's
 * receipt is the player's own coordinate handed back to them so their own
 * screen can draw the point they placed after a reload — which is the only
 * legitimate reason any coordinate travels back at all before Reveal.
 */
export type PrivateActionResult =
  | { op: 'RECON_PROBE'; probe: ReconProbeRecord }
  | { op: 'DEFENSE_SUBMIT'; attempt: DefenseAttempt; defensePoint: DefensePoint }

/** Opens a sealed result addressed to `address`. Throws if it was sealed to somebody else. */
export function openPrivateResult(envelope: SealedEnvelope, address: Address): PrivateActionResult {
  return unseal<PrivateActionResult>(envelope, derivePlayerSealingKey(address))
}

/**
 * This player's own Defense Point, from whichever of the two channels
 * currently carries it.
 *
 * Before the Reveal the protocol will not put a coordinate on an attempt at
 * all, so the owner's own point comes back sealed to them and is opened
 * here. Afterwards the point is public state and arrives in the clear, for
 * every attempt and every reader. Both cases go through one function so no
 * caller has to remember which of the two applies to the phase it is in.
 */
export function openOwnDefensePoint(attempt: DefenseAttempt | null, address: Address | null): DefensePoint | null {
  if (!attempt) return null
  if (attempt.defensePoint) return attempt.defensePoint
  if (!attempt.sealedPoint || !address) return null
  try {
    return unseal<DefensePoint>(attempt.sealedPoint, derivePlayerSealingKey(address))
  } catch {
    // Not this wallet's envelope. Nothing to show, and nothing to report:
    // reading somebody else's attempt and finding it closed is the system
    // working, not an error.
    return null
  }
}
