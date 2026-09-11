import { memo, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { isPageVisible, subscribeToPageVisibility } from '../../app/pageVisibility'
import { buildStarfield, type Star } from './starfield'
import styles from './SpaceBackground.module.css'

/** Star elements carry their color/opacity/twinkle state as CSS custom properties so each one can animate independently from a shared keyframe. */
type StarStyle = CSSProperties & Record<`--${string}`, string | number>

const DEFAULT_SEED = 'aegylax-space'
const MIN_PAUSE_MS = 4000
const MAX_PAUSE_MS = 8000
/** Fraction of cycles where no star twinkles at all — the field should mostly sit still. */
const SKIP_CYCLE_CHANCE = 0.15
const MIN_TWINKLE_S = 1.6
const MAX_TWINKLE_S = 2.8
const MIN_INTENSITY = 0.3
const MAX_INTENSITY = 0.55
const MIN_PEAK_SCALE = 1.2
const MAX_PEAK_SCALE = 1.45
/** Twinkling a near-invisible 0.5px/0.15-opacity star registers as nothing — only the brighter, larger minority (top quarter by size*opacity) are picked. */
const TWINKLE_POOL_FRACTION = 0.25

interface TwinkleParams {
  duration: number
  peakOpacity: number
  peakScale: number
  twinkleColor: string
}

/** Small, minimal color shift per base tone — never a hue jump, always returns to the base color when the twinkle ends. */
const TWINKLE_SHIFT: Record<string, string> = {
  '#E8EEFF': '#F5F8FF',
  '#FFFFFF': '#EAF1FF',
  '#C9D9F5': '#DCE7FF',
  '#CFE6EE': '#E3F3F8',
}

function shiftColor(base: string): string {
  return TWINKLE_SHIFT[base] ?? '#FFFFFF'
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function pickPause(): number {
  return MIN_PAUSE_MS + Math.random() * (MAX_PAUSE_MS - MIN_PAUSE_MS)
}

/** Indices of the stars visible enough for a twinkle to actually register, ranked by size*opacity. */
function buildTwinklePool(stars: Star[]): number[] {
  const ranked = stars
    .map((star, index) => ({ index, score: star.size * star.opacity }))
    .sort((a, b) => b.score - a.score)
  const poolSize = Math.max(Math.min(5, stars.length), Math.round(stars.length * TWINKLE_POOL_FRACTION))
  return ranked.slice(0, poolSize).map((entry) => entry.index)
}

/**
 * Sparse, bursty twinkle: 1-3 random (visible) stars flicker together —
 * and often none at all — each with its own random duration/intensity/
 * color shift, then the whole field pauses a few seconds before the next
 * random cycle. Never synchronized, never constant.
 */
function useTwinklingStars(stars: Star[]): Map<number, TwinkleParams> {
  const [twinkling, setTwinkling] = useState<Map<number, TwinkleParams>>(() => new Map())
  const pool = useMemo(() => buildTwinklePool(stars), [stars])

  useEffect(() => {
    if (pool.length === 0) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let cancelled = false
    let timeout: ReturnType<typeof setTimeout>

    const scheduleNextCycle = (delayMs: number) => {
      timeout = setTimeout(() => {
        if (cancelled) return
        if (!isPageVisible()) {
          scheduleNextCycle(pickPause())
          return
        }

        if (Math.random() < SKIP_CYCLE_CHANCE) {
          scheduleNextCycle(pickPause())
          return
        }

        const count = Math.min(1 + Math.floor(Math.random() * 3), pool.length)
        const picked = new Map<number, TwinkleParams>()
        while (picked.size < count) {
          const index = pool[Math.floor(Math.random() * pool.length)]
          if (picked.has(index)) continue
          const star = stars[index]
          picked.set(index, {
            duration: randomBetween(MIN_TWINKLE_S, MAX_TWINKLE_S),
            peakOpacity: Math.min(0.98, star.opacity + randomBetween(MIN_INTENSITY, MAX_INTENSITY)),
            peakScale: randomBetween(MIN_PEAK_SCALE, MAX_PEAK_SCALE),
            twinkleColor: shiftColor(star.color),
          })
        }
        setTwinkling(picked)

        const burstMs = Math.max(...Array.from(picked.values(), (p) => p.duration)) * 1000
        timeout = setTimeout(() => {
          if (cancelled) return
          setTwinkling(new Map())
          scheduleNextCycle(pickPause())
        }, burstMs)
      }, delayMs)
    }

    scheduleNextCycle(pickPause())

    const releaseVisibility = subscribeToPageVisibility((visible) => {
      if (!visible) setTwinkling(new Map())
    })

    return () => {
      cancelled = true
      clearTimeout(timeout)
      releaseVisibility()
    }
  }, [stars, pool])

  return twinkling
}

export interface SpaceBackgroundProps {
  /** More stars for the larger Home hero area than the Lobby's square viewport. */
  density?: number
  seed?: string
}

/** Where a star sits and how it looks when nothing is happening to it. */
function baseStyle(star: Star): StarStyle {
  return {
    left: `${star.xPercent}%`,
    top: `${star.yPercent}%`,
    width: `${star.size}px`,
    height: `${star.size}px`,
    '--base-opacity': star.opacity,
    '--base-color': star.color,
  }
}

/**
 * The field itself — every star, drawn once and never re-rendered.
 *
 * The whole point of pulling it out is the `memo`. The starfield is 220
 * absolutely positioned elements on the Home hero, and it used to be rebuilt
 * in full every time the twinkle state changed: 220 elements reconciled and
 * 220 style objects allocated so that one to three of them could light up,
 * several times a minute, plus once more at the end of every burst. Nothing
 * about a star that is not twinkling ever changes — the geometry is
 * deterministic from the seed — so this renders on mount and then holds
 * still, and the burst is drawn by `Twinkles` on top of it.
 */
const StarField = memo(function StarField({ stars }: { stars: Star[] }) {
  return (
    <>
      {stars.map((star, index) => (
        <span key={index} className={styles.star} style={baseStyle(star)} />
      ))}
    </>
  )
})

/**
 * The one to three stars currently flickering, drawn over their own resting
 * copies rather than replacing them.
 *
 * Overlaying works because a twinkle is only ever *brighter* than the star
 * underneath it — same position, same hue, higher opacity and a slightly
 * larger disc — so the resting star disappears inside it for the length of the
 * burst and is exactly what the animation returns to.
 */
function Twinkles({ stars, twinkling }: { stars: Star[]; twinkling: Map<number, TwinkleParams> }) {
  return (
    <>
      {Array.from(twinkling, ([index, twinkle]) => {
        const star = stars[index]
        if (!star) return null
        const style: StarStyle = {
          ...baseStyle(star),
          '--peak-opacity': twinkle.peakOpacity,
          '--peak-scale': twinkle.peakScale,
          '--twinkle-color': twinkle.twinkleColor,
          animationDuration: `${twinkle.duration}s`,
        }
        return <span key={index} className={`${styles.star} ${styles.twinkle}`} style={style} />
      })}
    </>
  )
}

/** Deterministic starfield (never reshuffles on re-render) — no repeating/tiling pattern. */
function SpaceBackgroundView({ density = 90, seed = DEFAULT_SEED }: SpaceBackgroundProps) {
  const stars = useMemo(() => buildStarfield(density, seed), [density, seed])
  const twinkling = useTwinklingStars(stars)

  return (
    <div className={styles.space} aria-hidden="true">
      <StarField stars={stars} />
      <Twinkles stars={stars} twinkling={twinkling} />
    </div>
  )
}

/*
 * The field's own `memo`, above `StarField`'s.
 *
 * `StarField` already refuses to re-render, but reaching that decision
 * still meant re-running this component and its twinkle hook on every
 * countdown tick of the page above it. Both props are primitives, so the
 * whole subtree can be skipped instead.
 */
export const SpaceBackground = memo(SpaceBackgroundView)
