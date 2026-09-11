import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { Button } from '../../components/common/Button'
import { SpaceHero } from '../../components/home/SpaceHero'
import { fhenixTheme, ProviderThemeContext } from '../../theme'

const MOTION_CSS = readFileSync(resolve(process.cwd(), 'frontend/src/app/motion.css'), 'utf8')
const CIPHER_CSS = readFileSync(
  resolve(process.cwd(), 'frontend/src/components/home/CipherBlocks.module.css'),
  'utf8',
)

/**
 * ТЗ §8-§10 — one interaction system for every button, and the part of it
 * that is behaviour rather than decoration.
 */
describe('<Button /> activity states', () => {
  it('narrates the wait instead of freezing the label', () => {
    const { rerender } = render(<Button busyLabel="Preparing">Launch Defense</Button>)
    expect(screen.getByRole('button')).toHaveTextContent('Launch Defense')

    rerender(
      <Button activity="busy" busyLabel="Confirming">
        Launch Defense
      </Button>,
    )
    expect(screen.getByRole('button')).toHaveTextContent('Confirming')
  })

  /**
   * The reason the loading state exists at all. A button that is working
   * but looks pressable gets pressed again, and the second press is a
   * second transaction.
   */
  it('refuses a second press while busy', async () => {
    const onClick = vi.fn()
    render(
      <Button activity="busy" busyLabel="Preparing" onClick={onClick}>
        Launch Defense
      </Button>,
    )

    const button = screen.getByRole('button')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')

    await userEvent.click(button)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('still runs its action when idle', async () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Launch Defense</Button>)

    await userEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  /**
   * A caller that disables its own button must keep that power — the
   * activity prop adds a reason to be inert, it does not replace one.
   */
  it('does not re-enable a button its caller disabled', () => {
    render(<Button disabled>Launch Defense</Button>)
    expect(screen.getByRole('button')).toBeDisabled()
  })

  /**
   * A click is not a hold. The action must not fire — but the instruction
   * has to stay, because the hold itself is shorter than it takes to read
   * "Hold to launch" and a label that snaps back on pointer-up is a flash.
   */
  it('keeps the hold instruction up after a click that was too short to count', () => {
    vi.useFakeTimers()
    try {
      const onClick = vi.fn()
      render(
        <Button holdMs={400} holdLabel="Hold to launch" onClick={onClick}>
          Launch Operation
        </Button>,
      )
      const button = screen.getByRole('button')

      fireEvent.pointerDown(button, { button: 0 })
      expect(button).toHaveTextContent('Hold to launch')

      fireEvent.pointerUp(button)
      expect(onClick).not.toHaveBeenCalled()
      expect(button).toHaveTextContent('Hold to launch')

      act(() => void vi.advanceTimersByTime(1000))
      expect(button).toHaveTextContent('Hold to launch')
      act(() => void vi.advanceTimersByTime(1000))
      expect(button).toHaveTextContent('Launch Operation')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fires the action once the hold completes, without lingering the instruction', () => {
    vi.useFakeTimers()
    try {
      const onClick = vi.fn()
      render(
        <Button holdMs={400} holdLabel="Hold to launch" onClick={onClick}>
          Launch Operation
        </Button>,
      )
      const button = screen.getByRole('button')

      fireEvent.pointerDown(button, { button: 0 })
      act(() => void vi.advanceTimersByTime(400))
      expect(onClick).toHaveBeenCalledTimes(1)

      fireEvent.pointerUp(button)
      expect(button).toHaveTextContent('Launch Operation')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a progress bar across the button for the whole hold', () => {
    vi.useFakeTimers()
    try {
      render(
        <Button holdMs={2000} holdLabel="Hold to launch" onClick={vi.fn()}>
          Launch Operation
        </Button>,
      )
      const button = screen.getByRole('button')

      expect(button.querySelector('[data-hold-progress]')).toBeNull()
      fireEvent.pointerDown(button, { button: 0 })
      expect(button.querySelector('[data-hold-progress]')).not.toBeNull()

      act(() => void vi.advanceTimersByTime(1500))
      expect(button.querySelector('[data-hold-progress]')).not.toBeNull()

      fireEvent.pointerUp(button)
      expect(button.querySelector('[data-hold-progress]')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * ТЗ §12-§17 — the trajectory line is one status indicator, not three
 * elements that happen to animate.
 */
describe('trajectory idle system', () => {
  /**
   * ТЗ §16 — the signal runs the length of the line, once, in order:
   *
   *     TRAJECTORY  ████ ████ ████  [ ENCRYPTED ]  … Fhenix CoFHE
   *                  ──── signal ────────────────────────▶
   *
   * Each part's place in that wave is a `--wave-step`, and they are set in
   * two different files — the blocks number themselves in `CipherBlocks`,
   * the badge and the credit are numbered by hand in `SpaceHero`. Nothing
   * but this test connects the two.
   *
   * It has already caught one break. The blocks were numbered by array
   * index, and the array holds the whitespace between them as well, so they
   * came out 0, 2, 4 — putting a block on the badge's step and another on
   * the credit's, so the signal arrived twice in two places and skipped a
   * beat in the middle. It still *looked* like an animation, which is why
   * only a test would have found it.
   */
  it('steps the signal along the line exactly once per part', () => {
    const { container } = render(
      <ProviderThemeContext.Provider
        value={{ theme: fhenixTheme, providerCredit: fhenixTheme.assets.providerCredit }}
      >
        <MemoryRouter>
          <SpaceHero />
        </MemoryRouter>
      </ProviderThemeContext.Provider>,
    )

    const steps = [...container.querySelectorAll<HTMLElement>('[style*="--wave-step"]')].map(
      (element) => Number(element.style.getPropertyValue('--wave-step')),
    )

    // Collapsed, because several elements legitimately share a step: the
    // redaction is nine individual blocks so its seams can move (see
    // `CipherBlocks`), and they ride the wave three to a step. What must
    // hold is the *shape* of the sweep — five stations, in order, no gaps
    // and no collisions between the blocks and the two readouts after them.
    const stations = steps.filter((step, index) => step !== steps[index - 1])
    expect(stations).toEqual([0, 1, 2, 3, 4])
  })

  it('runs the blocks and the badge on harmonically related cycles', () => {
    const wave = /\.block\s*{[^}]*animation:\s*cipher-wave\s*([\d.]+)s/.exec(CIPHER_CSS)
    const hold = /\.seal-live\s*{[^}]*animation:\s*seal-hold\s*([\d.]+)s/.exec(MOTION_CSS)
    expect(wave).not.toBeNull()
    expect(hold).not.toBeNull()

    const blocks = Number(wave![1])
    const badge = Number(hold![1])
    // ТЗ §16 asks for a 3–5s badge cycle, and ТЗ §17 for a line that never
    // reads as separate blinking parts — which is what a whole-number
    // ratio buys: the two never drift out of relationship.
    expect(badge).toBeGreaterThanOrEqual(3)
    expect(badge).toBeLessThanOrEqual(5)
    expect(badge % blocks).toBe(0)
  })

  /** ТЗ §19 — it runs forever, so it has to be free. */
  it('drives the loop from CSS on compositor-only properties', () => {
    const keyframes = /@keyframes cipher-wave\s*{([\s\S]*?)}\s*\n\n/.exec(CIPHER_CSS)
    expect(keyframes).not.toBeNull()
    // Anything that changes the size of an inline element in a line of mono
    // text moves the words either side of it, every frame, forever.
    expect(keyframes![1]).not.toMatch(/width|height|margin|padding|font-size/)
    expect(keyframes![1]).toContain('opacity')
  })

  /** ТЗ §20 — and it stops completely for anyone who asked it to. */
  it('stops the permanent loop under reduced motion', () => {
    const reduced = /@media \(prefers-reduced-motion: reduce\) {([\s\S]*)}/.exec(CIPHER_CSS)
    expect(reduced![1]).toContain('.block')
    expect(reduced![1]).toMatch(/animation:\s*none/)

    const reducedMotion = /@media \(prefers-reduced-motion: reduce\) {([\s\S]*)}/.exec(MOTION_CSS)
    expect(reducedMotion![1]).toContain('.seal-live')
  })
})
