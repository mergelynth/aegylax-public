import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SpaceHero } from '../../components/home/SpaceHero'
import { fhenixTheme, incoTheme, ProviderThemeContext, useProviderTheme } from '../../theme'
import { renderWithProviders } from '../testUtils'
import { MemoryRouter } from 'react-router-dom'

/**
 * What the theme layer is *for*: game components read tokens and content,
 * never a provider name, so switching provider switches the look without
 * touching them (ТЗ §12-13).
 */
function ThemeProbe() {
  const { theme, providerCredit } = useProviderTheme()
  return (
    <>
      <span data-testid="id">{theme.id}</span>
      <span data-testid="accent">{theme.colors.accent}</span>
      <span data-testid="credit">{providerCredit ?? '(none)'}</span>
    </>
  )
}

describe('the provider theme in a component tree', () => {
  it('hands a component the active theme without it naming a provider', () => {
    render(
      <ProviderThemeContext.Provider value={{ theme: incoTheme, providerCredit: 'Confidential execution by Inco Lightning' }}>
        <ThemeProbe />
      </ProviderThemeContext.Provider>,
    )

    expect(screen.getByTestId('id')).toHaveTextContent('inco')
    expect(screen.getByTestId('accent')).toHaveTextContent(incoTheme.colors.accent)
  })

  /*
   * A component read outside the provider still gets real tokens rather than
   * undefined — but it credits nobody, because nothing told it there was a
   * confidential layer to credit.
   */
  it('falls back to the default theme, and to no credit, with no provider above it', () => {
    render(<ThemeProbe />)

    expect(screen.getByTestId('id')).toHaveTextContent(fhenixTheme.id)
    expect(screen.getByTestId('credit')).toHaveTextContent('(none)')
  })
})

describe('the Home hero', () => {
  it('shows the trajectory as a redacted value, drawn the way the theme draws one', () => {
    render(
      <ProviderThemeContext.Provider value={{ theme: fhenixTheme, providerCredit: null }}>
        <MemoryRouter>
          <SpaceHero />
        </MemoryRouter>
      </ProviderThemeContext.Provider>,
    )

    // The cipher block is decoration; "encrypted" is what a screen reader
    // gets, and it is the claim the line actually makes.
    //
    // Matched across elements, and with the theme's spaces removed: every
    // block is its own element so a signal can travel along them and the
    // seams between them can move (ТЗ §12-§16, `CipherBlocks`), and the
    // gaps are drawn as margins rather than as space characters because a
    // space cannot animate. What has to hold is that the theme's redaction
    // glyphs are what the line is made of — not how many spans it took, and
    // not whether the whitespace survived as text.
    const glyph = fhenixTheme.assets.cipherGlyph.replace(/\s+/g, '')
    expect(
      screen.getAllByText((_, element) => element?.textContent === glyph, { selector: 'span' }),
    ).not.toHaveLength(0)
    expect(screen.getByText('encrypted')).toBeInTheDocument()
  })

  it('credits the provider when the deployment has one', () => {
    render(
      <ProviderThemeContext.Provider
        value={{ theme: fhenixTheme, providerCredit: fhenixTheme.assets.providerCredit }}
      >
        <MemoryRouter>
          <SpaceHero />
        </MemoryRouter>
      </ProviderThemeContext.Provider>,
    )

    /*
      The credit is one sentence to a reader and two spans to the DOM — the
      provider's name is weighted differently from the claim around it. So
      this asserts the name is separately findable *and* that the line it
      sits in still reads as the whole sentence, which is what a screen
      reader announces and what the page actually promises.
    */
    const name = screen.getByText('Fhenix CoFHE')
    expect(name.parentElement).toHaveTextContent('Confidential execution by Fhenix CoFHE')
  })

  /*
   * The suite runs in emulator mode, where attack geometry is computed in
   * the browser. Printing "Confidential execution by …" there would be the
   * app claiming a property it does not have, so the real provider — not a
   * hand-built context — is what this asserts against.
   */
  it('credits nobody on a build with no confidential layer behind it', () => {
    renderWithProviders(<SpaceHero />)

    expect(screen.getByText('encrypted')).toBeInTheDocument()
    expect(screen.queryByText('Fhenix CoFHE')).not.toBeInTheDocument()
    expect(document.body).not.toHaveTextContent(/Confidential execution by/)
  })
})
