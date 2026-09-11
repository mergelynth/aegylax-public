import type { ProviderTheme } from '../types'

/**
 * AEGYLAX's own design, as data.
 *
 * This is the palette the product shipped with — dark navy, blue accent,
 * violet second stop — and every provider theme is spread from it. That is
 * deliberate: it makes each theme a readable *delta* (a provider states the
 * handful of values it moves and inherits the rest), and it guarantees a new
 * provider cannot accidentally ship a half-defined palette, because there is
 * no field it can leave undefined.
 *
 * It is not exported as a selectable theme. Nothing runs on `base` — it is
 * the ground the others stand on.
 */
export const baseTheme: ProviderTheme = {
  id: 'base',
  label: 'AEGYLAX',
  colors: {
    bg: '#05070f',
    bgPanel: '#0b0f1ce6',
    bgPanelAlt: '#10152bcc',
    border: '#1e2740',
    borderStrong: '#30416b',
    text: '#e8edf9',
    textDim: '#8993ab',
    textLabel: '#a7b0c8',
    accent: '#4c8dff',
    accentAlt: '#7c5cff',
    accentMuted: '#6f9ee8',
    accentSoft: '#b9cbff',
    accentCool: '#5ed6e8',
    ctaText: '#ffffff',
    danger: '#ff5c72',
    success: '#34d399',
    warning: '#f5a623',
  },
  /*
   * Paper, for the documentation passages that opt into it. Neutral here —
   * the base has no brand of its own to bring to a light surface, so it
   * brings legibility and lets each provider theme supply the character.
   */
  light: {
    bg: '#f4f6fa',
    bgAlt: '#ffffff',
    text: '#0d1526',
    textDim: '#5b6577',
    border: '#d8dfea',
    accent: '#2f5fd0',
  },
  gradients: {
    cta: 'linear-gradient(135deg, #4c8dff, #7c5cff)',
    brand: 'linear-gradient(135deg, #e8edf9, #4c8dff)',
    atmosphere: 'radial-gradient(ellipse 80% 50% at 50% -10%, #16224a55, transparent)',
    scene: 'radial-gradient(ellipse 90% 60% at 50% -10%, #1c2b5c66, transparent 70%)',
  },
  borders: {
    hairline: '#ffffff17',
    accent: '#4c8dff',
  },
  effects: {
    ctaShadow: '0 12px 30px -8px #4c8dff66',
    planetHalo: '0 0 24px 2px #bcd4ff16',
    panelGlow: '0 10px 28px -10px #000000d9',
  },
  typography: {
    sans: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
    mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, 'Roboto Mono', monospace",
    headingWeight: '800',
    headingTracking: '0.02em',
    monoTracking: '0.14em',
  },
  assets: {
    providerName: 'AEGYLAX',
    providerCredit: '',
    cipherGlyph: '••••••••',
  },
}
