import { keccak256, toHex } from 'viem'
import type { Address, Hash } from './types'

/**
 * Sealed envelopes (ТЗ §4, §11) — the one shape in which anything private
 * travels.
 *
 * The rule the rest of the codebase is built to keep is short: **before the
 * Reveal, nothing that could answer "where" or "what" exists in plaintext
 * anywhere the frontend can reach it**. Not on a transaction, not on an
 * event, not in a public read, and not in the emulator's persisted state.
 * An envelope is what that looks like as a value: a nonce, an opaque body
 * and a tag, and no field a reader could inspect for meaning.
 *
 * Three properties are load-bearing, and each one is a requirement rather
 * than a nicety:
 *
 *   **The body says nothing.** It is the payload XORed with a keccak
 *     keystream, so without the key it is indistinguishable from noise.
 *   **The body is always the same size.** Every envelope is padded to
 *     `SEALED_BODY_BYTES` before encryption. ТЗ §4 asks that an observer
 *     not be able to tell a Recon Probe from a Defense Submit, and a
 *     Recon Probe's payload is markedly shorter than a Defense Submit's —
 *     so without padding the *length* would announce the operation type
 *     that the encryption was there to hide.
 *   **The body cannot be forged or edited.** The tag is a keyed digest
 *     over nonce and body, checked on every open, so a modified envelope
 *     is rejected rather than decrypted into something else.
 *
 * Note: this is symmetric, and in emulator mode both sides of it run
 * in the same tab — so it is a faithful model of the *interface* rather
 * than a security boundary against the person holding the browser. The
 * shapes are what a real deployment keeps: `seal` becomes encryption to the
 * protocol's published key, `unseal` happens contract- or enclave-side, and
 * `PROTOCOL_SEALING_KEY` stops being derivable by anybody but the protocol.
 */

/**
 * Fixed plaintext size, in bytes.
 *
 * One constant for every envelope in the game, not one per kind, and that
 * is the requirement rather than a simplification: requests and results are
 * both public — a request rides on the transaction, a result on the event —
 * so if a Recon Probe's answer were padded to a different size than a
 * Defense Submit's receipt, the *event* would announce which had happened
 * even though the transaction did not.
 *
 * The size is set by the largest payload, which is a probe's answer with
 * its `sectorIds` list: that grows with the sector count, so a much larger
 * grid would need a larger constant. Overflowing it throws rather than
 * truncating — an envelope that silently dropped part of its payload would
 * be far worse than one that refused to be sealed.
 */
export const SEALED_BODY_BYTES = 2048

/** How many bytes at the front of the plaintext hold its length. */
const LENGTH_PREFIX_BYTES = 2

export interface SealedEnvelope {
  /** Fresh per envelope. Two seals of identical payloads look unrelated. */
  nonce: Hash
  /** The payload, padded to `SEALED_BODY_BYTES` and XORed with the keystream. */
  body: string
  /** Keyed digest over `nonce` and `body`; a mismatch means the envelope is not openable. */
  tag: Hash
}

/** A key for sealing and opening. Opaque by construction — never parse one. */
export type SealingKey = Hash

export class SealedEnvelopeError extends Error {}

/**
 * The protocol's own sealing key.
 *
 * Stands in for the published half of an asymmetric protocol key: players
 * seal *to* it and only the protocol opens what they sealed. It is derived
 * from a chain-level secret so that it is stable across reloads without
 * being stored anywhere — a persisted key would end up in the same
 * `localStorage` the sealed state lives in, which would defeat the point of
 * sealing that state at all.
 */
export function deriveProtocolSealingKey(chainSecret: Hash, purpose = 'protocol-actions'): SealingKey {
  return keccak256(toHex(`aegylax-sealing:${chainSecret}:${purpose}`))
}

/**
 * One player's own key — what a private *result* is sealed to (ТЗ §11).
 *
 * A probe's answer belongs to the wallet that paid for it and to nobody
 * else, so the protocol seals it to this rather than emitting it in the
 * clear on an event every client can read. The player's client opens it
 * with the same key, derived from the identity it is already holding, which
 * is what lets a result survive a reload without being written down.
 *
 * TODO (§57): a wallet's encryption key is *its* secret, not a function of
 * its public address, so this particular derivation is exactly as strong as
 * knowing who somebody is. It is the emulator's stand-in for "the protocol
 * seals to the player's registered public key, and only their wallet
 * opens it" — the call shape is what survives into a real deployment.
 */
export function derivePlayerSealingKey(address: Address): SealingKey {
  return keccak256(toHex(`aegylax-sealing:player:${address.toLowerCase()}`))
}

/**
 * Seals a payload. `nonce` is generated here rather than taken as an
 * argument so no caller can accidentally reuse one — a repeated nonce under
 * the same key would let two envelopes be XORed against each other.
 */
export function seal(payload: unknown, key: SealingKey): SealedEnvelope {
  const plaintext = padToBody(new TextEncoder().encode(JSON.stringify(payload)))
  const nonce = randomNonce()
  const body = bytesToHex(xorWithKeystream(plaintext, key, nonce))
  return { nonce, body, tag: authTag(key, nonce, body) }
}

/**
 * Opens an envelope, or throws.
 *
 * The tag is checked before anything is decoded: an envelope that was not
 * sealed with this key is not "an envelope that decodes to nonsense", it is
 * not this key's envelope at all, and the difference matters when the
 * caller is a contract deciding whether to act on it.
 */
export function unseal<T>(envelope: SealedEnvelope, key: SealingKey): T {
  if (authTag(key, envelope.nonce, envelope.body) !== envelope.tag) {
    throw new SealedEnvelopeError('Sealed envelope failed authentication — wrong key or altered payload')
  }
  const plaintext = xorWithKeystream(hexToBytes(envelope.body), key, envelope.nonce)
  const length = (plaintext[0] << 8) | plaintext[1]
  if (length > plaintext.length - LENGTH_PREFIX_BYTES) {
    throw new SealedEnvelopeError('Sealed envelope is malformed')
  }
  const json = new TextDecoder().decode(plaintext.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length))
  return JSON.parse(json) as T
}

/**
 * Whether an envelope opens under a key, without throwing.
 *
 * The protocol uses this rather than a try/catch when it is legitimately
 * asking a question — "is this one of mine?" — instead of handling a
 * failure.
 */
export function canUnseal(envelope: SealedEnvelope, key: SealingKey): boolean {
  return authTag(key, envelope.nonce, envelope.body) === envelope.tag
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Length prefix, payload, then zeros out to the fixed size.
 *
 * Zero padding is safe *because* of the XOR: the keystream is pseudorandom,
 * so the padded region of the ciphertext is pseudorandom too and does not
 * betray where the real payload stopped.
 */
function padToBody(payload: Uint8Array): Uint8Array {
  const capacity = SEALED_BODY_BYTES - LENGTH_PREFIX_BYTES
  if (payload.length > capacity) {
    throw new SealedEnvelopeError(`Payload of ${payload.length} bytes exceeds the ${capacity}-byte sealed body`)
  }
  const padded = new Uint8Array(SEALED_BODY_BYTES)
  padded[0] = (payload.length >> 8) & 0xff
  padded[1] = payload.length & 0xff
  padded.set(payload, LENGTH_PREFIX_BYTES)
  return padded
}

/**
 * keccak in counter mode: block `i` of the keystream is
 * `keccak256(key : nonce : i)`. Symmetric by construction, so the same
 * function both seals and opens.
 */
function xorWithKeystream(input: Uint8Array, key: SealingKey, nonce: Hash): Uint8Array {
  const output = new Uint8Array(input.length)
  for (let offset = 0; offset < input.length; offset += 32) {
    const block = hexToBytes(keccak256(toHex(`${key}:${nonce}:${offset / 32}`)))
    const span = Math.min(32, input.length - offset)
    for (let i = 0; i < span; i++) output[offset + i] = input[offset + i] ^ block[i]
  }
  return output
}

function authTag(key: SealingKey, nonce: Hash, body: string): Hash {
  return keccak256(toHex(`aegylax-seal-tag:${key}:${nonce}:${body}`))
}

/**
 * A fresh nonce. `crypto.getRandomValues` where there is one — a nonce is
 * the single value in this module that must *not* be derivable, so it is
 * the one place a deterministic seed would be a bug rather than a virtue.
 */
function randomNonce(): Hash {
  const bytes = new Uint8Array(16)
  const webcrypto = globalThis.crypto
  if (webcrypto?.getRandomValues) {
    webcrypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return `0x${bytesToHex(bytes)}` as Hash
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return bytes
}
