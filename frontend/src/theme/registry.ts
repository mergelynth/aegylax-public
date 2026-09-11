import { fhenixTheme } from './themes/fhenix'
import { incoTheme } from './themes/inco'
import { mockTheme } from './themes/mock'
import type { ProviderTheme } from './types'

export { fhenixTheme } from './themes/fhenix'
export { incoTheme } from './themes/inco'
export { mockTheme } from './themes/mock'

/**
 * Every theme this build can wear, by the provider id it belongs to.
 *
 * These ids are the deployment pipeline's provider ids
 * (`tools/chain/confidential.mjs`), not new names — one vocabulary for the
 * confidential provider across the contracts, the deployer, the gateway
 * registry and the paint.
 */
export const THEMES: Record<string, ProviderTheme> = {
  fhenix: fhenixTheme,
  inco: incoTheme,
  mock: mockTheme,
}

/**
 * What a build wears when the deployment does not say otherwise.
 *
 * Fhenix, matching `DEFAULT_PROVIDER` in the deployer: a fresh deployment
 * gets a Fhenix engine, so a fresh build should get the Fhenix theme rather
 * than one that has to be configured into agreement with it.
 */
export const DEFAULT_THEME_ID = 'fhenix'

/**
 * The manifest's engine `kind` — the only thing that crosses from the
 * deployment to the client — mapped to the theme that belongs with it.
 *
 * Kept as its own table rather than parsed out of the kind string. The kinds
 * are the provider's chosen spelling (`fhenix-cofhe`, `inco-lightning`) and
 * a future one need not contain its provider id at all.
 */
const THEME_BY_ENGINE_KIND: Record<string, string> = {
  'fhenix-cofhe': 'fhenix',
  'inco-lightning': 'inco',
  mock: 'mock',
}

/**
 * The theme id a manifest's engine `kind` names, or null when this build has
 * no theme for that provider.
 *
 * `resolveTheme` answers the question the app asks — *what do I paint* — and
 * so can never say "nothing". This answers the question a check asks: whether
 * the kind was recognised at all, or merely defaulted.
 */
export function themeIdForEngineKind(kind: string | null | undefined): string | null {
  return (kind ? THEME_BY_ENGINE_KIND[kind] : undefined) ?? null
}

export interface ThemeSelection {
  /** The manifest's `confidentialEngineKind`, or null on a build with no deployment. */
  engineKind?: string | null
  /**
   * An explicit theme id from ENV, for previewing a provider's look without
   * redeploying against it. Ignored when it names a theme that does not
   * exist — a typo should cost the preview, not the page.
   */
  override?: string | null
}

/**
 * Picks the theme for the provider this build actually talks to.
 *
 * Unknown input falls back to the default rather than throwing, which is the
 * opposite of `createGateway`'s rule for the same string — on purpose. An
 * unrecognised engine kind means the client cannot decrypt anything and must
 * stop; it does not mean the page should be unpainted. So the gateway is
 * strict and the paint is forgiving, and a provider added to one but not the
 * other degrades to the default look instead of a blank screen.
 */
export function resolveTheme({ engineKind = null, override = null }: ThemeSelection = {}): ProviderTheme {
  const requested = override?.trim().toLowerCase()
  if (requested && THEMES[requested]) return THEMES[requested]

  const byKind = engineKind ? THEME_BY_ENGINE_KIND[engineKind] : null
  return (byKind ? THEMES[byKind] : undefined) ?? THEMES[DEFAULT_THEME_ID]
}

/** Theme ids this build can render, for diagnostics and configuration errors. */
export function themeIds(): string[] {
  return Object.keys(THEMES)
}

/**
 * A theme as the CSS custom properties the stylesheets already read.
 *
 * This function is the entire coupling between the theme objects and the
 * app's appearance. Component stylesheets name variables; this names the
 * variables; nothing in between knows which provider is active — which is
 * what ТЗ §13 asks for and what makes adding a provider a data change.
 *
 * The first block are the tokens `globals.css` has always declared, so an
 * override lands on styling that was already written against them. The rest
 * are new roles the refinement introduced.
 */
export function themeCssVariables(theme: ProviderTheme): Record<string, string> {
  const { colors, light, gradients, borders, effects, typography } = theme
  return {
    '--color-bg': colors.bg,
    '--color-bg-panel': colors.bgPanel,
    '--color-bg-panel-alt': colors.bgPanelAlt,
    '--color-border': colors.border,
    '--color-border-strong': colors.borderStrong,
    '--color-text': colors.text,
    '--color-text-dim': colors.textDim,
    '--color-text-label': colors.textLabel,
    '--color-accent': colors.accent,
    '--color-accent-alt': colors.accentAlt,
    '--color-accent-muted': colors.accentMuted,
    '--color-accent-soft': colors.accentSoft,
    '--color-accent-cool': colors.accentCool,
    '--color-cta-text': colors.ctaText,
    '--color-danger': colors.danger,
    '--color-success': colors.success,
    '--color-warning': colors.warning,

    /*
     * The light half (`theme.light`). Present on `:root` alongside the dark
     * tokens rather than behind a media query or a `[data-theme]` switch —
     * nothing *switches* into these. They are the palette a handful of
     * documentation surfaces opt into by name, so they have to be readable
     * from the same place as everything else.
     */
    '--light-bg': light.bg,
    '--light-bg-alt': light.bgAlt,
    '--light-text': light.text,
    '--light-text-dim': light.textDim,
    '--light-border': light.border,
    '--light-accent': light.accent,

    '--gradient-cta': gradients.cta,
    '--gradient-brand': gradients.brand,
    '--gradient-atmosphere': gradients.atmosphere,
    '--gradient-scene': gradients.scene,

    '--border-hairline': borders.hairline,
    '--border-accent': borders.accent,

    '--shadow-cta': effects.ctaShadow,
    '--glow-planet': effects.planetHalo,
    '--glow-panel': effects.panelGlow,

    '--font-sans': typography.sans,
    '--font-mono': typography.mono,
    '--weight-heading': typography.headingWeight,
    '--tracking-heading': typography.headingTracking,
    '--tracking-mono': typography.monoTracking,
  }
}
