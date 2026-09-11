import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { startBootSequence } from '../../app/bootSequence'
import { CipherTitle } from '../../motion/CipherTitle'
import { RUNE_VIEWBOX } from '../../motion/runes'
import { TITLE_CIPHER, TITLE_SCRAMBLE } from '../../motion/timeline'
import { renderWithProviders } from '../testUtils'

const TITLE = 'SOMETHING IS COMING'

const CIPHER_CSS = readFileSync(resolve(process.cwd(), 'frontend/src/motion/CipherTitle.module.css'), 'utf8')
const OVERLAY_CSS = readFileSync(resolve(process.cwd(), 'frontend/src/motion/InterceptOverlay.module.css'), 'utf8')

afterEach(() => {
  document.documentElement.removeAttribute('data-boot')
  vi.useRealTimers()
})

/** Fake timers drive both halves of this component: rAF and setTimeout. */
function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

function title() {
  return screen.getByRole('heading', { name: TITLE })
}

function renderTitle() {
  return renderWithProviders(
    <CipherTitle
      text={TITLE}
      enabled
      delay={TITLE_SCRAMBLE.delay}
      duration={TITLE_SCRAMBLE.duration}
      hold={TITLE_CIPHER.hold}
      churn={TITLE_CIPHER.churn}
      unlock={TITLE_CIPHER.unlock}
    />,
  )
}

/** When every held character has been released and the fault loop can start. */
const RESOLVED =
  TITLE_SCRAMBLE.delay + TITLE_SCRAMBLE.duration + TITLE_CIPHER.churn + TITLE_CIPHER.hold * TITLE_CIPHER.unlock + 600

describe('hero title — the decode that does not resolve on time', () => {
  /**
   * The point of the whole component: the scramble ends and the line is
   * still not readable. If this ever passes with the full string, the title
   * has quietly gone back to being an ordinary scramble.
   */
  it('is still holding characters sealed long after the scramble has ended', () => {
    vi.useFakeTimers()
    startBootSequence()
    const { container } = renderTitle()

    advance(TITLE_SCRAMBLE.delay + TITLE_SCRAMBLE.duration + 200)

    // Every remaining cell is painting a drawn form, a digit or a letter
    // over a character it is still refusing to give up.
    const sealed = [...container.querySelectorAll('[class*="cipher"]')]
    expect(sealed.length).toBeGreaterThanOrEqual(5)
    for (const glyph of sealed) {
      if (glyph.querySelector('svg')) continue
      expect(glyph.textContent).toMatch(/^[0-9A-Z]$/)
    }
  })

  /**
   * Five or six, scattered. `hold` is an upper bound — the picker refuses
   * adjacent characters — so this checks the band rather than the number,
   * and checks the low end too: a decode that seals one character is not
   * the effect.
   */
  it('seals five or six characters, never two of them adjacent', () => {
    vi.useFakeTimers()
    startBootSequence()
    const { container } = renderTitle()

    advance(TITLE_SCRAMBLE.delay + TITLE_SCRAMBLE.duration + 200)

    const cells = [...container.querySelectorAll('h1 [class*="cell"]')]
    expect(cells.length).toBeGreaterThanOrEqual(5)
    expect(cells.length).toBeLessThanOrEqual(TITLE_CIPHER.hold)

    for (const cell of cells) {
      expect(cell.nextElementSibling?.className ?? '').not.toMatch(/cell/)
    }
  })

  /** The noise never reaches assistive tech, and the resolved line is plain. */
  it('labels the heading while it is noise and drops the scaffolding once it is not', () => {
    vi.useFakeTimers()
    startBootSequence()
    const { container } = renderTitle()

    advance(TITLE_SCRAMBLE.delay + 100)
    expect(title()).toHaveAttribute('aria-label', TITLE)
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull()

    advance(RESOLVED)
    expect(title().textContent).toBe(TITLE)
    expect(title()).not.toHaveAttribute('aria-label')
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull()
  })

  /**
   * The noise vocabulary, checked across the whole run rather than at one
   * moment.
   *
   * It has been wrong twice, both times because it was made of characters.
   * Block elements (`█▓▒░■`) are in none of the fonts in the product's
   * system-sans stack, so the browser went looking for some other font on
   * the machine and what landed in the middle of the heading was either a
   * glyph at foreign metrics or an empty tofu box. The ASCII marks that
   * replaced them were drawable but only roughly the right height, and the
   * ones that were shrunk to fit their box were shrunk on the box itself,
   * which lifted them off the baseline the rest of the line sits on.
   *
   * So the noise is drawn now (`motion/runes`): an inline SVG on the
   * baseline, sized in `cap` units, which is the height of the capitals in
   * whatever font this machine resolved — by construction rather than by
   * approximation.
   */
  it('draws its noise instead of typing it, at the cap height of the line', () => {
    vi.useFakeTimers()
    startBootSequence()
    const { container } = renderTitle()

    advance(TITLE_SCRAMBLE.delay)

    let seen = 0
    let drawn = 0
    // Across the scramble, the churn and the release, so every pool is
    // sampled: the drawn forms early, the digits and letters after.
    for (let step = 0; step < 40; step += 1) {
      for (const glyph of container.querySelectorAll('h1 [class*="glyph"]')) {
        const rune = glyph.querySelector('svg')
        if (rune) {
          drawn += 1
          expect(rune.getAttribute('viewBox')).toBe(RUNE_VIEWBOX)
          expect(rune.querySelector('path')?.getAttribute('d')).toBeTruthy()
          expect(glyph.textContent).toBe('')
        } else {
          expect(glyph.textContent).toMatch(/^[0-9A-Z]$/)
        }
        seen += 1
      }
      advance(100)
    }

    expect(seen).toBeGreaterThan(0)
    // Counted, not merely allowed: a form carries no text of its own, so a
    // render that tested only for a character would paint an empty line for
    // the whole scramble and still satisfy every assertion above.
    expect(drawn).toBeGreaterThan(0)
    expect(CIPHER_CSS).toMatch(/\.rune\s*\{[^}]*height:\s*1cap/)
    expect(CIPHER_CSS).toMatch(/\.rune\s*\{[^}]*vertical-align:\s*baseline/)
    // A stroke is not lit by `text-shadow`, so the sealed slots' accent
    // glow has to reach them as a filter or it does not reach them at all.
    expect(CIPHER_CSS).toMatch(/\.cipher\s+\.rune\s*\{[^}]*drop-shadow/)
  })

  /**
   * The complaint that produced the pool this size: three of the same glyph
   * on the line at once, which no amount of "it is random" makes look
   * random. Independent draws out of six collide constantly, and the sealed
   * slots hold theirs for about 150ms — long enough to read.
   */
  it('never shows the same glyph twice in one frame', () => {
    vi.useFakeTimers()
    startBootSequence()
    const { container } = renderTitle()

    advance(TITLE_SCRAMBLE.delay)

    for (let step = 0; step < 40; step += 1) {
      const painted = [...container.querySelectorAll('h1 [class*="glyph"]')].map(
        (glyph) => glyph.querySelector('path')?.getAttribute('d') ?? glyph.textContent,
      )
      expect(new Set(painted).size).toBe(painted.length)
      advance(100)
    }
  })

  /**
   * Every character owns its width for the whole run. Two and a half
   * seconds of churn happen next to settled text, so a block flipping to a
   * digit must not move the letters around it — which is what the ghost
   * copy inside each unresolved cell is for.
   */
  it("holds every character's box while it churns", () => {
    vi.useFakeTimers()
    startBootSequence()
    const { container } = renderTitle()

    advance(TITLE_SCRAMBLE.delay + TITLE_SCRAMBLE.duration + 400)

    const cells = [...container.querySelectorAll('h1 [class*="cell"]')]
    expect(cells.length).toBeGreaterThan(0)
    for (const cell of cells) {
      const ghost = cell.querySelector('[class*="ghost"]')
      expect(ghost).not.toBeNull()
      // The ghost is the real character, so the box is the real width.
      expect(TITLE).toContain(ghost!.textContent)
    }
  })
})

describe('hero title — the intercept pass that follows', () => {
  /**
   * The beats, and their order (`motion/useInterceptPass`). The first
   * `advance` resolves the line; the second is needed because the pass is
   * scheduled by an effect that only runs once the resolved line renders, so
   * its clock does not exist yet during the advance that resolves it.
   */
  function openPass(container: HTMLElement) {
    advance(RESOLVED)
    advance(1000)
    return () => container.querySelector('h1 [class*="mark"]')!
  }

  /**
   * The heading is on screen as long as the page is, so once it has nothing
   * left to decode it runs the game over its own letters — one character at
   * a time, and never by taking that character out of the heading.
   */
  it('marks exactly one character once the line has resolved, without touching the text', () => {
    vi.useFakeTimers()
    startBootSequence()
    const { container } = renderTitle()

    advance(RESOLVED)
    expect(container.querySelectorAll('h1 > span').length).toBe(0)

    // The pass's own clock starts here, so this test opens it by hand
    // rather than through `openPass` — which resolves the line itself.
    advance(1000)
    const mark = () => container.querySelector('h1 [class*="mark"]')!
    expect(container.querySelectorAll('h1 [class*="mark"]').length).toBe(1)
    expect(mark().textContent).toHaveLength(1)
    expect(TITLE).toContain(mark().textContent)
    /*
     * Labelled while — and only while — a word is lifted out of the string,
     * so name computation cannot read the split as a word boundary and call
     * the heading "SOMETHING IS COMI N G".
     */
    expect(title()).toHaveAttribute('aria-label', TITLE)
  })

  /**
   * The marked character is an `inline-block` for the length of the pass —
   * it is transformed, and the seal is painted over it out of flow — and an
   * inline-block in the middle of a word is a line-break opportunity the
   * rest of the heading does not have. So the whole word goes inside the
   * same no-break wrapper the entrance uses, or a heading sitting near its
   * wrap point would break *inside a word* for four seconds and snap back.
   */
  it('wraps the marked character in its own whole word', () => {
    vi.useFakeTimers()
    startBootSequence()
    const { container } = renderTitle()

    const mark = openPass(container)
    const word = mark().closest('[class*="word"]')
    expect(word).not.toBeNull()
    // The wrapper is exactly one word of the title, not a fragment of one.
    expect(TITLE.split(' ')).toContain(word!.textContent)
  })

  /**
   * Five beats, in the one order that says what the product does: a position
   * found, the value under it sealed, an interceptor in the air, the hit,
   * and the character coming back. Reversed or reordered it would be saying
   * the value leaked, or that a letter flashed for no reason.
   */
  it('runs sweep, lock, strike, burst and cool on the same character, in that order', () => {
    vi.useFakeTimers()
    startBootSequence()
    const { container } = renderTitle()

    const mark = openPass(container)
    const character = mark().textContent
    expect(mark().className).toMatch(/sweep/)

    // The seal: the character itself is gone, held only by a hidden copy of
    // itself that keeps the box the right width.
    advance(1000)
    expect(mark().className).toMatch(/lock/)
    expect(mark().querySelector('[class*="ghost"]')?.textContent).toBe(character)

    // Still sealed while the interceptor is inbound — the value is not out
    // until the hit lands.
    advance(1300)
    expect(mark().className).toMatch(/strike/)
    expect(mark().querySelector('[class*="ghost"]')).not.toBeNull()

    // Impact, on the same character, and the real one is back.
    advance(300)
    expect(mark().className).toMatch(/burst/)
    expect(mark().querySelector('[class*="ghost"]')).toBeNull()
    expect(mark().textContent).toBe(character)

    advance(500)
    expect(mark().className).toMatch(/cool/)

    // And then it is one plain string again, with nothing left behind.
    advance(1500)
    expect(container.querySelectorAll('h1 > span').length).toBe(0)
    expect(title().textContent).toBe(TITLE)
    expect(title()).not.toHaveAttribute('aria-label')
  })

  /**
   * The seal's vocabulary, and the one pool the entrance has that this
   * deliberately does not.
   *
   * There, the whole line is noise and a letter among it reads as a value
   * arriving. Here it is one character in an otherwise settled heading, and
   * a letter swapped for another letter reads as a typo in the headline.
   */
  it('seals the character with the drawn script and digits, never with a letter', () => {
    vi.useFakeTimers()
    startBootSequence()
    const { container } = renderTitle()

    const mark = openPass(container)
    advance(1000)

    let drawn = 0
    let digits = 0
    for (let step = 0; step < 10; step += 1) {
      const glyph = mark().querySelector('[class*="glyph"]')!
      const rune = glyph.querySelector('svg')
      if (rune) {
        drawn += 1
        expect(rune.getAttribute('viewBox')).toBe(RUNE_VIEWBOX)
        expect(glyph.textContent).toBe('')
      } else {
        digits += 1
        expect(glyph.textContent).toMatch(/^[0-9]$/)
      }
      advance(120)
    }

    // Both pools sampled, not merely allowed: the two alternate, so ten
    // flips cannot land on one of them.
    expect(drawn).toBeGreaterThan(0)
    expect(digits).toBeGreaterThan(0)
  })

  /**
   * The complaint this was rewritten for: the same digit, twice and three
   * times, inside one character's seal.
   *
   * It was not bad luck. The two pools alternate, so the form showing when a
   * digit was drawn was always a *rune* — and the old refusal ("never the
   * form already showing") therefore never once applied to a digit. Six or
   * seven independent draws out of ten collide about eighty per cent of the
   * time, which is why it was visible on nearly every pass rather than
   * occasionally.
   *
   * Sampled finely and deduplicated by run, so what is counted is the forms
   * the seal actually *put up*, not how many frames each was held for.
   */
  it('never paints the same digit twice inside one character\u2019s seal', () => {
    vi.useFakeTimers()
    startBootSequence()
    const { container } = renderTitle()

    const mark = openPass(container)
    // Into the seal — the sweep runs first, and there is nothing painted yet.
    advance(1000)

    const digits: string[] = []
    // Sixty samples of 20ms covers the 1.4s lock and stops inside it, so
    // everything collected belongs to one pass.
    for (let step = 0; step < 60; step += 1) {
      const glyph = mark()?.querySelector('[class*="glyph"]')
      const painted = glyph?.textContent ?? ''
      if (/^[0-9]$/.test(painted) && digits[digits.length - 1] !== painted) digits.push(painted)
      advance(20)
    }

    // Enough of them to be a churn rather than one flip that happened to
    // land on a number.
    expect(digits.length).toBeGreaterThan(3)
    expect(new Set(digits).size).toBe(digits.length)
  })

  /**
   * The other half of the same rule, one level up: the pass must not keep
   * going back to the same letter.
   *
   * It used to refuse only the character it had just done, which leaves it
   * free to bounce A, B, A, B — and a heading returning to the same two
   * positions reads as two broken letters rather than as a sweep looking
   * somewhere new. It now refuses the last three.
   */
  it('never returns to a character it has just been on', () => {
    vi.useFakeTimers()
    startBootSequence()
    const { container } = renderTitle()

    advance(RESOLVED)

    /*
     * Where in the heading the mark currently is, counted in characters.
     *
     * Read off the text either side of it rather than off the glyph, because
     * the glyph is not the character for most of a pass — through `lock` and
     * `strike` the mark holds a hidden copy of the letter *and* the sealed
     * form standing over it, so its own `textContent` is not a position.
     */
    const markedIndex = (mark: Element): number => {
      const word = mark.closest('[class*="word"]')!
      const lead = word.previousSibling
      const before = lead && lead.nodeType === Node.TEXT_NODE ? lead.textContent!.length : 0
      const parts = [...word.childNodes]
      return (
        before +
        parts
          .slice(0, parts.indexOf(mark))
          .reduce((count, node) => count + (node.textContent?.length ?? 0), 0)
      )
    }

    // One entry per pass, recorded when the mark appears out of the quiet —
    // deduplicating by value instead would hide the very repeat this is for.
    const visited: number[] = []
    let open = false
    for (let step = 0; step < 800; step += 1) {
      const mark = container.querySelector('h1 [class*="mark"]')
      if (mark && !open) visited.push(markedIndex(mark))
      open = Boolean(mark)
      advance(100)
    }

    expect(visited.length).toBeGreaterThan(4)
    for (const at of visited) expect(TITLE[at]).toMatch(/\S/)
    for (let at = 1; at < visited.length; at += 1) {
      expect(visited.slice(Math.max(0, at - 3), at)).not.toContain(visited[at])
    }
  })

  /**
   * Everything the pass draws *around* the character — the reticle, the
   * interceptor's run, the impact ring — is one absolutely positioned layer
   * that the accessibility tree never sees, and it exists only while a pass
   * is running.
   */
  it('draws its instrument in a layer that is hidden from assistive tech', () => {
    vi.useFakeTimers()
    startBootSequence()
    const { container } = renderTitle()

    openPass(container)
    const layer = container.querySelector('h1 [class*="layer"]')
    expect(layer).not.toBeNull()
    expect(layer).toHaveAttribute('aria-hidden', 'true')
    // The accessible name is still the heading's own text, not the text plus
    // whatever the instrument happens to be painting.
    expect(title()).toBeInTheDocument()

    advance(5000)
    expect(container.querySelector('h1 [class*="layer"]')).toBeNull()
  })

  /**
   * On a route change back to Home there is nothing to decode — the line is
   * plain text from the first frame — but the pass still runs, because it
   * belongs to the page being open rather than to the page having loaded.
   */
  it('runs on an ordinary mount, where there is no entrance at all', () => {
    vi.useFakeTimers()
    const { container } = renderWithProviders(<CipherTitle text={TITLE} enabled={false} />)

    expect(title().textContent).toBe(TITLE)
    expect(container.querySelector('h1 [class*="mark"]')).toBeNull()

    advance(1200)
    expect(container.querySelectorAll('h1 [class*="mark"]').length).toBe(1)
    expect(title()).toHaveAttribute('aria-label', TITLE)
  })

  /**
   * This is the only rule in the product that would keep a character moving
   * indefinitely, so it is stopped in both halves of the system — the hooks
   * ask `prefersReducedMotion`, and the stylesheets refuse anyway.
   */
  it('stops completely for anyone who asked for less motion', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) {([\s\S]*)}/.exec(CIPHER_CSS)
    expect(reduced).not.toBeNull()
    expect(reduced![1]).toMatch(/animation:\s*none/)
    for (const phase of ['.sweep', '.lock', '.strike', '.burst', '.cool']) {
      expect(reduced![1]).toContain(phase)
    }

    // The instrument is a second stylesheet, and it has to refuse as well:
    // the reticle and the ring are Motion's, so nothing in the file above
    // reaches them.
    const overlay = /@media \(prefers-reduced-motion: reduce\) {([\s\S]*)}/.exec(OVERLAY_CSS)
    expect(overlay).not.toBeNull()
    expect(overlay![1]).toMatch(/display:\s*none/)
  })
})
