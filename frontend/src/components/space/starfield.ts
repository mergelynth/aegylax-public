import { createSeededRandom, deriveSeed, randomInRange } from '../../game/randomness'

export interface Star {
  xPercent: number
  yPercent: number
  size: number
  opacity: number
  /** Base star color — mostly cold white/blue-white, rarely a faint blue-violet tint. Never a saturated color (would read as a UI element). */
  color: string
}

/** Unsaturated, high-lightness cold blue / blue-violet — the rare tail of the color distribution. */
const RARE_COLORS = ['#C9D9F5', '#CFE6EE']

function pickColor(rng: () => number): string {
  const roll = rng()
  if (roll < 0.08) return RARE_COLORS[Math.floor(rng() * RARE_COLORS.length)]
  if (roll < 0.35) return '#FFFFFF'
  return '#E8EEFF'
}

/**
 * Deterministic starfield — same `count` + `seed` always produces the same
 * stars, so the background stays stable across re-renders instead of
 * reshuffling. Positions are drawn independently per star (not snapped to
 * a grid), so nothing tiles or repeats visibly. Size and opacity are both
 * skewed toward the low end (squaring a 0-1 roll pulls it toward 0) so
 * most stars are small and faint — bigger, brighter ones are the rare
 * exception, not the norm.
 */
export function buildStarfield(count: number, seed: string): Star[] {
  const rng = createSeededRandom(deriveSeed(['starfield', seed]))
  const stars: Star[] = []

  for (let i = 0; i < count; i++) {
    const sizeBias = rng() ** 2.2
    const opacityBias = rng() ** 1.8

    stars.push({
      xPercent: randomInRange(rng, 0, 100),
      yPercent: randomInRange(rng, 0, 100),
      size: 0.5 + sizeBias * (2.4 - 0.5),
      opacity: 0.15 + opacityBias * (0.85 - 0.15),
      color: pickColor(rng),
    })
  }

  return stars
}
