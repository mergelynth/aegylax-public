import type { ProviderTheme } from '../types'
import { baseTheme } from './base'

/**
 * Fhenix CoFHE — the default theme, and the one the demo deployment runs.
 *
 * A tint of the AEGYLAX scene, not a port of Fhenix's website (ТЗ §4, §20).
 * What is borrowed is the part of their visual language that survives on a
 * planetary-defense screen at night: **navy, near-white and one turquoise**.
 * What is *not* borrowed is their light page — the game keeps its dark
 * space, its Earth and its layout, and a player who knew the old build has
 * to recognise it at a glance (ТЗ §21).
 *
 * The move this file makes is a hue rotation, not a redesign. Where the
 * product had a blue→violet ramp, it now has navy holding still and cyan
 * doing the pointing: purple stops being a colour the product owns (ТЗ §13,
 * §20), and every accent on the screen is one hue with the saturation
 * turned up only where the player is meant to look.
 *
 * The deltas below are the whole theme. Everything unstated is `baseTheme`,
 * which is what keeps the difference reviewable.
 */
export const fhenixTheme: ProviderTheme = {
  ...baseTheme,
  id: 'fhenix',
  label: 'Fhenix CoFHE',
  colors: {
    ...baseTheme.colors,
    /*
     * Black with a blue bias rather than a violet one. Fhenix's dark is a
     * navy that has been taken almost all the way down, and starting the
     * scene there is what lets a single cyan accent read as *bright*
     * without being turned up — the contrast is doing the work that glow
     * used to (ТЗ §2: high contrast, thin lines).
     */
    bg: '#03080c',
    // Panels are translucent navy over the space scene, not grey chrome
    // floating on it (ТЗ §9).
    bgPanel: '#06161fe6',
    bgPanelAlt: '#0a2029cc',
    border: '#16323d',
    borderStrong: '#265464',
    // Near-white, faintly cool. The clean impression is mostly this against
    // the near-black above it.
    text: '#eaf3f5',
    textDim: '#7c939c',
    textLabel: '#9db4bc',
    /*
     * The turquoise everything points with: taglines, links, focus rings,
     * active indicators, the CTA. It keeps the exact role the old
     * periwinkle had, so nothing had to move to adopt it — only the hue
     * changed (ТЗ §3: cyan/teal = accent).
     */
    accent: '#43e6e0',
    // The CTA's far stop and the rare second accent. A step lighter, never
    // a second hue — the ramp stays inside turquoise on purpose.
    accentAlt: '#7ef2ec',
    /*
     * The accent with 18% of its saturation removed — hue and lightness
     * held exactly, so it reads as the same colour spoken more quietly
     * rather than as a second teal.
     *
     * This token is what keeps the CTA the brightest thing on the page.
     * Cyan is an accent in Fhenix's own material, not a body colour, and at
     * full strength on a tagline, a status chip and a pill all at once it
     * accents nothing. Everything that is *telling* the player something
     * uses this; only what the player can press keeps `accent`.
     */
    accentMuted: '#52d7d2',
    /*
     * The pale end. This is what an encrypted value is drawn in — cipher
     * blocks, sealed-state labels — because a redaction should read as
     * *withheld*, not as alarming (ТЗ §11).
     */
    accentSoft: '#b9f7f3',
    /*
     * Pulled to the blue side of the accent so technical readouts sit a
     * step behind the things a player can act on. With one hue running the
     * whole product, this separation has to come from temperature.
     */
    accentCool: '#5fb6d8',
    // Navy ink, because this theme's CTA is a cyan surface (see `gradients`).
    ctaText: '#04191f',
    // Semantics keep their hues — a hit is green and a loss is red in every
    // build — but both are cooled a step so they belong to the same palette
    // as the chrome around them (ТЗ §9).
    danger: '#ff5f6e',
    success: '#2fd9a0',
    warning: '#e8a33d',
  },
  /*
   * Paper, for the passages of How to Play that are read rather than played
   * (ТЗ §14). This is the half of the theme that looks like Fhenix's own
   * material: near-white, navy type, one darkened turquoise. Nothing in the
   * game reads it.
   */
  light: {
    ...baseTheme.light,
    bg: '#f4f7f7',
    bgAlt: '#ffffff',
    text: '#061722',
    textDim: '#60707a',
    border: '#d7e0e2',
    // The accent, darkened until it carries text on white. The bright
    // turquoise is a dark-surface colour and disappears on paper.
    accent: '#0b8285',
  },
  gradients: {
    ...baseTheme.gradients,
    /*
     * Two stops a shade apart — a gradient you have to look for (ТЗ §13).
     * The old CTA was an indigo→lavender *ramp*, a piece of decoration in
     * its own right; this is a cyan surface that happens to be lit from one
     * corner, and the ink on it is navy (`colors.ctaText`). That inversion
     * is the single loudest thing this refinement does, and it is what ТЗ
     * §6 asks for: the primary action stops being a purple gradient and
     * becomes the one bright, flat, confident surface on the screen.
     */
    cta: 'linear-gradient(135deg, #43e6e0 0%, #6ff0ea 100%)',
    /*
     * The wordmark is near-white, not white→cyan (ТЗ §8).
     *
     * AEGYLAX is the brand and the shield beside it is the accent mark; a
     * cyan wordmark made the pair one cyan object and left the lockup with
     * no neutral in it. The gradient survives only as a barely-there cool
     * drift across the letterforms — enough that the type is not flat,
     * far short of a colour. Fhenix's own logic exactly: neutral
     * typography, one accent.
     */
    brand: 'linear-gradient(135deg, #f4fafb, #dbeeee)',
    // Navy washes with a cyan bias, well under the threshold where they
    // read as a colour rather than as depth.
    atmosphere: 'radial-gradient(ellipse 80% 50% at 50% -10%, #07303d59, transparent)',
    scene: 'radial-gradient(ellipse 90% 60% at 50% -10%, #08394859, transparent 70%)',
  },
  borders: {
    hairline: '#ffffff14',
    accent: '#43e6e0',
  },
  effects: {
    ...baseTheme.effects,
    // Tight and dim (ТЗ §6: subtle cyan glow, no excessive neon). The
    // button should look lit, not like it is leaking.
    ctaShadow: '0 10px 26px -14px #43e6e07a',
    // Earth's rim, at the edge of visible on purpose. Cyan enough to belong
    // to this theme, faint enough that the planet stays a planet (ТЗ §10).
    planetHalo: '0 0 26px 2px #7fe4f01f',
    panelGlow: '0 10px 28px -12px #00070bd9',
  },
  typography: {
    ...baseTheme.typography,
    // Geometric and deliberate rather than airy — the only typographic move
    // this refinement makes (ТЗ §5).
    headingTracking: '0.015em',
  },
  assets: {
    providerName: 'Fhenix CoFHE',
    providerCredit: 'Confidential execution by Fhenix CoFHE',
    /*
     * Three short bars rather than two long ones (ТЗ §11). Grouped like
     * digits, so the line reads as a *number that has been taken away*
     * rather than as a censor bar — which is the claim the protocol
     * actually makes about a trajectory.
     */
    cipherGlyph: '███ ███ ███',
  },
}
