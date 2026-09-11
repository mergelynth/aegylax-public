import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useCipherReveal, type CipherCell } from './useCipherReveal'
import { InterceptOverlay, type InterceptFrame } from './InterceptOverlay'
import type { NoiseGlyph } from './noiseGlyphs'
import { RUNE_VIEWBOX } from './runes'
import { useInterceptPass } from './useInterceptPass'
import styles from './CipherTitle.module.css'

export interface CipherTitleProps {
  /** The real string. This is what a screen reader gets, always. */
  text: string
  /** Whether this mount is a document load (`useBootEntrance`). */
  enabled: boolean
  /** Phase one: the scramble's delay and how long it runs. */
  delay?: number
  duration?: number
  /** Phase two and three: how many characters stay sealed, and for how long. */
  hold?: number
  churn?: number
  unlock?: number
  className?: string
  style?: CSSProperties
}

/**
 * ТЗ §9 — the headline, and the only element on the page that is still
 * moving a minute after the load.
 *
 * It has two lives, and they are two different components' worth of
 * behaviour joined at one moment. `useCipherReveal` runs the entrance: the
 * decode, the handful of characters held back as churning slots, and their
 * one-by-one release. The frame that finishes hands over to
 * `useInterceptPass`, which from then on runs the *game* over the heading's
 * own letters — a reticle closes on one character, the character seals and
 * churns behind it, an interceptor crosses the line, and the character comes
 * back on impact and cools. Then a couple of seconds of quiet and another
 * character, for as long as the page is open. Nothing else in the product
 * does either of those things, which is ТЗ §31: no element borrows another's
 * animation.
 *
 * Three rendering rules carry the whole thing:
 *
 * **Every character owns its width.** While the line is resolving, each
 * character is a box sized by an invisible copy of its real glyph, with the
 * noise painted over that box and taking no space. This is stricter than
 * the seal's `ScrambleText`, which measures the string as a whole and lets
 * each frame breathe a little around its final position — fine for a word
 * that resolves in 400ms, wrong here, because for two and a half seconds
 * most of this line is *settled text* and a block flipping to a digit two
 * words away must not move it. The noise itself is drawn rather than
 * typed, at exactly the cap height of the letters it stands among — see
 * `motion/runes` for why a character could not be promised either. The pass
 * that follows reuses the same box for the one character it seals.
 *
 * **The settled line is a plain string again.** Between passes there is no
 * scaffolding, no per-character markup and no label shadowing the content —
 * the heading is its own text, and that is what a route change back to Home
 * renders directly. A pass lifts out exactly one word (see below) and puts
 * it back when it is done.
 *
 * **The instrument is drawn beside the text, never in it.** Everything the
 * pass draws *around* the character — the reticle, the interceptor's run,
 * the impact ring — lives in one absolutely positioned, `aria-hidden` layer
 * (`motion/InterceptOverlay`) measured from the character's own box. So the
 * effect can be as loud as it likes without a single pixel of the heading
 * moving, and the whole of it disappears from the accessibility tree.
 */
export function CipherTitle({
  text,
  enabled,
  delay,
  duration,
  hold,
  churn,
  unlock,
  className,
  style,
}: CipherTitleProps) {
  const cells = useCipherReveal({ text, enabled, delay, duration, hold, churn, unlock })
  const settled = cells === null
  const pass = useInterceptPass({ text, active: settled })

  const hostRef = useRef<HTMLHeadingElement>(null)
  const markRef = useRef<HTMLSpanElement>(null)
  const [frame, setFrame] = useState<InterceptFrame | null>(null)

  /*
   * Where the character under the pass actually is.
   *
   * Measured rather than derived, and re-measured on every beat, because
   * there is nothing to derive it from: the heading is centred, it is set at
   * a `clamp()`ed size in whatever font the machine resolved, and it wraps.
   * A layout effect rather than an ordinary one so the measurement and the
   * render that uses it are committed in the same frame — an effect that ran
   * after paint would put the reticle on the previous character for a frame
   * every time the pass moved.
   */
  useLayoutEffect(() => {
    const host = hostRef.current
    const mark = markRef.current
    if (!host || !mark) {
      setFrame(null)
      return
    }

    const measure = () => {
      const box = mark.getBoundingClientRect()
      const within = host.getBoundingClientRect()
      setFrame({
        x: box.left - within.left,
        y: box.top - within.top,
        width: box.width,
        height: box.height,
        hostWidth: within.width,
        fontSize: parseFloat(getComputedStyle(host).fontSize) || 0,
      })
    }

    measure()
    // A pass lasts about four seconds, which is long enough for the window
    // to be resized in the middle of one — and the heading rewraps when it
    // is, taking the character out from under its own reticle.
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [pass?.index, pass?.phase])

  const host = className ? `${className} ${styles.host}` : styles.host

  if (settled) {
    if (!pass)
      return (
        <h1 ref={hostRef} className={host} style={style}>
          {text}
        </h1>
      )

    /*
      One word lifted out of the string and nothing else touched.

      It is a word rather than a character because the character has to be an
      `inline-block` — it is transformed, and it carries the seal painted out
      of flow over it — and an inline-block in the middle of a word is a
      line-break opportunity the rest of the heading does not have. A heading
      sitting near its wrap point would break *inside* a word for the four
      seconds of the pass and snap back afterwards. `.word` is the same
      no-break wrapper the entrance decode uses, for the same reason.

      The label is here for the split rather than for the styling. Name
      computation concatenates an element's children, and whether a boundary
      contributes a space depends on the child's `display` — so a heading
      whose middle word is briefly three nodes can be named "SOMETHING IS
      COMI N G" by an implementation that resolves that differently from a
      browser laying the page out. Naming the heading outright makes the pass
      unobservable to assistive tech, which is what it should be: it is a
      light effect on one letter, not a change to anything the heading says.
      It goes on and comes off with the pass, so the resting heading is still
      nothing but its own text.
    */
    const start = wordStart(text, pass.index)
    const end = wordEnd(text, pass.index)

    return (
      <h1 ref={hostRef} className={host} style={style} aria-label={text}>
        {text.slice(0, start)}
        <span className={styles.word}>
          {text.slice(start, pass.index)}
          <span ref={markRef} className={`${styles.mark} ${styles[pass.phase]}`}>
            {pass.glyph ? (
              <>
                {/* The real character, holding its own width while the seal
                    stands over it — the entrance's rule, one character wide. */}
                <span className={styles.ghost}>{text[pass.index]}</span>
                <span className={styles.glyph}>
                  <Noise glyph={pass.glyph} />
                </span>
              </>
            ) : (
              text[pass.index]
            )}
          </span>
          {text.slice(pass.index + 1, end)}
        </span>
        {text.slice(end)}
        <InterceptOverlay phase={pass.phase} frame={frame} />
      </h1>
    )
  }

  /*
    Words are grouped so the line still wraps where a line of text wraps.
    Each character is its own inline-block below, and without this grouping
    a narrow viewport would break the heading in the middle of a word.
  */
  const words = text.split(' ')
  let cursor = 0

  return (
    <h1 ref={hostRef} className={host} style={style} aria-label={text}>
      {words.map((word) => {
        const start = cursor
        cursor += word.length + 1
        return (
          <Fragment key={start}>
            {start > 0 ? ' ' : null}
            <span className={styles.word} aria-hidden="true">
              {[...word].map((character, offset) => (
                <Cell key={start + offset} cell={cells[start + offset]} character={character} />
              ))}
            </span>
          </Fragment>
        )
      })}
    </h1>
  )
}

/** Where the word containing `index` begins, and where it ends. */
function wordStart(text: string, index: number): number {
  let start = index
  while (start > 0 && text[start - 1] !== ' ') start -= 1
  return start
}

function wordEnd(text: string, index: number): number {
  let end = index + 1
  while (end < text.length && text[end] !== ' ') end += 1
  return end
}

/**
 * One piece of noise, painted the way that piece has to be painted.
 *
 * The drawn forms are an inline SVG on the same baseline a character would
 * sit on, sized in `cap` units, so a fabricated glyph is exactly as tall as
 * the capitals it stands among — which no character could be promised, in a
 * font stack that is whatever the machine has. See `motion/runes`.
 */
function Noise({ glyph }: { glyph: NoiseGlyph }) {
  if (!glyph.rune) return <>{glyph.text}</>

  return (
    <svg className={styles.rune} viewBox={RUNE_VIEWBOX} aria-hidden="true" focusable="false">
      <path d={glyph.rune} />
    </svg>
  )
}

/**
 * One character of the entrance decode, in whichever of its states it is
 * currently in.
 *
 * The element is the same span throughout — same position, same key — which
 * is what lets the release flash play: React swaps the class on a node that
 * was already there rather than replacing it, so the animation starts on
 * the frame the character resolves.
 */
function Cell({ cell, character }: { cell: CipherCell; character: string }) {
  if (cell.state === 'real') return <span>{character}</span>
  if (cell.state === 'solved') return <span className={styles.solved}>{character}</span>

  return (
    <span className={styles.cell}>
      {/*
        `visibility: hidden`, not `display: none`: its only job is to hold
        this character's exact width while something else is painted over
        it.
      */}
      <span className={styles.ghost}>{character}</span>
      {/*
        A blank cell paints neither — it is the held box before the first
        frame of noise, and it carries no character *and* no form. The two
        have to be tested separately: a drawn form has no text of its own,
        so a `cell.glyph` check on its own silently paints nothing for every
        frame of the scramble.
      */}
      {cell.glyph || cell.rune ? (
        <span className={`${styles.glyph} ${cell.state === 'cipher' ? styles.cipher : ''}`}>
          <Noise glyph={{ text: cell.glyph, rune: cell.rune }} />
        </span>
      ) : null}
    </span>
  )
}
