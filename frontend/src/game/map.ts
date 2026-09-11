import type { ActivityCell, MapGridConfig, Sector } from './types'

/**
 * Sector addressing — the naming layer only.
 *
 * Where a sector *is* now lives in `game/world.ts`, which lays the grid
 * out as square sectors in one isotropic km space. This module keeps the
 * part that is pure bookkeeping: whether an address is on the board, what
 * it is called, and an empty activity map of the right size. Grid
 * resolution is always taken from `MapGridConfig` — never hardcoded.
 */

export function isValidSector(sector: Sector, grid: MapGridConfig): boolean {
  return sector.column >= 0 && sector.column < grid.columns && sector.row >= 0 && sector.row < grid.rows
}

/** e.g. { column: 1, row: 2 } -> "B3" */
export function sectorToLabel(sector: Sector): string {
  const letter = String.fromCharCode(65 + sector.column)
  return `${letter}${sector.row + 1}`
}

export function labelToSector(label: string): Sector {
  const match = /^([A-Za-z]+)(\d+)$/.exec(label.trim())
  if (!match) throw new Error(`Invalid sector label: "${label}"`)
  const [, letters, digits] = match
  const column = letters.toUpperCase().charCodeAt(0) - 65
  const row = Number(digits) - 1
  return { column, row }
}

export function sameSector(a: Sector | null, b: Sector | null): boolean {
  if (!a || !b) return false
  return a.column === b.column && a.row === b.row
}

export function buildEmptyActivityMap(grid: MapGridConfig): ActivityCell[] {
  const cells: ActivityCell[] = []
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) {
      cells.push({ sector: { column, row }, defenseAttemptCount: 0 })
    }
  }
  return cells
}
