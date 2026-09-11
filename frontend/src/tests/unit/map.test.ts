import { describe, expect, it } from 'vitest'
import { buildEmptyActivityMap, isValidSector, labelToSector, sectorToLabel } from '../../game/map'

const grid = { columns: 8, rows: 8 }

describe('sector <-> label conversion (spec §27)', () => {
  it('round-trips column/row through a label', () => {
    expect(sectorToLabel({ column: 1, row: 2 })).toBe('B3')
    expect(labelToSector('B3')).toEqual({ column: 1, row: 2 })
  })

  it('round-trips arbitrary sectors', () => {
    for (const sector of [{ column: 0, row: 0 }, { column: 7, row: 7 }, { column: 4, row: 0 }]) {
      expect(labelToSector(sectorToLabel(sector))).toEqual(sector)
    }
  })

  it('throws on a malformed label', () => {
    expect(() => labelToSector('nonsense')).toThrow()
  })
})

describe('grid bounds', () => {
  it('validates sectors within the configured grid', () => {
    expect(isValidSector({ column: 0, row: 0 }, grid)).toBe(true)
    expect(isValidSector({ column: 7, row: 7 }, grid)).toBe(true)
    expect(isValidSector({ column: 8, row: 0 }, grid)).toBe(false)
    expect(isValidSector({ column: -1, row: 0 }, grid)).toBe(false)
  })

  it('builds an activity map covering every cell exactly once', () => {
    const cells = buildEmptyActivityMap(grid)
    expect(cells).toHaveLength(grid.columns * grid.rows)
    expect(cells.every((cell) => cell.defenseAttemptCount === 0)).toBe(true)
  })
})
