import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const HUD_CSS = readFileSync(
  resolve(process.cwd(), 'frontend/src/components/stats/GlobalStatsHud.module.css'),
  'utf8',
)

/**
 * The Defenses chip's periodic glitch, and the two properties that decide
 * whether it reads as an effect or as a bug.
 *
 * Both are geometry, and neither can be checked by rendering: jsdom lays
 * nothing out, so a test that mounted the HUD could confirm the burst
 * *happens* and nothing at all about what it looks like. What can be pinned
 * is the shape of the rules that produce it, and that turns out to be the
 * whole of both requirements — they are each a statement about which element
 * a declaration is allowed to land on.
 */
describe('the Defenses chip glitch — a still frame around moving contents', () => {
  /** Every `[data-glitch='true'] …` rule, as selector plus body. */
  const rules = [...HUD_CSS.matchAll(/\[data-glitch='true'\]([^{]*)\{([^}]*)\}/g)].map(
    (match) => ({ target: match[1].trim(), body: match[2] }),
  )

  it('has rules at all, so the two below cannot pass by finding nothing', () => {
    expect(rules.length).toBeGreaterThanOrEqual(3)
  })

  /**
   * The border must not move, stretch or flicker: the effect *is* the
   * contrast between a frame that holds still and contents that do not, and
   * a chip that deformed with them would just look like a broken button.
   *
   * The rule that guarantees it is that no glitch declaration lands on the
   * chip itself — every transform belongs to a child, so the box the border
   * is drawn on is never in the animation. The one thing the chip is allowed
   * is `z-index`, which paints rather than moves.
   */
  it('never animates the chip, only what is inside it', () => {
    for (const rule of rules) {
      if (rule.target === '') {
        // A rule on the chip itself. It may raise the paint order and
        // nothing else — no transform, no animation, no box geometry.
        expect(rule.body).not.toMatch(/transform|animation|width|height|padding|border|scale/)
        expect(rule.body).toMatch(/z-index/)
        continue
      }
      // Everything else addresses a child of the chip.
      expect(rule.target).toMatch(/^\.\w/)
    }
  })

  /**
   * And the contents have to be able to *leave*. The burst throws the count
   * past the right edge and the chevron past the left, which only works
   * because nothing clips them — so the chip must never acquire an
   * `overflow` of its own.
   *
   * This is the kind of line that gets added for an unrelated reason
   * ("round the corners properly", "stop the tooltip poking out") and
   * silently turns the glitch into something rattling inside a box.
   */
  it('leaves the chip unclipped, so the burst can cross the border', () => {
    const chip = /\.metricLink\s*\{([^}]*)\}/.exec(HUD_CSS)
    expect(chip).not.toBeNull()
    expect(chip![1]).not.toMatch(/overflow/)
  })

  /** ТЗ §20 — and all of it stops for anyone who asked for less motion. */
  it('stops completely under a reduced-motion preference', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}/.exec(HUD_CSS)
    expect(reduced).not.toBeNull()
    expect(reduced![1]).toMatch(/\[data-glitch='true'\]/)
    expect(reduced![1]).toMatch(/animation:\s*none/)
  })
})
