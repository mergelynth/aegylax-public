import { describe, expect, it } from 'vitest'
import { createSeededRandom, deriveSeed, randomIntInRange } from '../../game/randomness'

describe('deterministic randomness', () => {
  it('deriveSeed is a pure function of its inputs', () => {
    expect(deriveSeed(['a', 1, 'b'])).toBe(deriveSeed(['a', 1, 'b']))
    expect(deriveSeed(['a', 1, 'b'])).not.toBe(deriveSeed(['a', 2, 'b']))
  })

  it('createSeededRandom produces the same sequence for the same seed', () => {
    const seed = deriveSeed(['lobby', 'epoch-1'])
    const sequenceA = Array.from({ length: 5 }, () => createSeededRandom(seed))
    const rngA = createSeededRandom(seed)
    const rngB = createSeededRandom(seed)
    const a = Array.from({ length: 5 }, () => rngA())
    const b = Array.from({ length: 5 }, () => rngB())
    expect(a).toEqual(b)
    expect(sequenceA.length).toBe(5)
  })

  it('produces values within [0, 1)', () => {
    const rng = createSeededRandom(deriveSeed(['bounds-check']))
    for (let i = 0; i < 100; i++) {
      const value = rng()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('randomIntInRange stays within bounds', () => {
    const rng = createSeededRandom(deriveSeed(['int-range']))
    for (let i = 0; i < 100; i++) {
      const value = randomIntInRange(rng, 5, 10)
      expect(value).toBeGreaterThanOrEqual(5)
      expect(value).toBeLessThanOrEqual(10)
    }
  })
})
