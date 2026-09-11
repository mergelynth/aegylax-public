import { describe, expect, it } from 'vitest'
import {
  canUnseal,
  derivePlayerSealingKey,
  deriveProtocolSealingKey,
  seal,
  SEALED_BODY_BYTES,
  SealedEnvelopeError,
  unseal,
} from '../../game/sealing'
import type { Address, Hash } from '../../game/types'

const SECRET = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef' as Hash
const OTHER_SECRET = '0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321' as Hash
const PLAYER = '0x00000000000000000000000000000000000000aa' as Address
const OTHER = '0x00000000000000000000000000000000000000bb' as Address

const key = deriveProtocolSealingKey(SECRET)

/** The two shapes ТЗ §5 says must be indistinguishable on the wire. */
const probeAction = { op: 'RECON_PROBE', attackId: 'attack-1', probeId: 'probe-3' }
const defenseAction = {
  op: 'DEFENSE_SUBMIT',
  attackId: 'attack-1',
  defensePoint: { sector: { column: 8, row: 3 }, offsetX: 0.45, offsetY: 0.35 },
}

describe('sealed envelopes (ТЗ §4, §11)', () => {
  it('round-trips a payload under the key it was sealed to', () => {
    expect(unseal(seal(defenseAction, key), key)).toEqual(defenseAction)
  })

  it('says nothing about its payload to anyone without the key', () => {
    const envelope = seal(defenseAction, key)
    const serialized = JSON.stringify(envelope)

    // Neither the operation type nor any coordinate survives into anything
    // an observer can read — which is the whole of ТЗ §4.
    expect(serialized).not.toContain('DEFENSE_SUBMIT')
    expect(serialized).not.toContain('sector')
    expect(serialized).not.toContain('0.45')
    expect(serialized).not.toContain('offsetX')
  })

  it('refuses to open under any other key', () => {
    const envelope = seal(probeAction, key)
    const wrongKey = deriveProtocolSealingKey(OTHER_SECRET)

    expect(canUnseal(envelope, wrongKey)).toBe(false)
    expect(() => unseal(envelope, wrongKey)).toThrow(SealedEnvelopeError)
  })

  it('refuses to open an envelope whose body has been edited', () => {
    const envelope = seal(probeAction, key)
    const tampered = { ...envelope, body: `ff${envelope.body.slice(2)}` }

    // The point of the tag: a modified envelope is rejected rather than
    // quietly decrypted into something else.
    expect(() => unseal(tampered, key)).toThrow(SealedEnvelopeError)
  })

  it('hides the operation type behind a constant ciphertext length (ТЗ §4)', () => {
    const probe = seal(probeAction, key)
    const defense = seal(defenseAction, key)

    // A Recon Probe's payload is markedly shorter than a Defense Submit's,
    // so without the padding the *length* would announce which one this
    // was even though the bytes were encrypted.
    expect(probe.body).toHaveLength(SEALED_BODY_BYTES * 2)
    expect(defense.body).toHaveLength(probe.body.length)
    expect(probe.nonce).toHaveLength(defense.nonce.length)
    expect(probe.tag).toHaveLength(defense.tag.length)
  })

  it('never produces the same ciphertext twice for the same payload', () => {
    const first = seal(probeAction, key)
    const second = seal(probeAction, key)

    // Two identical probes from one wallet must not be linkable by their
    // bodies alone — that is what the per-envelope nonce is for.
    expect(first.nonce).not.toBe(second.nonce)
    expect(first.body).not.toBe(second.body)
    expect(unseal(second, key)).toEqual(probeAction)
  })

  it('seals a private result to one wallet and no other (ТЗ §11)', () => {
    const result = { op: 'RECON_PROBE', bearingDegrees: 212 }
    const envelope = seal(result, derivePlayerSealingKey(PLAYER))

    expect(unseal(envelope, derivePlayerSealingKey(PLAYER))).toEqual(result)
    expect(canUnseal(envelope, derivePlayerSealingKey(OTHER))).toBe(false)
  })

  it('refuses a payload it cannot pad rather than truncating one', () => {
    // Silently dropping the tail of an over-long payload would be far worse
    // than refusing it: the envelope would open, and be wrong.
    expect(() => seal({ filler: 'x'.repeat(SEALED_BODY_BYTES) }, key)).toThrow(SealedEnvelopeError)
  })
})
