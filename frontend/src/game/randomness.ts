import { keccak256, toHex } from 'viem'
import type { Hash } from './types'

/**
 * Deterministic seed derivation. Never use Math.random() for anything
 * that affects authoritative game outcomes (spec §23, §58) — every
 * random-looking value in this codebase must trace back to a seed built
 * here from block hashes / epoch ids / configured salts.
 */
export function deriveSeed(parts: Array<string | number | bigint>): Hash {
  const packed = parts.map((part) => String(part)).join(':')
  return keccak256(toHex(packed))
}

function seedToUint32(seed: Hash): number {
  const hex = seed.slice(2, 10)
  return Number.parseInt(hex, 16) >>> 0
}

/** mulberry32 — small, fast, deterministic PRNG seeded from a hash. */
export function createSeededRandom(seed: Hash): () => number {
  let state = seedToUint32(seed)
  return function next() {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function randomInRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min)
}

export function randomIntInRange(rng: () => number, min: number, max: number): number {
  return Math.floor(randomInRange(rng, min, max + 1))
}
