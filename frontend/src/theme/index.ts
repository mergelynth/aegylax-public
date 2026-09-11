/**
 * The provider theme layer's public surface.
 *
 * Import from here, never from `theme/themes/*` — those exist so a provider
 * can be restyled, or a new one added, without the rest of the app noticing.
 *
 * Almost nothing needs this module. The theme reaches components as CSS
 * custom properties on `:root`, so a stylesheet asking for
 * `var(--color-accent)` is already themed; `useProviderTheme` is only for the
 * few places that need the provider's *content* rather than its colour.
 */
export { ProviderThemeProvider } from './ProviderThemeProvider'
export { splitProviderCredit, type CreditParts } from './credit'
export { useProviderTheme, ProviderThemeContext, PROVIDER_THEME_FALLBACK } from './ThemeContext'
export type { ProviderThemeValue } from './ThemeContext'
export {
  DEFAULT_THEME_ID,
  THEMES,
  fhenixTheme,
  incoTheme,
  mockTheme,
  resolveTheme,
  themeCssVariables,
  themeIdForEngineKind,
  themeIds,
  type ThemeSelection,
} from './registry'
export type {
  ProviderTheme,
  ThemeAssets,
  ThemeBorders,
  ThemeColors,
  ThemeEffects,
  ThemeGradients,
  ThemeTypography,
} from './types'
