import { useEffect, useState } from 'react'
import { usePageVisible } from '../app/pageVisibility'
import { prefersReducedMotion } from './prefersReducedMotion'
import { DIGIT_NOISE, RUNE_NOISE, pickGlyph, type NoiseGlyph } from './noiseGlyphs'

/**
 * The five beats of one intercept, in the order they read.
 *
 * They are the product's own loop said in miniature, and they are the
 * hero's three commands in the order the tagline gives them — *Locate it.
 * Time it. Intercept it.*
 *
 *   sweep   a reticle closes on one character: a position has been found
 *   lock    the character seals — it churns cipher → data behind the
 *           brackets, because the value under a lock is not readable
 *   strike  the interceptor is inbound; the character is still sealed
 *   burst   impact: the real character comes back white-hot
 *   cool    the heat bleeding off, down to ordinary ink
 *
 * The order is the sentence and it is not interchangeable. A seal that
 * broke *before* the interceptor arrived would say the value leaked; a
 * burst without a lock in front of it would be a letter flashing for no
 * reason. Every beat is a claim the protocol actually makes.
 */
export type InterceptPhase = 'sweep' | 'lock' | 'strike' | 'burst' | 'cool'

export interface InterceptPass {
  /** Index into the string of the character currently under the pass. */
  index: number
  phase: InterceptPhase
  /**
   * The sealed form standing over that character, or `null` while the real
   * one is showing. Set through `lock` and `strike` and nothing else.
   */
  glyph: NoiseGlyph | null
}

export interface InterceptPassOptions {
  text: string
  /** Whether to run at all. False holds the string plain and cancels any pass. */
  active: boolean
  /** ms after activation before the first pass opens. */
  first?: number
  /** ms the reticle takes to close on the character. */
  sweep?: number
  /** ms the character spends sealed behind the lock. */
  lock?: number
  /** ms the interceptor spends inbound. */
  strike?: number
  /** ms of the impact itself. */
  burst?: number
  /** ms the character takes to cool back to ordinary ink. */
  cool?: number
  /** ms one sealed form holds before the next replaces it. */
  flip?: number
  /** Shortest and longest quiet gap between one pass and the next. */
  gapMin?: number
  gapMax?: number
}

/**
 * The two vocabularies a sealed character churns through, alternating.
 *
 * The entrance decode uses three — script, digits, letters (see
 * `useCipherReveal`) — and the third one is deliberately absent here. There,
 * the whole line is noise and a letter among the noise reads as a value
 * arriving; here, one character in an otherwise settled heading is swapped
 * for another *letter*, and what that reads as is a typo. The script and the
 * digits cannot be misread as the word trying to spell something else.
 */
const SEAL_POOLS = [RUNE_NOISE, DIGIT_NOISE] as const

/**
 * How many characters back the picker refuses to land on again.
 *
 * One was not enough. The rule used to be "never the same character twice
 * running", which lets the pass bounce between two letters — A, B, A, B — and
 * a heading that keeps returning to the same two positions reads as two
 * broken letters rather than as a sweep looking somewhere new each time.
 * Three is the most a nineteen-character line can refuse without the choice
 * stopping being a choice.
 */
const RECENT_TARGETS = 3

/**
 * How far the churn's cadence is allowed to wander either side of `flip`.
 *
 * A seal flipping on an exact interval is a blinking cursor: the eye picks
 * the period up within two or three frames and the rest of the beat is
 * predictable. A quarter either way is enough to break that without the
 * churn ever looking like it stalled or ran away.
 */
const FLIP_JITTER = 0.25

/**
 * What the title does once it has nothing left to decode — ТЗ §9, and the
 * one motion in the product that never finishes.
 *
 * The heading is on screen for as long as someone is on the page, so after
 * the decode it keeps running the game's own loop over its own letters. A
 * reticle closes on one character; the character seals and churns behind
 * it; an interceptor crosses the line; the character comes back on impact
 * and cools. Then a couple of seconds of quiet, another character, again —
 * for as long as the page is open.
 *
 * The previous version of this loop was one character blinking red for five
 * and a half seconds before a green flash cleared it. The colours were
 * right and the sentence was right; the *pacing* said the wrong thing.
 * Five seconds of a blinking letter is a fault the system is not attending
 * to — a headline with a dead pixel in it — where this product's whole
 * claim is that a threat is found, timed and met. So the long, static beat
 * is gone: the red is now a lock closing (0.9s) and a seal churning (1.4s),
 * both of which are the system *working*, and the two loud beats — the
 * interceptor and the impact — are under a second together.
 *
 * The geometry that goes with these beats — where the brackets sit, where
 * the interceptor comes in from — is measured from the character itself and
 * drawn by `InterceptOverlay`. This hook owns only the clock and the seal.
 *
 * Timers rather than a rAF loop: five state changes over four seconds, none
 * of which needs a frame clock. The seal's churn is the one exception and it
 * reschedules itself at roughly 8fps, which is the speed a value being worked
 * on flickers at — not a speed anything needs to be smooth at.
 *
 * Returns the character under the pass, or `null` in the quiet between them.
 */
export function useInterceptPass({
  text,
  active,
  first = 900,
  sweep = 900,
  lock = 1400,
  strike = 300,
  burst = 420,
  cool = 1400,
  flip = 120,
  gapMin = 2200,
  gapMax = 4200,
}: InterceptPassOptions): InterceptPass | null {
  const visible = usePageVisible()
  const [pass, setPass] = useState<InterceptPass | null>(null)

  useEffect(() => {
    if (!active || !visible || prefersReducedMotion()) {
      setPass(null)
      return
    }

    const targets = [...text].flatMap((character, index) => (character === ' ' ? [] : [index]))
    if (targets.length === 0) return

    // One timeout in flight at a time — each beat schedules the next as it
    // fires — plus the seal's own, which exists only during `lock`.
    // Clearing both on unmount stops the whole cycle.
    let timer = 0
    let churn = 0
    /*
     * The last few characters the pass has been on, newest first.
     *
     * Kept as a list rather than as one `previous`, because refusing only
     * the character just done still lets the pass oscillate between two
     * positions, and two letters taking it in turns is the one pattern a
     * random sweep must not fall into — it stops looking like a system
     * searching and starts looking like the same two letters are broken.
     */
    const recent: number[] = []

    const run = () => {
      /*
       * Somewhere it has not just been. The refusal is capped at what the
       * string can actually spare, so a short line (or a one-character one)
       * still has something left to choose from rather than looping forever.
       */
      const avoid = recent.slice(0, Math.min(RECENT_TARGETS, targets.length - 1))
      let index = targets[Math.floor(Math.random() * targets.length)]
      while (avoid.includes(index)) {
        index = targets[Math.floor(Math.random() * targets.length)]
      }
      recent.unshift(index)
      recent.length = Math.min(recent.length, RECENT_TARGETS)

      const step = (phase: InterceptPhase, glyph: NoiseGlyph | null, after: number, next: () => void) => {
        setPass({ index, phase, glyph })
        timer = window.setTimeout(next, after)
      }

      step('sweep', null, sweep, () => {
        /*
         * The seal, and the one part of this loop the eye actually reads
         * character by character.
         *
         * Each form comes from a different pool than the one before it, and
         * — the rule this is really built on — **no pool paints the same
         * form twice inside one pass**. Refusing only the form currently
         * showing was not enough, and could not have been: the pools
         * alternate, so the form showing when a digit is drawn is always a
         * rune, and the refusal never once applied to the digits. Ten
         * independent draws out of ten put the same digit up two and three
         * times inside a single character's seal, which is exactly what a
         * sealed value must not look like — a slot cycling four numbers is a
         * slot with four numbers in it, not an unreadable one.
         *
         * So each pool spends its own forms: `spent` is what that pool has
         * already painted this pass, `pickGlyph` draws from what is left, and
         * a pool that runs out starts a fresh round minus the form it ended
         * on — so even the seam between two rounds is not a repeat. Over a
         * 1.4s lock that is six or seven digits, all different, out of ten.
         *
         * Which pool leads is drawn per pass as well. It was always the
         * script, which made the first frame of every seal in the page's
         * lifetime the same *kind* of noise.
         */
        let pool = Math.floor(Math.random() * SEAL_POOLS.length)
        const spent = SEAL_POOLS.map(() => new Set<NoiseGlyph>())
        const last: (NoiseGlyph | null)[] = SEAL_POOLS.map(() => null)
        let showing: NoiseGlyph | null = null

        const reseal = () => {
          const slot = pool % SEAL_POOLS.length
          const source = SEAL_POOLS[slot]
          // Round over: everything this pool has is on the record. Start
          // again from all of it but the form it last put up.
          if (spent[slot].size >= source.length) {
            spent[slot] = new Set(last[slot] ? [last[slot]!] : [])
          }

          const next = pickGlyph(source, spent[slot])
          spent[slot].add(next)
          last[slot] = next
          pool += 1
          showing = next
          setPass({ index, phase: 'lock', glyph: next })

          // Self-scheduling rather than an interval, because the cadence is
          // no longer a constant — see `FLIP_JITTER`.
          churn = window.setTimeout(reseal, flip * (1 + (Math.random() * 2 - 1) * FLIP_JITTER))
        }

        reseal()

        timer = window.setTimeout(() => {
          window.clearTimeout(churn)
          churn = 0

          // The seal holds through the strike, on the last form it drew: the
          // interceptor is in the air and the value is not out yet.
          step('strike', showing, strike, () =>
            step('burst', null, burst, () =>
              step('cool', null, cool, () => {
                setPass(null)
                timer = window.setTimeout(run, gapMin + Math.random() * (gapMax - gapMin))
              }),
            ),
          )
        }, lock)
      })
    }

    timer = window.setTimeout(run, first)
    return () => {
      window.clearTimeout(timer)
      if (churn) window.clearTimeout(churn)
    }
  }, [text, active, visible, first, sweep, lock, strike, burst, cool, flip, gapMin, gapMax])

  return pass
}
