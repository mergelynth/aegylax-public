import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { usePageVisible } from '../app/pageVisibility'
import { DIGIT_NOISE, pickGlyph } from './noiseGlyphs'
import { prefersReducedMotion } from './prefersReducedMotion'

/**
 * ТЗ §7 — a control that is quietly still alive.
 *
 * The header's Defenses metric is the one readout in the row that is also a
 * door, and at rest it has no way to say so: it is a glyph and a number in a
 * bar full of glyphs and numbers. The wave the rail's controls wear is wrong
 * here — this is chrome, not a call to act, and a ring pulsing in the header
 * every two seconds is a nag on every screen of the app at once.
 *
 * So it glitches instead. Once every ten to fourteen seconds the chip comes
 * apart for a second and a quarter: the glyph fractures into the five strokes
 * it is drawn from, the pieces and the count are flung clear of the pill and
 * shrink as they go, everything turns twice about the chip's centre, and then
 * it is gathered back into a static readout until the next one. It says
 * "live instrument" rather than "press me", which is the true thing about it.
 *
 * The order of those beats never changes and the distances always do. That
 * split is the point: a burst with no fixed shape is a stutter — there is
 * nothing to follow — and one with no variation is a jingle. See
 * `GlobalStatsHud.module.css` for the choreography; this file owns the
 * clock, the amounts, and the noise.
 *
 * Two properties matter more than the look:
 *
 * **It never moves the header, and it is not contained by it.** Everything
 * the burst does is a transform on a child or a swapped *string of the same
 * length*, so the row's layout — and the chip's own border — is pixel for
 * pixel the same in the middle of a burst as between them. What comes apart
 * is only the contents, and they come apart far enough to leave the pill
 * entirely — off all four sides, not just sideways: nothing clips them, so
 * they cross the border and come back. A glitch that stays inside its box is
 * a box with a glitch in it; this one is a readout losing containment.
 *
 * **Every burst is different.** The chaos is real chaos: the distances and
 * angles come out of `Math.random` per burst, handed to the stylesheet as
 * custom properties, and the noise re-rolls every frame of the run. A glitch
 * that plays the identical 600ms every ten seconds stops being a glitch and
 * becomes a jingle.
 */

/**
 * How long one burst runs, start to settled.
 *
 * It was 620ms, which was long enough to shake something and not long enough
 * to tell a story with it — and the burst is a story now: the glyph
 * fractures, the pieces are flung out, everything turns twice about the chip
 * and is drawn back in. Two revolutions inside six hundred milliseconds is a
 * blur, and a blur is what the old version's "randomness" actually was.
 *
 * This number also appears in `GlobalStatsHud.module.css`, because the
 * animations are CSS and the run is ended here. They have to agree.
 */
const BURST_MS = 1250

/**
 * How long a frame of noise is held.
 *
 * Hard steps rather than a per-frame re-roll at 60fps: a readout cycling
 * sixty times a second is a grey blur, and the thing being imitated here is a
 * display losing sync, which happens in visible jumps.
 */
const NOISE_STEP_MS = 70

/**
 * The quiet between bursts. Ten seconds is the floor the effect was asked
 * for; the spread above it is what keeps a header that is on every screen of
 * the app from developing a beat the eye can predict.
 */
const REST_MIN_MS = 10_000
const REST_MAX_MS = 14_000

/**
 * The share of the run that is still resolving rather than still breaking.
 * Noise stops being drawn over the last quarter, so the count settles back to
 * itself instead of cutting from garbage to the answer on one frame.
 */
const RESOLVE_FROM = 0.75

/** How much of the string is noise at the height of the burst. */
const NOISE_DENSITY = 0.7

function between(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

/** Random, and never so close to zero that the burst reads as a no-op. */
function signed(min: number, max: number): number {
  return between(min, max) * (Math.random() < 0.5 ? -1 : 1)
}

export interface GlitchBurstOptions {
  /** The settled string — what is painted between bursts, and resolved back to. */
  text: string
  /** Whether to run at all. `false` paints `text` and schedules nothing. */
  enabled: boolean
}

export interface GlitchBurst {
  /** The string to paint: noise mid-burst, `text` the rest of the time. */
  text: string
  /** Whether a burst is running — the flag the stylesheet keys off. */
  active: boolean
  /** This burst's random distances and angles, for spreading onto the host. */
  style: CSSProperties
}

const AT_REST: CSSProperties = Object.freeze({})

export function useGlitchBurst({ text, enabled }: GlitchBurstOptions): GlitchBurst {
  const visible = usePageVisible()
  const [active, setActive] = useState(false)
  const [noise, setNoise] = useState<string | null>(null)
  /*
   * The settled string, read by a run that started before the current value
   * did. A count that ticks over mid-burst has to be noised at its *new*
   * length or the chip changes width halfway through the glitch — and this
   * is a ref rather than a dependency because re-running the effect on every
   * new count would restart the cycle and push the next burst ten seconds
   * out every time the protocol answered.
   */
  const latest = useRef(text)
  latest.current = text
  /*
   * Re-rolled when a burst starts, and deliberately *not* state: the values
   * are read by the stylesheet, so writing them through a render would put a
   * second render in front of every burst for nothing the JSX depends on.
   * They are read once, in the same commit that flips `active`.
   */
  const shape = useRef<CSSProperties>({})

  const running = enabled && visible

  useEffect(() => {
    if (!running || prefersReducedMotion()) {
      setActive(false)
      setNoise(null)
      return
    }

    let restTimer: ReturnType<typeof setTimeout> | undefined
    let noiseTimer: ReturnType<typeof setInterval> | undefined
    let endTimer: ReturnType<typeof setTimeout> | undefined

    const stop = () => {
      if (noiseTimer) clearInterval(noiseTimer)
      noiseTimer = undefined
      setActive(false)
      setNoise(null)
    }

    const burst = () => {
      /*
       * The amplitudes, chosen against the size of the chip rather than
       * picked as "a small nudge".
       *
       * The pill is about 56px wide and 34 tall, with the glyph at 7-29 and
       * the count near 36-48. The first version of these numbers moved
       * things 12-18px, which keeps every pixel of the burst *inside the
       * border* — so what the header showed was a chip with something
       * rattling politely in it. The burst is supposed to look like the
       * readout losing containment, and containment is the thing you have to
       * see broken.
       *
       * `--glitch-y` is the one to read twice. It looks like the smaller
       * number and it is the more violent of the two, because the box it has
       * to clear is 34px rather than 56: at 11-21px the count goes entirely
       * off the top or the bottom, where the same distance sideways would
       * only shuffle it. That asymmetry is the whole difference between
       * disorder and a shake — sideways, things trade places; vertically,
       * there is nowhere to trade to.
       *
       * It stops just short of 21px on purpose. The chip sits 20px from the
       * top of the window, so a bigger upward throw would put the count
       * behind the top edge of the viewport and the chaos would be *cropped*
       * rather than free — which is the one way it could look contained
       * again after all this.
       *
       * There is no angle among these any more. The two revolutions the
       * burst turns through are the same every time and belong in the
       * stylesheet: the *shape* of the event is fixed — fracture, scatter,
       * orbit, gather — and what is re-rolled is only how far things go. A
       * sequence whose choreography changed per burst would have no
       * choreography.
       */
      shape.current = {
        ['--glitch-x' as string]: `${signed(6, 14).toFixed(2)}px`,
        ['--glitch-y' as string]: `${signed(11, 21).toFixed(2)}px`,
        ['--glitch-swap' as string]: `${between(30, 46).toFixed(1)}px`,
        ['--glitch-skew' as string]: `${signed(10, 20).toFixed(1)}deg`,
        /*
         * How far the glyph's five pieces are thrown, in the icon's own user
         * units rather than in pixels: the paths are transformed inside a
         * 24-unit viewBox drawn at 22px, so a unit here is a little under a
         * pixel on screen. 20-30 puts every piece clear of a 56x34 chip
         * without throwing them so far they stop reading as belonging to it.
         */
        ['--glitch-piece' as string]: `${between(20, 30).toFixed(1)}px`,
      }
      setActive(true)

      const startedAt = performance.now()
      const roll = () => {
        const progress = (performance.now() - startedAt) / BURST_MS
        /*
         * Density falls to nothing over the tail of the run, so characters
         * drop out of the noise a few at a time and the readout comes back
         * rather than being switched back.
         */
        const density =
          progress >= RESOLVE_FROM
            ? NOISE_DENSITY * Math.max(0, 1 - (progress - RESOLVE_FROM) / (1 - RESOLVE_FROM))
            : NOISE_DENSITY

        setNoise(
          [...latest.current]
            .map((character) =>
              // Only digits are ever replaced: a separator or a placeholder
              // holds the shape of the readout while the count comes apart.
              character >= '0' && character <= '9' && Math.random() < density
                ? pickGlyph(DIGIT_NOISE).text
                : character,
            )
            .join(''),
        )
      }

      roll()
      noiseTimer = setInterval(roll, NOISE_STEP_MS)
      endTimer = setTimeout(() => {
        stop()
        schedule()
      }, BURST_MS)
    }

    const schedule = () => {
      restTimer = setTimeout(burst, between(REST_MIN_MS, REST_MAX_MS))
    }

    schedule()
    return () => {
      if (restTimer) clearTimeout(restTimer)
      if (noiseTimer) clearInterval(noiseTimer)
      if (endTimer) clearTimeout(endTimer)
    }
  }, [running])

  return {
    text: active && noise !== null ? noise : text,
    active,
    style: active ? shape.current : AT_REST,
  }
}
