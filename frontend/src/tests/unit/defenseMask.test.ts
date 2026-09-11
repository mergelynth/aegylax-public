import { describe, expect, it } from 'vitest'
import { maskDefensePoint, unmaskDefensePoint } from '../../game/defenseMask'

describe('defense mask (mod 2^128)', () => {
  it('unmask inverts mask', () => {
    const point = 0x0123456789abcdefn
    const key = 0xfedcba9876543210n
    expect(unmaskDefensePoint(maskDefensePoint(point, key), key)).toBe(point)
  })

  it('wraps at 128 bits', () => {
    const point = (1n << 128n) - 1n
    const key = 1n
    expect(maskDefensePoint(point, key)).toBe(0n)
    expect(unmaskDefensePoint(0n, key)).toBe(point)
  })
})
