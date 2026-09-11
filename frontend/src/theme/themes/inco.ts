import type { ProviderTheme } from '../types'
import { baseTheme } from './base'

/**
 * Inco Lightning — the palette AEGYLAX shipped on, kept as its own theme.
 *
 * Deliberately a near-empty delta. Inco is a supported alternative rather
 * than the deployment being demoed, and giving it a speculative restyle now
 * would mean maintaining a second design nobody is looking at. What matters
 * at this stage is that selecting Inco selects *a theme* — that the switch
 * is real and exercised — so the values are the ones the product already
 * had, and the only Inco-specific content is the credit line.
 *
 * Refining this into a distinct Inco identity is a change to this file and
 * nothing else.
 */
export const incoTheme: ProviderTheme = {
  ...baseTheme,
  id: 'inco',
  label: 'Inco Lightning',
  assets: {
    ...baseTheme.assets,
    providerName: 'Inco Lightning',
    providerCredit: 'Confidential execution by Inco Lightning',
    cipherGlyph: '••••••••',
  },
}
