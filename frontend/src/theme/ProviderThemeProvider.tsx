import { useEffect, useMemo, type ReactNode } from 'react'
import { appConfig } from '../config/env'
import { ProviderThemeContext, type ProviderThemeValue } from './ThemeContext'
import { resolveTheme, themeCssVariables } from './registry'

/**
 * Paints the app in the theme of the confidential provider it talks to.
 *
 * There is no theme *selector*, and that is the design (ТЗ §18). Which
 * confidential stack a build runs on is decided once, at deploy time, by
 * `CONFIDENTIAL_ENGINE`; the manifest records it as the engine `kind`; this
 * reads that kind and paints accordingly. A player never picks a provider,
 * so a player never picks a theme — the two are one fact, and letting them
 * drift apart would let a Fhenix deployment wear Inco's colours and credit
 * the wrong network for the privacy it rests on.
 *
 * The tokens go onto `documentElement` rather than a wrapper element so they
 * reach everything that paints, including the `<body>` background and the
 * portalled dialogs that render outside this subtree.
 */
export function ProviderThemeProvider({ children }: { children: ReactNode }) {
  const value = useMemo<ProviderThemeValue>(() => {
    const theme = resolveTheme({
      engineKind: appConfig.deployment.confidentialEngineKind,
      override: appConfig.providerTheme,
    })

    /*
     * Emulator mode has no confidential layer at all — the geometry is
     * computed locally — so there is no provider to credit however the
     * palette resolved. The mock engine *is* a deployment, and its own
     * credit line says plainly that nothing is confidential, so it is shown.
     */
    const hasConfidentialLayer =
      appConfig.blockchainMode === 'contract' && appConfig.deployment.confidentialEngineKind !== null

    return {
      theme,
      providerCredit: hasConfidentialLayer ? theme.assets.providerCredit || null : null,
    }
  }, [])

  useEffect(() => {
    const root = document.documentElement
    const variables = themeCssVariables(value.theme)
    for (const [name, token] of Object.entries(variables)) {
      root.style.setProperty(name, token)
    }
    /*
     * Also as an attribute, for the rare rule that has to change *shape*
     * rather than colour and cannot be expressed as a token. Nothing uses it
     * yet; it exists so that when something does, the escape hatch is a
     * selector in one stylesheet rather than a provider check in a component.
     */
    root.dataset.providerTheme = value.theme.id

    return () => {
      for (const name of Object.keys(variables)) {
        root.style.removeProperty(name)
      }
      delete root.dataset.providerTheme
    }
  }, [value.theme])

  return <ProviderThemeContext.Provider value={value}>{children}</ProviderThemeContext.Provider>
}
