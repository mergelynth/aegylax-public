import { describe, expect, it } from 'vitest'
import { knownEngineKinds } from '../../blockchain/contract/confidential'
import globalsCss from '../../app/globals.css?raw'
import {
  DEFAULT_THEME_ID,
  THEMES,
  fhenixTheme,
  incoTheme,
  resolveTheme,
  themeCssVariables,
  themeIdForEngineKind,
  themeIds,
} from '../../theme'

/**
 * The provider theme registry, and the two promises it makes.
 *
 * A theme is chosen by the same string that chooses a gateway — the
 * manifest's engine `kind` — so the failure worth guarding is the two tables
 * drifting apart: a provider the client can decrypt for but has no colours
 * for, or a theme keyed to a kind nothing can ever produce.
 */
describe('the theme registry', () => {
  it('offers Fhenix, Inco and the mock, with Fhenix as the default', () => {
    expect(themeIds()).toEqual(['fhenix', 'inco', 'mock'])
    expect(DEFAULT_THEME_ID).toBe('fhenix')
    expect(THEMES[DEFAULT_THEME_ID]).toBe(fhenixTheme)
  })

  /*
   * The join the whole abstraction rests on. `createGateway` and
   * `resolveTheme` read the same manifest field, and a provider added to one
   * and forgotten in the other is exactly the kind of half-migration this
   * check is cheap enough to prevent.
   */
  it('has a theme for every engine kind the client can build a gateway for', () => {
    for (const kind of knownEngineKinds()) {
      const id = themeIdForEngineKind(kind)
      expect(id, `engine kind "${kind}" has no theme — it would fall through to the default`).not.toBeNull()
      expect(themeIds()).toContain(id)
    }
  })

  it('paints Inco deployments in the Inco theme', () => {
    expect(resolveTheme({ engineKind: 'inco-lightning' })).toBe(incoTheme)
    expect(resolveTheme({ engineKind: 'fhenix-cofhe' })).toBe(fhenixTheme)
  })

  /*
   * Deliberately the opposite rule from `createGateway`, which throws on an
   * unknown kind. A client that cannot decrypt must stop; a page that cannot
   * name a palette must still paint.
   */
  it('falls back to the default rather than throwing on an unknown or absent provider', () => {
    expect(resolveTheme({ engineKind: 'zama-fhevm' })).toBe(fhenixTheme)
    expect(resolveTheme({ engineKind: null })).toBe(fhenixTheme)
    expect(resolveTheme()).toBe(fhenixTheme)
  })

  it('lets ENV override the deployment’s theme, and ignores an override it does not have', () => {
    expect(resolveTheme({ engineKind: 'fhenix-cofhe', override: 'inco' })).toBe(incoTheme)
    expect(resolveTheme({ engineKind: 'fhenix-cofhe', override: ' INCO ' })).toBe(incoTheme)
    expect(resolveTheme({ engineKind: 'inco-lightning', override: 'nonesuch' })).toBe(incoTheme)
  })
})

describe('every theme', () => {
  /*
   * Themes are spread from `baseTheme`, so TypeScript already guarantees the
   * fields exist. What it cannot guarantee is that a provider filled them in
   * with something — and an empty custom property does not fall back to the
   * previous value, it makes the declaration invalid and the element
   * unpainted.
   */
  it('defines every token it advertises', () => {
    for (const id of themeIds()) {
      for (const [name, token] of Object.entries(themeCssVariables(THEMES[id]))) {
        expect(token.trim(), `${id} left ${name} empty`).not.toBe('')
      }
    }
  })

  it('names the provider a player is told about', () => {
    for (const id of themeIds()) {
      expect(THEMES[id].assets.providerName.trim()).not.toBe('')
      expect(THEMES[id].assets.cipherGlyph.trim()).not.toBe('')
    }
  })
})

/**
 * The static default in `globals.css` against the theme that owns it.
 *
 * `globals.css` writes the default theme's values on `:root` so the first
 * paint is right before any JavaScript runs. That is a copy, and a copy of a
 * palette is a thing that goes stale — the symptom being a visible flicker
 * on load as React corrects the page to a palette it disagrees with.
 */
describe('the stylesheet’s default palette', () => {
  const css = globalsCss
  const root = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {')))

  const declared = new Map<string, string>()
  for (const [, name, value] of root.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    declared.set(name, value.trim().replace(/\s+/g, ' '))
  }

  const themed = themeCssVariables(fhenixTheme)

  it.each(Object.keys(themed))('declares %s with the default theme’s value', (name) => {
    expect(declared.get(name)).toBe(themed[name].replace(/\s+/g, ' '))
  })
})
