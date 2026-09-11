import { memo, useEffect, useRef, type CSSProperties } from 'react'
import {
  EARTH_AXIAL_TILT_DEGREES,
  EARTH_GLOBE_SLICES,
  EARTH_ROTATION_PERIOD_MS,
  EARTH_VIEW_ELEVATION_DEGREES,
  computeEarthGlobeTransform,
  computeEarthRotationPhase,
} from '../../game/earthRotation'
import { SurfaceSignals } from './SurfaceSignals'
import styles from './EarthSphere.module.css'

/**
 * `idle`        — nothing has happened to the planet.
 * `intercepted` — the attack was stopped: green defensive state and an
 *                 energy shield that pulses out around the globe (ТЗ §12).
 * `impacted`    — the attack landed: red defensive state and an impact
 *                 shockwave, deliberately a different motion from the
 *                 shield so the two never read as the same event (ТЗ §13).
 */
export type EarthState = 'idle' | 'intercepted' | 'impacted'

export interface EarthSphereProps {
  /** 'hero' sizes Earth relative to the viewport instead of container width, so it stays a small landmark in the full-bleed hero. */
  variant?: 'panel' | 'hero'
  state?: EarthState
  /**
   * A chain timestamp to pin the planet at, or null to follow the clock
   * (ТЗ §6).
   *
   * Rotation is a pure function of time — `earthPosition = f(timestamp)` —
   * so freezing the globe is not a matter of *stopping* it but of feeding
   * it a fixed instant instead of `Date.now()`. Pass the block timestamp of
   * the impact and the planet shows the face it wore at that moment, on
   * every reload, in every browser, a month later.
   *
   * That is the whole reason this is a timestamp rather than a boolean.
   * Simply halting the animation would leave whatever angle the tab
   * happened to render last, and the trajectory, the impact point and every
   * Defense Point pinned to that globe would quietly become a lie on the
   * next visit.
   */
  frozenAtMs?: number | null
  /**
   * ТЗ §12-13 — whether the result is *arriving* or merely *standing*.
   *
   * The shield and the shockwave are a moment: they belong to the instant
   * the protocol hands the verdict over. Reopening an operation that
   * resolved last week is not that instant, so the planet keeps its colour
   * and its shell and the burst simply does not play. See `LobbyPage`.
   */
  announce?: boolean
}

const SLICE_HALF_DEG = 180 / EARTH_GLOBE_SLICES
const GLOBE_SLICES = Array.from({ length: EARTH_GLOBE_SLICES }, (_, i) => ({
  i,
  transform:
    `translate(-50%, -50%) rotateY(${(i * 360) / EARTH_GLOBE_SLICES}deg) ` +
    `translateZ(calc(50cqmin * cos(${SLICE_HALF_DEG}deg)))`,
  backgroundPosition: `${(i / (EARTH_GLOBE_SLICES - 1)) * 100}% 50%`,
}))

/**
 * The globe's turn, handed to the compositor once instead of driven frame
 * by frame (ТЗ §6).
 *
 * Rotation is still `f(timestamp)` — every tab, device and reload shows the
 * same face of the planet at the same instant. The timestamp is read at
 * mount and again when the tab returns to the screen, then converted into
 * a negative `animation-delay`. A CSS animation started with a negative
 * delay begins already that far into its cycle, so one number places the
 * loop at the exact wall-clock phase and the compositor carries the rest.
 *
 * That is what fixes the judder. The previous version repainted the largest
 * element on the page from a rAF loop throttled to ~8fps, which is a step
 * every 120ms rather than motion; this runs at the display's own refresh
 * rate *and* costs less, because the animated property is a `transform` on
 * a promoted layer — no paint at all, no JavaScript per frame, and nothing
 * running while the tab is in the background.
 *
 * A frozen globe is the same function evaluated at the impact block instead
 * of at now, written as a static transform with the animation off.
 */
function useEarthSpin(frozenAtMs: number | null) {
  const nodeRef = useRef<HTMLDivElement>(null)
  const delayMs = useRef<number | null>(null)
  if (delayMs.current === null) {
    delayMs.current = -computeEarthRotationPhase(Date.now()) * EARTH_ROTATION_PERIOD_MS
  }

  useEffect(() => {
    if (frozenAtMs !== null) return
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      const next = -computeEarthRotationPhase(Date.now()) * EARTH_ROTATION_PERIOD_MS
      delayMs.current = next
      const el = nodeRef.current
      if (!el) return
      el.style.animation = 'none'
      void el.offsetWidth
      el.style.removeProperty('animation')
      el.style.animationDuration = `${EARTH_ROTATION_PERIOD_MS}ms`
      el.style.animationDelay = `${next}ms`
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [frozenAtMs])

  const axis: CSSProperties = {
    ['--earth-elev' as string]: `${EARTH_VIEW_ELEVATION_DEGREES}deg`,
    ['--earth-tilt' as string]: `${-EARTH_AXIAL_TILT_DEGREES}deg`,
  }

  if (frozenAtMs !== null) {
    return { style: { ...axis, animation: 'none', transform: computeEarthGlobeTransform(frozenAtMs) }, nodeRef }
  }
  return {
    style: {
      ...axis,
      animationDuration: `${EARTH_ROTATION_PERIOD_MS}ms`,
      animationDelay: `${delayMs.current}ms`,
    },
    nodeRef,
  }
}

function EarthSphereView({
  variant = 'panel',
  state = 'idle',
  frozenAtMs = null,
  announce = true,
}: EarthSphereProps) {
  const isHero = variant === 'hero'
  const spin = useEarthSpin(frozenAtMs)

  return (
    <>
      {/*
        The result effects are a sibling of the globe, not a child of it:
        both have to grow *past* Earth's rim, and `.wrap` clips its own
        contents to keep the texture inside the circle. `.effects` repeats
        the globe's box so the rings stay concentric with it at every
        viewport size.
      */}
      {state !== 'idle' && announce ? (
        <div className={[styles.effects, isHero ? styles.effectsHero : ''].filter(Boolean).join(' ')} aria-hidden="true">
          {state === 'intercepted' ? (
            <>
              <span className={[styles.aura, styles.shieldAura].join(' ')} />
              <span className={styles.shield} />
              <span className={[styles.shield, styles.shieldEcho].join(' ')} />
            </>
          ) : (
            <>
              <span className={[styles.aura, styles.impactAura].join(' ')} />
              <span className={styles.impact} />
              <span className={[styles.impact, styles.impactEcho].join(' ')} />
            </>
          )}
        </div>
      ) : null}

      {/*
        ТЗ §18 — `boot-earth`: the planet comes up out of the black, from
        invisible to fully present, over a second and a half. The longest
        motion on the page, because ТЗ §30 puts Earth second only to the
        title in the attention hierarchy — and for a body this size the way
        to say that is duration, not travel. Nothing about the globe's
        geometry moves while it arrives; it is where it will be from the
        first frame and only its visibility changes, which is why it reads
        as a planet emerging rather than as one being inflated.

        ТЗ §19, §35 — the surface signals are not waiting for it. They start
        waking at 1500ms, while the planet is still coming up, so it arrives
        with activity already on it. They sit inside this element, so the
        same fade carries them; their spin and their cursor field know
        nothing about the entrance.
      */}
      <div
        className={[styles.wrap, isHero ? styles.wrapHero : '', stateClass(state), 'boot-earth']
          .filter(Boolean)
          .join(' ')}
        style={isHero ? ({ ['--globe-slices' as string]: EARTH_GLOBE_SLICES } as CSSProperties) : undefined}
        aria-hidden="true"
        /*
          The one stable handle on the planet's geometry.

          The Command Rail is shaped to Earth's own silhouette — it sits in
          the bottom of the globe and its ends follow the curve — and it is
          portalled to `document.body`, so it cannot reach this element
          through the tree. It finds it by this attribute instead. A hashed
          CSS-module class would work today and break the moment the module
          is renamed; this is a contract, and it is the reason it is worth a
          line of markup.
        */
        data-earth="globe"
      >
        {isHero ? (
          /*
            ТЗ §6 — spin about Earth's own axis, not a 2D slide.

            Longitude slices of the equirectangular map sit on a CSS 3D
            cylinder. The sphere group rotates in Y (the polar axis), then
            leans by the real 23.5° obliquity, then tips slightly toward
            the camera so we look at the planet from the side. Still the
            compositor — no rAF, no Three.js.
          */
          <>
            {/* The texture arrives already graded — see `.slice` in the
                stylesheet and `tools/assets/bake-earth-grade.py`. There is
                no filter to define here, and nothing in this `preserve-3d`
                group that is not a plane of the globe. */}
            <div className={styles.stage}>
              <div
                ref={spin.nodeRef}
                className={styles.sphere}
                style={spin.style}
                data-earth-spin=""
              >
                {GLOBE_SLICES.map((slice) => (
                  <span
                    key={slice.i}
                    className={styles.slice}
                    style={{ transform: slice.transform, backgroundPosition: slice.backgroundPosition }}
                  />
                ))}
              </div>
            </div>
          </>
        ) : (
          <div className={styles.surface} />
        )}
        {/* Between the globe and the terminator on purpose: the night side
            has to fall across the markers too, or they stop belonging to the
            planet and start floating in front of it. */}
        {isHero ? <SurfaceSignals /> : null}
        <div className={[styles.terminator, isHero ? styles.terminatorHero : ''].filter(Boolean).join(' ')} />
        {isHero ? <span className={styles.atmosphere} /> : null}
        {state !== 'idle' ? <div className={styles.wash} /> : null}
      </div>
    </>
  )
}

function stateClass(state: EarthState): string {
  if (state === 'intercepted') return styles.defended
  if (state === 'impacted') return styles.struck
  return ''
}

/*
 * The planet does not depend on the clock, and the pages it sits on do.
 *
 * `LobbyPage` subscribes to the shared countdown sample, which advances
 * four times a second, so without this every tick re-rendered the globe:
 * sixteen slices, sixteen fresh style objects, and a reconciliation pass
 * over the largest element on the screen — to arrive at exactly the markup
 * that was already there. Every prop here is a primitive, so the default
 * comparison is the right one and the spin keeps running on the
 * compositor's own clock, untouched.
 */
export const EarthSphere = memo(EarthSphereView)
