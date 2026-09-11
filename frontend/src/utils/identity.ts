/**
 * Keeps the object React already has when the newly-read one says the same
 * thing.
 *
 * Every chain read builds its result fresh, so a hook that stores the
 * result directly hands React a new identity on every block — and the
 * Operation screen re-renders the whole playfield, the grid and the
 * reconnaissance heatmap off exactly those objects. Blocks arrive
 * continuously and are usually uneventful, so most of that work is spent
 * re-deriving values that did not move.
 *
 * The comparison is structural and deliberately cheap-and-shallow-minded:
 * these are small, plain, JSON-shaped records (a lobby, a participant list,
 * an attack) read at roughly one hertz, so serialising them costs far less
 * than the render it avoids. It is not a general-purpose deep equal — it
 * inherits `JSON.stringify`'s rules, including key order mattering, which
 * is safe here because both sides are built by the same code path.
 */
export function keepIfUnchanged<T>(current: T, next: T): T {
  if (current === next) return current
  return JSON.stringify(current) === JSON.stringify(next) ? current : next
}
