import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOOT_SEQUENCE_MS, startBootSequence } from '../../app/bootSequence'
import { LOGO_TYPE } from '../../motion/timeline'
import { SpaceHero } from '../../components/home/SpaceHero'
import { Header } from '../../components/layout/Header'
import { useUiStore } from '../../stores/uiStore'
import { renderWithProviders } from '../testUtils'

afterEach(() => {
  document.documentElement.removeAttribute('data-boot')
  useUiStore.setState({ isCreateLobbyModalOpen: false })
  vi.useRealTimers()
})

/*
 * The system is read out of its own stylesheet rather than restated here.
 * jsdom loads no CSS, so a test carrying its own copy of the timeline would
 * be checking the copy.
 */
const MOTION_CSS = readFileSync(resolve(process.cwd(), 'frontend/src/app/motion.css'), 'utf8')

/** The `--boot-delay` a step declares in the timeline table. */
function stepDelay(step: string): number {
  const rule = new RegExp(`\\.${step}\\s*{[^}]*--boot-delay:\\s*(\\d+)ms`).exec(MOTION_CSS)
  if (!rule) throw new Error(`No --boot-delay declared for .${step} in motion.css`)
  return Number(rule[1])
}

/** The `--boot-duration` a step declares in the timeline table. */
function stepDuration(step: string): number {
  const rule = new RegExp(`\\.${step}\\s*{[^}]*--boot-duration:\\s*(\\d+)ms`).exec(MOTION_CSS)
  if (!rule) throw new Error(`No --boot-duration declared for .${step} in motion.css`)
  return Number(rule[1])
}

/** When a step is finished — the number ТЗ §2's 1.5–2.0s budget is about. */
function stepEnd(step: string): number {
  return stepDelay(step) + stepDuration(step)
}

/** The keyframes a step's entrance rule actually plays. */
function stepAnimation(selector: string): string {
  const rule = new RegExp(
    `\\[data-boot\\]\\s+\\.${selector}\\s*{[^}]*animation:\\s*([\\w-]+)`,
  ).exec(MOTION_CSS)
  if (!rule) throw new Error(`No [data-boot] animation rule for .${selector} in motion.css`)
  return rule[1]
}

/**
 * ТЗ §32 — the entrance belongs to the document load, and this is the whole
 * of what enforces that.
 *
 * Worth pinning rather than trusting: the obvious way to write a staged
 * entrance is a mount effect in the hero, and that version passes every
 * visual check while quietly replaying the whole sequence on Home -> How to
 * Play -> Home. The tests below are the difference between the two designs.
 */
describe('motion system — when the entrance runs', () => {
  it('arms the entrance for one document load and disarms itself', () => {
    vi.useFakeTimers()
    startBootSequence()

    expect(document.documentElement.hasAttribute('data-boot')).toBe(true)

    // Still live while the last steps (Earth's dawn, the countdown) are in flight...
    vi.advanceTimersByTime(BOOT_SEQUENCE_MS - 1)
    expect(document.documentElement.hasAttribute('data-boot')).toBe(true)

    // ...and gone once it has landed, so nothing can replay afterwards.
    vi.advanceTimersByTime(1)
    expect(document.documentElement.hasAttribute('data-boot')).toBe(false)
  })

  /**
   * A route change re-mounts all of this, and a CSS animation on a mounting
   * element plays again. The only thing between that and a hero that
   * re-introduces itself every time you come back from Docs is that no
   * component arms the entrance — `main.tsx` does, once per document.
   */
  it('is never armed by a component mounting', () => {
    renderWithProviders(
      <>
        <Header />
        <SpaceHero />
      </>,
    )

    expect(document.documentElement.hasAttribute('data-boot')).toBe(false)
  })

  /**
   * The same rule for the JavaScript half. A scramble cannot be scoped to
   * `[data-boot]` by a stylesheet, so it asks `useBootEntrance` instead —
   * and outside a document load it must render its string and nothing else.
   */
  it('does not scramble the title on an ordinary mount', () => {
    renderWithProviders(<SpaceHero />)

    const title = screen.getByRole('heading', { name: 'SOMETHING IS COMING' })
    expect(title.textContent).toBe('SOMETHING IS COMING')
    // No measuring scaffolding and no label shadowing the content: on a
    // route change this is a plain heading.
    expect(title).not.toHaveAttribute('aria-label')
  })

  it('scrambles the title on a document load, without ever telling a screen reader', () => {
    startBootSequence()
    renderWithProviders(<SpaceHero />)

    // The accessible name is the real string from the very first frame,
    // while the visible layer is still noise or empty.
    const title = screen.getByRole('heading', { name: 'SOMETHING IS COMING' })
    expect(title).toHaveAttribute('aria-label', 'SOMETHING IS COMING')
    expect(title.querySelector('[aria-hidden="true"]')).not.toBeNull()
  })
})

describe('motion system — what each element does', () => {
  /**
   * ТЗ §1, §2 — the hero comes up in reading order. The classes say which
   * step each line is; `motion.css` says when each step runs. This checks
   * the two agree, which is the failure a screenshot would not catch: the
   * markup and the timeline live in different files, and nothing else
   * notices when a delay is reordered out from under the copy.
   */
  it('gives every hero block its own step, in reading order', () => {
    const { container } = renderWithProviders(<SpaceHero />)

    const steps = [...container.querySelectorAll('[class*="boot-"]')].flatMap((element) =>
      [...element.classList].filter((name) => name.startsWith('boot-')),
    )

    expect(steps).toEqual([
      'boot-title',
      'boot-subtitle',
      'boot-tagline',
      'boot-cta',
      'boot-docs',
      'boot-seal',
      'boot-seal-state',
    ])

    const delays = steps.map(stepDelay)
    expect(delays).toEqual([...delays].sort((a, b) => a - b))
  })

  /**
   * ТЗ §18, §35 — Earth closes the sequence.
   *
   * Stated as *finishing* last rather than starting last, because it does
   * not start last and should not: it begins fading up at 400ms, under the
   * subtitle and the tagline, and is still arriving while they land. ТЗ §2
   * asks for overlap, and the planet earns the longest run on the page — so
   * the property that matters is which element the eye is still watching
   * when everything else has settled.
   */
  it('leaves Earth still arriving after every other step has landed', () => {
    const others = ['boot-header', 'boot-wallet', 'boot-subtitle', 'boot-cta', 'boot-docs', 'boot-seal', 'boot-seal-state']
    for (const step of others) {
      expect(stepEnd('boot-earth')).toBeGreaterThan(stepEnd(step))
    }
  })

  /** ТЗ §2 — the screen itself arrives inside the 1.5–2.0s budget. */
  it('finishes the initial sequence within its budget', () => {
    expect(stepEnd('boot-earth')).toBeGreaterThanOrEqual(1500)
    expect(stepEnd('boot-earth')).toBeLessThanOrEqual(2000)
  })

  /**
   * The brand signs itself *after* every other block has landed — its own
   * subtitle included.
   *
   * Checked against every row of the timeline rather than against Earth
   * alone, because "last" is the requirement and Earth merely happens to be
   * the current last. The ordering is also split across two files: the
   * wordmark's delay lives in `motion/timeline.ts` and everything it has to
   * follow lives in `motion.css`, so nothing else notices when one of them
   * moves. It opened the sequence at 150ms once; putting it back there
   * would still look fine on its own and would quietly invert what the
   * entrance says.
   */
  it('writes the wordmark only once every other block has landed', () => {
    const steps = [...MOTION_CSS.matchAll(/^\.(boot-[\w-]+)\s*{/gm)].map((match) => match[1])
    expect(steps.length).toBeGreaterThan(10)

    const lastBlockLands = Math.max(...steps.map(stepEnd))
    expect(LOGO_TYPE.delay).toBeGreaterThan(lastBlockLands)
  })

  /**
   * And the rest of the brand corner waits for the wordmark.
   *
   * The subtitle, the protocol shield and the jackpot land together once the
   * last letter has finished cooling, so the corner resolves in one movement
   * instead of three arrivals. The two halves of that are in different files
   * — the letters' timing in `motion/timeline.ts`, these steps in
   * `motion.css` — and nothing else notices when one of them moves.
   *
   * The jackpot is in this list for its *delay* only. It runs a longer
   * animation than the other two on purpose (it strikes like neon and cools,
   * where they fade), and that difference is not this test's business —
   * starting on the same frame is.
   */
  it('signs the brand only once every letter is on screen', () => {
    // When the final letter is *struck* — not when it finishes cooling. The
    // glow takes another `duration` to fade, and the corner deliberately
    // completes during that rather than after it.
    const lastLetterLands = LOGO_TYPE.delay + 6 * LOGO_TYPE.step

    for (const step of ['sign-subtitle', 'sign-shield', 'sign-jackpot']) {
      expect(stepDelay(step)).toBeGreaterThan(lastLetterLands)
    }
    // Together, not one after the other.
    expect(stepDelay('sign-shield')).toBe(stepDelay('sign-subtitle'))
    expect(stepDelay('sign-jackpot')).toBe(stepDelay('sign-shield'))
  })

  /**
   * The brand group is gated by its components rather than by `data-boot`,
   * which is what lets the attribute come off at 2100ms while this lands at
   * ~4.4s. If one of these ever picked up a `[data-boot]` prefix it would
   * silently stop appearing at all — the window would be long gone by the
   * time its delay elapsed.
   */
  it('does not gate the brand signature on the boot attribute', () => {
    expect(MOTION_CSS).not.toMatch(/\[data-boot\][^,{]*\.sign-/)
    expect(BOOT_SEQUENCE_MS).toBeLessThan(stepDelay('sign-subtitle'))
  })

  /**
   * The window has to outlive everything gated on it — removing
   * `data-boot` mid-flight cancels whatever is still running and snaps it
   * to its resting state. The wordmark is deliberately *not* covered: it
   * carries its own animations and runs on past the window by design.
   */
  it('keeps the entrance armed until the last gated step has landed', () => {
    const steps = [...MOTION_CSS.matchAll(/^\.(boot-[\w-]+)\s*{/gm)].map((match) => match[1])
    expect(BOOT_SEQUENCE_MS).toBeGreaterThan(Math.max(...steps.map(stepEnd)))
  })

  /**
   * ТЗ §31 — **the central requirement of the whole task**: no element
   * borrows another's animation. Nine `opacity 0 → 1` fades in a row is one
   * animation played nine times, and it reads as a loading state rather
   * than as a system coming up.
   *
   * Checked against the stylesheet rather than by eye, because this is
   * exactly the rule that erodes: the cheapest way to add a tenth element
   * later is to reuse a preset, and nothing but a test notices.
   */
  it('gives each element a distinct mechanism, not one preset repeated', () => {
    const mechanisms = [
      'boot-header',
      'boot-wallet',
      'boot-subtitle',
      'boot-cta',
      'boot-earth',
      'boot-seal-state',
      'boot-clock',
    ].map(stepAnimation)

    expect(new Set(mechanisms).size).toBe(mechanisms.length)
  })

  /**
   * The two deliberate exceptions, stated so they stay deliberate.
   *
   * The title and the trajectory line share a plain opacity carrier because
   * neither one's motion is the carrier: both are decoded character by
   * character in JavaScript, and the CSS underneath only keeps the first
   * frame of noise from appearing out of nothing.
   */
  it('shares a carrier only where the real motion is the scramble', () => {
    expect(stepAnimation('boot-title')).toBe(stepAnimation('boot-seal'))
  })

  /**
   * Every step must be neutralised for reduced motion — checked
   * structurally, because this is the half of the system nobody looks at.
   *
   * It has already failed once. The tagline's phrase stagger is set by
   * `:nth-child` rules, which outrank a plain class selector, so the
   * reduced-motion block silently did not reach them and the line still
   * arrived in three pieces for someone who had asked for none of it. The
   * fix was to name those selectors at matching specificity; this is what
   * stops the next step from repeating it.
   */
  it('neutralises every entrance step under reduced motion', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) {([\s\S]*)}/.exec(MOTION_CSS)
    expect(reduced).not.toBeNull()

    const animated = [...MOTION_CSS.matchAll(/^(\[data-boot\][^,{]*?)[,{]/gm)].map((match) =>
      match[1].trim(),
    )
    expect(animated.length).toBeGreaterThan(8)

    for (const selector of new Set(animated)) {
      expect(reduced![1]).toContain(selector)
    }
  })

  /**
   * Every animation this file names must actually exist.
   *
   * A `@keyframes` that is not defined is the worst kind of CSS bug: the
   * declaration parses, the browser accepts it, and the animation simply
   * never runs — no error, no warning, and the element sits at its resting
   * state looking exactly like an entrance nobody has written yet.
   *
   * This has already happened once. `@keyframes boot-emerge` was deleted as
   * collateral while a neighbouring rule was being removed, which silently
   * disabled the title's carrier, the trajectory line's carrier, the status
   * icon's fade and every element's reduced-motion fallback at the same
   * time. Nothing failed. Everything just appeared.
   */
  it('defines every keyframe it animates', () => {
    /*
     * Declarations only. The file is more prose than CSS, and a sentence
     * that happens to contain "animation: the sign goes up dark" is not a
     * missing keyframe — it used to fail this test as one.
     */
    const code = MOTION_CSS.replace(/\/\*[\s\S]*?\*\//g, '')
    /* Everything the shorthand carries that is not the keyframes' name. */
    const KEYWORDS = new Set([
      'ease',
      'ease-in',
      'ease-out',
      'ease-in-out',
      'linear',
      'step-start',
      'step-end',
      'normal',
      'reverse',
      'alternate',
      'alternate-reverse',
      'none',
      'forwards',
      'backwards',
      'both',
      'running',
      'paused',
      'infinite',
    ])
    /** The keyframes name out of one `animation` shorthand value. */
    const nameOf = (value: string): string | undefined =>
      value
        .trim()
        .split(/\s+/)
        // Times start with a digit and functions carry a bracket, so the
        // name is the first bare identifier that is not a keyword.
        .find((token) => /^[a-zA-Z][\w-]*$/.test(token) && !KEYWORDS.has(token))

    const used = new Set([
      /*
       * Every name in the list, not just the first: `animation` takes a
       * comma-separated set, and an element that runs two of them (the
       * jackpot is placed and then lit) would otherwise have its second
       * keyframes go unchecked — which is exactly the silent failure this
       * test exists for.
       */
      ...[...code.matchAll(/animation:\s*([^;}]+)/g)].flatMap((m) =>
        m[1]
          .split(',')
          .map(nameOf)
          .filter((name): name is string => Boolean(name)),
      ),
      ...[...code.matchAll(/animation-name:\s*([\w-]+)/g)].map((m) => m[1]),
    ])
    used.delete('none')
    expect(used.size).toBeGreaterThan(8)

    const defined = new Set(
      [...MOTION_CSS.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]),
    )
    expect([...used].filter((name) => !defined.has(name))).toEqual([])
  })

  /**
   * ТЗ §14 — the entrance is decoration and nothing more. The CTA is a live
   * button from the first frame, mid-animation included; nothing here waits
   * for the sequence, because nothing here knows about it.
   */
  it('opens operations from the defenses metric in the status bar', () => {
    renderWithProviders(<Header />)
    const hud = screen.getByLabelText('Global Defense Status')
    const link = within(hud).getByRole('link', { name: /^operations$/i })
    expect(link).toHaveAttribute('href', '/operations')
    expect(screen.getAllByRole('link', { name: /^operations$/i })).toEqual([link])
  })

  it('does not gate the CTA on the animation', async () => {
    startBootSequence()
    renderWithProviders(<SpaceHero />)

    await userEvent.click(screen.getByRole('button', { name: /create operation/i }))

    expect(useUiStore.getState().isCreateLobbyModalOpen).toBe(true)
  })
})
