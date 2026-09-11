import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SpaceHero, traceOffset } from '../../components/home/SpaceHero'
import { DocsPage } from '../../pages/DocsPage'
import { renderWithProviders } from '../testUtils'

/**
 * The hero's three ways in, and why there are three.
 *
 * It used to offer one action and one explanation, and the action was the
 * most expensive thing in the product: creating an operation costs a start
 * prize pool plus the protocol's creation fee, where joining an existing one
 * costs an entry. The cheaper half of the game was reachable only by
 * clicking a *statistic* in the header — a number, not a way in — so a
 * first-time visitor's only offered move was the one they were least likely
 * to want.
 *
 * This test used to assert the opposite (no browse link in the hero). The
 * assertion is reversed deliberately rather than left to pass on a name that
 * happens not to match.
 */
describe('<SpaceHero /> ways in', () => {
  it('offers creating, joining, the tour and the rules, each at the right route', () => {
    renderWithProviders(<SpaceHero />)
    expect(screen.getByRole('button', { name: /create operation/i })).toBeInTheDocument()

    expect(screen.getByRole('link', { name: /^join operation$/i })).toHaveAttribute(
      'href',
      '/operations',
    )
    /*
     * The guided tour is a plain `href` on purpose, not a router link: it is
     * a second application root with a router of its own (see
     * `guide/GuideApp`), so it has to be entered by loading the document.
     */
    expect(screen.getByRole('link', { name: /^guide$/i })).toHaveAttribute('href', '/guide')
    expect(screen.getByRole('link', { name: /^rules$/i })).toHaveAttribute('href', '/docs')
  })

  /**
   * The row is navigation, and the two things that make it read as
   * navigation rather than as three more buttons are both invisible to a
   * screen reader — so they are pinned here instead of left to a screenshot.
   *
   * The arrow on Join and the signal marks between the links are decoration:
   * a link named "Join Operation →" reads the ornament out loud, and a
   * separator with a name is an extra item in the row.
   */
  it('keeps the row\u2019s instrument out of what a screen reader is told', () => {
    const { container } = renderWithProviders(<SpaceHero />)

    const join = screen.getByRole('link', { name: /^join operation$/i })
    // In the link, and not in its name — which is the whole of the claim.
    const arrow = join.querySelector('[class*="navArrow"]')!
    expect(arrow.textContent).toBe('\u2192')
    expect(arrow).toHaveAttribute('aria-hidden', 'true')

    // A mark between each pair of links, and nothing the accessibility tree
    // has to account for.
    const links = container.querySelectorAll('[class*="secondary"] a')
    const marks = container.querySelectorAll('[class*="navMark"]')
    expect(marks).toHaveLength(links.length - 1)
    for (const mark of marks) expect(mark).toHaveAttribute('aria-hidden', 'true')

    // The first one separates Join from what follows it, which is what makes
    // the row read as a sequence rather than as a heap.
    expect(marks[0].previousElementSibling).toBe(join)
  })
})

const HERO_CSS = readFileSync(
  resolve(process.cwd(), 'frontend/src/components/home/SpaceHero.module.css'),
  'utf8',
)

/**
 * The hero has two loops that never finish — the CTA's wave and the bed
 * under the ways-in row — and an animation that ignores
 * `prefers-reduced-motion` is the quietest failure in the whole system:
 * nothing breaks, no test goes red, and the page simply keeps moving for
 * somebody who asked it not to. So the file is read and checked rather than
 * trusted, the same way `motion.css` is.
 */
describe('the hero\u2019s resting motion, under a reduced-motion preference', () => {
  const reduced = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*)\}/.exec(HERO_CSS)

  it('stops everything this file keeps running', () => {
    expect(reduced).not.toBeNull()

    // Every infinite animation the stylesheet declares, by the selector it
    // is declared on — found rather than listed, so a third one added later
    // is covered by this test on the day it is written.
    const looping = [...HERO_CSS.matchAll(/([.\w:-]+)\s*\{[^}]*animation:[^;}]*infinite/g)].map(
      (match) => match[1],
    )
    expect(looping.length).toBeGreaterThanOrEqual(2)

    for (const selector of looping) {
      expect(reduced![1]).toContain(selector)
    }
    expect(reduced![1]).toMatch(/animation:\s*none/)
  })

  /**
   * The bed is held rather than removed. It is the only thing that says the
   * row is live before a pointer reaches it, and "less motion" is a request
   * about movement, not about being told less.
   */
  it('parks the row\u2019s bed instead of taking it away', () => {
    expect(reduced![1]).toMatch(/\.secondary::before\s*\{[^}]*background-position/)
  })
})

/**
 * The trace under a hovered label follows the pointer, and where it lands is
 * the one part of that a browser cannot tell you is wrong — it will draw a
 * mark half a length off, or one hanging past the end of the word, without
 * complaint.
 */
describe('the ways-in trace, under the pointer', () => {
  // A 120px label with a 53px mark on it: the real proportions.
  const under = (at: number) => traceOffset(at, 120, 53)

  it('centres the mark on the pointer', () => {
    expect(under(60)).toBe(60 - 53 / 2)
    expect(under(40)).toBe(40 - 53 / 2)
  })

  /**
   * Held inside the word at both ends. Without this the mark hangs past the
   * first and last letters — which is the overhang that made it read as an
   * underline rather than as something travelling under the label.
   */
  it('never lets the mark past either end of the word', () => {
    expect(under(0)).toBe(0)
    expect(under(4)).toBe(0)
    expect(under(120)).toBe(120 - 53)
    expect(under(400)).toBe(120 - 53)
  })

  /**
   * A label narrower than its own mark is not hypothetical: the mark is a
   * percentage of a label whose type is `clamp()`ed against the viewport.
   * There is nowhere to put it, and nowhere is 0 — not a negative offset
   * that hangs it off the left of the word.
   */
  it('pins the mark rather than going negative when there is no room', () => {
    expect(traceOffset(10, 40, 60)).toBe(0)
  })
})

/**
 * The page has one job: somebody who has never heard of this should be able
 * to skim it in about thirty seconds and repeat the game in their own
 * words. The tests are about what survives that skim — the promise, the
 * four beats, the way in — and that the words match the rest of the product.
 */
describe('<DocsPage /> onboarding', () => {
  it('opens with the game, in the product’s own words', () => {
    renderWithProviders(<DocsPage />)
    expect(screen.getByText(/^how to play$/i)).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 1, name: /stop the attack\. win the pool\./i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/an unknown attack is approaching earth/i)).toBeInTheDocument()
    expect(screen.getByText(/you can't see its path/i)).toBeInTheDocument()
    expect(
      screen.getByText(/find the attack → choose where \+ when to intercept → hit it first → take the pool/i),
    ).toBeInTheDocument()
  })

  it('never calls the inbound a rocket', () => {
    const { container } = renderWithProviders(<DocsPage />)
    expect(container.textContent).not.toMatch(/rocket/i)
  })

  it('gives the whole game in four beats before any detail', () => {
    renderWithProviders(<DocsPage />)
    expect(screen.getByRole('heading', { name: /the game in 30 seconds/i })).toBeInTheDocument()

    const overview = screen.getByRole('region', { name: /the game in 30 seconds/i })
    const beats = within(overview)
      .getAllByRole('listitem')
      .map((item) => item.textContent)
    expect(beats).toHaveLength(4)
    expect(beats[0]).toMatch(/join/i)
    expect(beats[0]).toMatch(/pay to enter/i)
    expect(beats[1]).toMatch(/get clues/i)
    expect(beats[2]).toMatch(/take your shot/i)
    expect(beats[2]).toMatch(/one shot/i)
    expect(beats[3]).toMatch(/win/i)
    expect(beats[3]).toMatch(/take the pool/i)
    expect(screen.getByText(/that's it/i)).toBeInTheDocument()
  })

  it('explains the four steps as an instruction, with shoot instead of defend', () => {
    renderWithProviders(<DocsPage />)
    expect(screen.getByRole('heading', { name: /how each step works/i })).toBeInTheDocument()

    const steps = screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)
    expect(steps.slice(0, 4)).toEqual(['Join a game', 'Find the attack', 'Take your shot', 'Hit it first'])
    expect(screen.queryByRole('heading', { name: /^defend$/i })).not.toBeInTheDocument()
  })

  it('explains clues as a narrowing search, not as a solved location', () => {
    renderWithProviders(<DocsPage />)
    expect(screen.getByText(/buy clues to narrow down where it can be/i)).toBeInTheDocument()
    expect(screen.getByText(/the more clues you have, the smaller the possible area becomes/i)).toBeInTheDocument()
    expect(screen.getByText(/a recon probe is a clue/i)).toBeInTheDocument()
    expect(screen.getByText(/you never see the attack/i)).toBeInTheDocument()
    expect(screen.getByText(/your job is to use that information to make your best guess/i)).toBeInTheDocument()
  })

  it('states the three win outcomes as consequences, not as a diagram', () => {
    renderWithProviders(<DocsPage />)
    expect(screen.getByText(/they take the whole pool/i)).toBeInTheDocument()
    expect(screen.getByText(/they share the pool/i)).toBeInTheDocument()
    expect(screen.getByText(/the pool rolls into the next round/i)).toBeInTheDocument()
  })

  it('draws nothing and animates nothing', () => {
    const { container } = renderWithProviders(<DocsPage />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('canvas')).toBeNull()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('asks nothing of the reader except the one way in', () => {
    renderWithProviders(<DocsPage />)
    expect(screen.getByRole('button', { name: /create operation/i })).toHaveAttribute('type', 'button')
    expect(screen.queryByRole('button', { name: /simulate|launch|reset/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
  })

  it('puts fairness below the rules, as a property rather than a heading', () => {
    renderWithProviders(<DocsPage />)
    expect(screen.getByRole('heading', { name: /fair by design/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /nobody can cheat/i })).not.toBeInTheDocument()
    expect(screen.getByText(/nobody can see where it will go/i)).toBeInTheDocument()
    expect(screen.queryByText(/^trajectory$/i)).not.toBeInTheDocument()
  })

  it('lets a returning player jump straight into the full rules', () => {
    const { container } = renderWithProviders(<DocsPage />)
    const advanced = container.querySelector('#advanced') as HTMLDetailsElement
    expect(advanced.open).toBe(false)

    fireEvent.click(screen.getByRole('link', { name: /advanced rules/i }))

    expect(advanced.open).toBe(true)
  })

  it('keeps the full rules, collapsed, instead of dropping them', () => {
    const { container } = renderWithProviders(<DocsPage />)
    const advanced = container.querySelector('#advanced') as HTMLDetailsElement
    expect(advanced.open).toBe(false)

    expect(within(advanced).getByRole('heading', { name: /^money$/i })).toBeInTheDocument()
    expect(within(advanced).getByRole('heading', { name: /global defense jackpot/i })).toBeInTheDocument()
    expect(within(advanced).getByRole('heading', { name: /technical details/i })).toBeInTheDocument()
    expect(within(advanced).getByRole('heading', { name: /^day x$/i })).toBeInTheDocument()
    expect(within(advanced).getByText(/joiners are paid back automatically/i)).toBeInTheDocument()
    expect(within(advanced).getByText(/entries are not refunded/i)).toBeInTheDocument()
    expect(within(advanced).getByText(/protocol ceiling/i)).toBeInTheDocument()
    expect(within(advanced).getByText(/a corridor to search, never a point to sit on/i)).toBeInTheDocument()
  })
})
