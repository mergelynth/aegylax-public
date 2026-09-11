/**
 * What a confidential provider is allowed to restyle.
 *
 * AEGYLAX has one design — a dark planetary-defense scene — and a provider
 * theme is a *tint* of it, not a second design. That is why this type is a
 * fixed set of named roles rather than a free-form style bag: a provider
 * picks the values, never which properties exist, so a new provider cannot
 * grow a component the others do not have and no game component ever needs
 * to know which theme is active.
 *
 * Every field below lands on `:root` as a CSS custom property (see
 * `themeCssVariables`), which is what keeps the switch out of the
 * components: the stylesheets already read these variables, so changing the
 * provider changes the paint and touches no markup.
 */

/**
 * Surface and text colours — the scene the rest of the palette sits on.
 *
 * These are the tokens `globals.css` has always declared, so a theme is
 * overriding an existing contract rather than introducing a parallel one.
 */
export interface ThemeColors {
  /** The page's own black. Every theme's is a *very* dark neutral — this is a tint, not a light mode. */
  bg: string
  /** Panels and popovers, with alpha: they sit over the space scene. */
  bgPanel: string
  bgPanelAlt: string
  border: string
  borderStrong: string
  text: string
  textDim: string
  /** Field names, section titles, stat captions. */
  textLabel: string
  /** Primary interactive colour: focus, active controls, the CTA's left stop. */
  accent: string
  /** The CTA gradient's right stop, and anything that pairs with `accent`. */
  accentAlt: string
  /**
   * The accent where it is *informing* rather than *inviting*.
   *
   * Same hue, a step less saturated. The distinction it encodes is the one
   * thing a single accent colour cannot make on its own: full strength
   * means "you can act here" (the CTA, an active control), muted means
   * "this is accented information" (the hero tagline, a status chip, a
   * readout). Without the split, every accented thing on a screen shouts
   * equally and the CTA stops being the loudest object on the page.
   *
   * Derived one step further down for small chrome — see
   * `--color-accent-quiet` in `globals.css`.
   */
  accentMuted: string
  /**
   * The pale end of the accent ramp — encrypted-state text, cipher blocks,
   * hairline highlights. Light enough to read at 0.7rem over the scene.
   */
  accentSoft: string
  /**
   * A second, cooler accent used sparingly for technical readouts. Not a
   * decorative neon: if it appears twice on a screen, one of them is wrong.
   */
  accentCool: string
  /**
   * Ink on the primary button.
   *
   * Its own token because the CTA is the one surface a theme is allowed to
   * invert. A dark-on-light button is as legitimate a Fhenix CTA as a
   * light-on-dark one (ТЗ §6), and which it is cannot be derived from
   * `text` — that colour is chosen against the *page*, not against the
   * button's fill.
   */
  ctaText: string
  danger: string
  success: string
  warning: string
}

/** Multi-stop fills, kept whole so a theme can change a gradient's *shape*, not only its stops. */
export interface ThemeGradients {
  /** The primary button. The single loudest surface in the product. */
  cta: string
  /** The wordmark's text fill. */
  brand: string
  /** The page-level wash behind everything (`body`). */
  atmosphere: string
  /** The wash inside the space viewport, behind the stars. */
  scene: string
}

export interface ThemeBorders {
  /** Separators inside chrome — dimmer than `colors.border`, used over the scene. */
  hairline: string
  /** An accent-tinted edge for the element currently being addressed. */
  accent: string
}

export interface ThemeEffects {
  /** The CTA's drop shadow. Restraint here is most of what makes the button read as clean. */
  ctaShadow: string
  /** Earth's atmospheric halo in the hero — the provider's colour, at the edge of visible. */
  planetHalo: string
  /** The faint lift under floating chrome (HUD pills, popovers). */
  panelGlow: string
}

export interface ThemeTypography {
  sans: string
  /** Technical readouts only — block numbers, hashes, encrypted-state labels. */
  mono: string
  /** Weight of the hero headline and panel titles. */
  headingWeight: string
  headingTracking: string
  /** Letter spacing for the small uppercase mono labels. */
  monoTracking: string
}

/**
 * The theme's light half — paper, for the few surfaces that are documents.
 *
 * AEGYLAX is a dark product and stays one (ТЗ §4, §20): this is not a light
 * mode and nothing switches into it. It exists because a provider's visual
 * language usually *is* light — Fhenix's own material is near-white with
 * navy type — and How to Play has passages that are read rather than
 * played (ТЗ §14). Those get paper; the game does not.
 *
 * A theme with nothing light to say can leave these near the dark values
 * and no surface will look out of place, because only the handful of
 * opted-in blocks read them.
 */
export interface ThemeLight {
  /** The paper itself. */
  bg: string
  /** A panel *on* the paper — one step down, never a second white. */
  bgAlt: string
  /** Ink. Dark enough to carry body copy at rest. */
  text: string
  /** Secondary ink — captions, the half of a line that explains the other half. */
  textDim: string
  /** Hairlines on paper. Thin and grey; the light surfaces get edges, not shadows. */
  border: string
  /** The accent as it survives on white — usually a darkened step of `colors.accent`. */
  accent: string
}

/**
 * Provider-specific content, kept beside the palette so adding a provider is
 * one file rather than one file plus a table somewhere else.
 */
export interface ThemeAssets {
  /**
   * The provider's name as a player should see it — the label under
   * `providerCredit`, not the manifest's machine `kind`.
   */
  providerName: string
  /**
   * The one-line credit the Home hero carries (ТЗ §17). AEGYLAX stays the
   * brand; this is a footnote, and it is phrased as one.
   */
  providerCredit: string
  /**
   * How this theme draws a value the player is not allowed to see.
   *
   * A string rather than a component so it stays data: the encrypted-state
   * treatment is the clearest place a provider's visual language shows up in
   * gameplay UI, and it has to be settable without touching the map.
   */
  cipherGlyph: string
}

export interface ProviderTheme {
  /**
   * Theme id, equal to the provider id the deployment pipeline uses
   * (`tools/chain/confidential.mjs`). One name for one provider across both
   * halves of the repo — the manifest's `kind` is what joins them.
   */
  id: string
  /** Human label, for diagnostics and the protocol panel. */
  label: string
  colors: ThemeColors
  light: ThemeLight
  gradients: ThemeGradients
  borders: ThemeBorders
  effects: ThemeEffects
  typography: ThemeTypography
  assets: ThemeAssets
}
