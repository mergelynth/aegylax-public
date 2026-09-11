/**
 * One-time pad for Defense Points, matching `DefenseMask.sol`.
 *
 * `M = P + K (mod 2^128)`. The chain publishes `M` at submit and `K` after
 * impact; unmasking is this subtraction, in the clear.
 */
const WORD = (1n << 128n) - 1n

export function maskDefensePoint(point: bigint, key: bigint): bigint {
  return (point + key) & WORD
}

export function unmaskDefensePoint(masked: bigint, key: bigint): bigint {
  return (masked - key) & WORD
}
