import { createContext, useContext } from 'react'
import { resolveTheme } from './registry'
import type { ProviderTheme } from './types'

export interface ProviderThemeValue {
  /** The active theme's tokens and provider-specific content. */
  theme: ProviderTheme
  /**
   * The credit line the UI may show for this deployment's confidential
   * provider (ТЗ §17), or null when there is nothing to credit.
   *
   * Null is not an empty string with extra steps: on the emulator there *is*
   * no confidential layer, and printing "Confidential execution by …" under
   * a build that computes attack geometry in the browser would be the app
   * claiming a property it does not have. The theme still supplies a
   * palette there; only the claim is withheld.
   */
  providerCredit: string | null
}

/**
 * Default for a tree with no `<ProviderThemeProvider>` above it — tests
 * rendering a single component, mostly.
 *
 * It is the default theme with no credit, so a component read in isolation
 * gets real tokens and makes no claim about a provider it was never told
 * about.
 */
export const PROVIDER_THEME_FALLBACK: ProviderThemeValue = {
  theme: resolveTheme(),
  providerCredit: null,
}

export const ProviderThemeContext = createContext<ProviderThemeValue>(PROVIDER_THEME_FALLBACK)

/**
 * The app's only door into provider theming.
 *
 * Components that merely need *colour* should not call this at all — the
 * theme is on `:root` as CSS custom properties and their stylesheets already
 * read it. This is for the handful of places that need the provider's
 * *content*: its name, its credit line, how it draws a redacted value.
 */
export function useProviderTheme(): ProviderThemeValue {
  return useContext(ProviderThemeContext)
}
