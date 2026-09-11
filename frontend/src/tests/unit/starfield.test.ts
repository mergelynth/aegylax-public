import { describe, expect, it } from 'vitest'
import { buildStarfield } from '../../components/space/starfield'

describe('buildStarfield', () => {
  it('produces the requested number of stars', () => {
    expect(buildStarfield(150, 'seed-a')).toHaveLength(150)
  })

  it('is deterministic for the same count + seed', () => {
    expect(buildStarfield(80, 'seed-a')).toEqual(buildStarfield(80, 'seed-a'))
  })

  it('varies with the seed', () => {
    const a = buildStarfield(40, 'seed-a')
    const b = buildStarfield(40, 'seed-b')
    expect(a).not.toEqual(b)
  })

  it('keeps every star within the 0-100 percent bounds', () => {
    for (const star of buildStarfield(200, 'seed-a')) {
      expect(star.xPercent).toBeGreaterThanOrEqual(0)
      expect(star.xPercent).toBeLessThanOrEqual(100)
      expect(star.yPercent).toBeGreaterThanOrEqual(0)
      expect(star.yPercent).toBeLessThanOrEqual(100)
      expect(star.size).toBeGreaterThan(0)
      expect(star.opacity).toBeGreaterThan(0)
      expect(star.opacity).toBeLessThanOrEqual(1)
    }
  })
})
