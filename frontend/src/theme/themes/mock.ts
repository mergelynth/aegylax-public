import type { ProviderTheme } from '../types'
import { baseTheme } from './base'

/**
 * The mock engine — a build with no confidentiality behind it.
 *
 * The palette is desaturated on purpose, and it is the one place a theme is
 * doing something other than branding: a deployment wired to the mock engine
 * computes attack geometry in the clear, and it should not look like the one
 * that does not. Draining the accent to steel makes that visible from across
 * a room, which is cheaper than trusting whoever is demoing to say it.
 *
 * Its credit line names no provider, because there is none.
 */
export const mockTheme: ProviderTheme = {
  ...baseTheme,
  id: 'mock',
  label: 'Mock engine',
  colors: {
    ...baseTheme.colors,
    bg: '#07080c',
    border: '#232733',
    borderStrong: '#3a4152',
    accent: '#7f8ca3',
    accentAlt: '#9aa6bb',
    accentSoft: '#c3cad6',
    accentCool: '#8fa2ae',
  },
  gradients: {
    ...baseTheme.gradients,
    cta: 'linear-gradient(135deg, #6c7789, #8b95a8)',
    brand: 'linear-gradient(135deg, #e8edf9, #8b95a8)',
    atmosphere: 'radial-gradient(ellipse 80% 50% at 50% -10%, #1d222d55, transparent)',
    scene: 'radial-gradient(ellipse 90% 60% at 50% -10%, #22283366, transparent 70%)',
  },
  effects: {
    ...baseTheme.effects,
    ctaShadow: '0 10px 26px -14px #8b95a855',
    planetHalo: '0 0 20px 2px #c8d0dc12',
  },
  assets: {
    providerName: 'Mock engine',
    providerCredit: 'No confidentiality — mock engine',
    cipherGlyph: '········',
  },
}
