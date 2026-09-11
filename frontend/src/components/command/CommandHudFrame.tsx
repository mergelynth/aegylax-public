import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import styles from './CommandCenter.module.css'

type Pt = readonly [number, number]
type Vert = { p: Pt; r: number }

/**
 * How far a notch wall runs sideways per unit of depth — the frame's one
 * notch angle, held equal on the long edges and the short ones.
 */
const WALL_SLANT = 1.4

/** Share of the inner path one pulse covers. */
const COMET = 0.2
const LOOP_S = 40

/**
 * How much faster the pulses run while a probe's readings are coming back.
 *
 * A rate rather than a shorter `LOOP_S`, and the distinction is the whole
 * of why this works. The two pulses are one keyframe pair told apart by a
 * negative `animation-delay` of half a lap, so the duration is what *sets*
 * their separation: halve it and the delay that put them on opposite sides
 * of the frame no longer does, and both bands snap to a new offset the
 * moment the probe goes out. Scaling `playbackRate` leaves every one of
 * those numbers alone — each band keeps its own current time, the gap
 * between them keeps its 20s width against an unchanged 40s lap, and the
 * only thing that changes is how fast the clock they share is read.
 *
 * So the frame speeds up from wherever it happens to be, without a jump at
 * either end of the scan.
 */
const SCAN_RATE = 2

/** Mask band: wide enough that blurring it fades only the pulse's ends. */
const BAND = 38
const BAND_SOFT = 12

/**
 * Outer gray octagon + inner notched track, with two neon pulses riding
 * the inner path opposite each other.
 *
 * A pulse is the full-perimeter neon stroke — a thin core under three
 * blurred halos — revealed through a moving, blurred mask band. Fading the
 * *mask* is what tapers the head and tail: widening the stroke instead put
 * a bright slab in the middle, and the blur pooled in the V-notches.
 *
 * The dashes are normalised by `pathLength`, so nothing here may carry
 * `vector-effect: non-scaling-stroke`: that scales the dash pattern into
 * screen space while offsets stay in path space, so on a 2× display the
 * pattern repeats and each pulse is drawn twice.
 *
 * `live` is what the pulses are actually reporting: an attack in the sky.
 * The console is on screen for far longer than that — an open room, a wait
 * for launch, a finished operation still owing a payout — and neon running
 * on all of them is decoration that never means anything. Off, the pulses
 * and the masks and filters that draw them are simply not rendered, so
 * those phases leave a plain two-line frame and cost nothing to paint.
 * Defaults to off: a panel that has not said it is live is not.
 *
 * `scanning` is the one thing that changes how they run: a probe is out and
 * its readings are on the way back. The frame is the only part of the
 * console that can say so — the map has not changed yet and will not until
 * the fog lands — so the two pulses double their speed for the length of
 * the wait and drop back when it is over. Same track, same colours, same
 * separation; the panel simply works faster while it is working.
 */
function CommandHudFrameView({ live = false, scanning = false }: { live?: boolean; scanning?: boolean }) {
  const hostRef = useRef<HTMLSpanElement>(null)
  const [size, setSize] = useState({ w: 420, h: 120 })
  const uid = useId().replace(/:/g, '')

  useLayoutEffect(() => {
    const host = hostRef.current?.parentElement
    if (!host) return

    const read = () => {
      const box = host.getBoundingClientRect()
      if (box.width < 8 || box.height < 8) return
      setSize({ w: box.width, h: box.height })
    }

    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(host)
    return () => observer.disconnect()
  }, [])

  const paths = useMemo(() => buildHudPaths(size.w, size.h), [size])
  const rate = scanning ? SCAN_RATE : 1

  return (
    <>
      <span
        ref={hostRef}
        className={styles.hudGlass}
        style={{
          clipPath: `path("${paths.outer}")`,
          WebkitClipPath: `path("${paths.outer}")`,
        }}
        aria-hidden="true"
      />
      <svg
        className={styles.hudSvg}
        viewBox={`0 0 ${size.w} ${size.h}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {live ? (
          <defs>
            <Blur id={`${uid}soft`} sigma={BAND_SOFT} />
            <Blur id={`${uid}wide`} sigma={9} />
            <Blur id={`${uid}far`} sigma={4} />
            <Blur id={`${uid}near`} sigma={1.4} />
            <PulseMask id={`${uid}mp`} d={paths.inner} phase={0} rate={rate} blur={`url(#${uid}soft)`} box={size} />
            <PulseMask id={`${uid}mb`} d={paths.inner} phase={0.5} rate={rate} blur={`url(#${uid}soft)`} box={size} />
          </defs>
        ) : null}

        <path className={styles.hudOuter} d={paths.outer} />
        <path className={styles.hudInner} d={paths.inner} />

        {live ? (
          <>
            <NeonPulse
              d={paths.inner}
              mask={`url(#${uid}mp)`}
              uid={uid}
              tints={[styles.hudGlowAccentWide, styles.hudGlowAccentFar, styles.hudGlowAccentNear, styles.hudCoreAccent]}
            />
            <NeonPulse
              d={paths.inner}
              mask={`url(#${uid}mb)`}
              uid={uid}
              tints={[styles.hudGlowCoolWide, styles.hudGlowCoolFar, styles.hudGlowCoolNear, styles.hudCoreCool]}
            />
          </>
        ) : null}
      </svg>
    </>
  )
}

function Blur({ id, sigma }: { id: string; sigma: number }) {
  return (
    <filter id={id} x="-10%" y="-25%" width="120%" height="150%" colorInterpolationFilters="sRGB">
      <feGaussianBlur stdDeviation={sigma} />
    </filter>
  )
}

/**
 * The moving window one pulse is seen through.
 *
 * `phase` is served by a negative `animation-delay`: the two bands share one
 * keyframe pair and are told apart only by how far into it they start, which
 * is why the delay is per-band and the animation is not. `rate` is served
 * from script for the reason `SCAN_RATE` gives — it is the one property of
 * this animation that cannot be restated in CSS without moving the phase.
 */
function PulseMask({
  id,
  d,
  phase,
  rate,
  blur,
  box,
}: {
  id: string
  d: string
  phase: number
  rate: number
  blur: string
  box: { w: number; h: number }
}) {
  const bandRef = usePlaybackRate(rate)
  return (
    <mask
      id={id}
      maskUnits="userSpaceOnUse"
      x={-BAND}
      y={-BAND}
      width={box.w + BAND * 2}
      height={box.h + BAND * 2}
    >
      <path
        ref={bandRef}
        className={styles.hudBand}
        d={d}
        pathLength={1}
        strokeWidth={BAND}
        strokeDasharray={`${COMET} ${1 - COMET}`}
        style={{ animationDelay: `${(-phase * LOOP_S).toFixed(2)}s` }}
        filter={blur}
      />
    </mask>
  )
}

/**
 * Runs the element's CSS animations at `rate`, without disturbing where
 * they are.
 *
 * Setting `playbackRate` holds the animation's current time and moves its
 * start time under it, which is exactly the property this needs: the pulse
 * carries on from the point on the frame it had reached rather than
 * restarting or jumping. Nothing else here touches the animation — it is
 * still the stylesheet's `hudChase`, still 40s, still offset by this band's
 * own delay.
 *
 * The rate is applied on a frame rather than immediately because a CSS
 * animation does not exist until the style that declares it has been
 * resolved, which on a fresh mount can be after this effect runs. A couple
 * of retries and then it gives up: a browser with no Web Animations API,
 * or a rule that took the animation off entirely (reduced motion pauses it
 * rather than removing it, so that case still resolves), keeps the rate the
 * stylesheet gave it, which is the resting one.
 */
function usePlaybackRate(rate: number) {
  const ref = useRef<SVGPathElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof el.getAnimations !== 'function') return

    let frame = 0
    let tries = 0
    const apply = () => {
      const running = el.getAnimations()
      if (running.length > 0) {
        for (const animation of running) animation.playbackRate = rate
        return
      }
      if (tries++ < 3) frame = requestAnimationFrame(apply)
    }

    apply()
    return () => cancelAnimationFrame(frame)
  }, [rate])

  return ref
}

function NeonPulse({
  d,
  mask,
  uid,
  tints,
}: {
  d: string
  mask: string
  uid: string
  tints: [string, string, string, string]
}) {
  const [wide, far, near, core] = tints
  return (
    <g mask={mask}>
      <path className={`${styles.hudGlowWide} ${wide}`} d={d} filter={`url(#${uid}wide)`} />
      <path className={`${styles.hudGlowFar} ${far}`} d={d} filter={`url(#${uid}far)`} />
      <path className={`${styles.hudGlowNear} ${near}`} d={d} filter={`url(#${uid}near)`} />
      <path className={`${styles.hudCore} ${core}`} d={d} />
    </g>
  )
}

function buildHudPaths(w: number, h: number): { outer: string; inner: string } {
  const cut = Math.min(w * 0.055, h * 0.2, 22)
  const outerR = Math.min(5, cut * 0.22)
  const gap = Math.min(6.5, h * 0.05)
  const depth = Math.min(8, Math.max(5.5, h * 0.052))
  const longHalf = Math.min(64, (w - 2 * cut) * 0.2)
  const shortHalf = Math.min(18, Math.max(12, (h - 2 * cut) * 0.44))

  const outer = polyPath(octagon(w, h, cut, 1).map((p) => ({ p, r: outerR })))
  const inner = polyPath(notchedOctagon(w, h, cut, gap, depth, longHalf, shortHalf, outerR * 0.7))
  return { outer, inner }
}

function octagon(w: number, h: number, cut: number, inset: number): Pt[] {
  const g = inset
  return [
    [cut, g],
    [w - cut, g],
    [w - g, cut],
    [w - g, h - cut],
    [w - cut, h - g],
    [cut, h - g],
    [g, h - cut],
    [g, cut],
  ]
}

function notchedOctagon(
  w: number,
  h: number,
  cut: number,
  inset: number,
  depth: number,
  longHalf: number,
  shortHalf: number,
  cornerR: number,
): Vert[] {
  const verts = octagon(w, h, cut, inset)
  const out: Vert[] = []
  for (let i = 0; i < 8; i++) {
    const a = verts[i]
    const b = verts[(i + 1) % 8]
    if (i % 2 === 1) {
      out.push({ p: a, r: cornerR })
      continue
    }
    const half = i === 0 || i === 4 ? longHalf : shortHalf
    out.push({ p: a, r: cornerR })
    for (const p of notch(a, b, half, depth)) out.push({ p, r: 0 })
  }
  return out
}

/**
 * Trapezoid dip toward the interior of a clockwise edge: two slanted walls
 * down to a flat floor, rather than a single point.
 *
 * The lean comes from the depth, not from the opening. With the walls set
 * to a share of the opening instead, the notch angle changed with the
 * notch's width: the long top and bottom dips are several times wider than
 * the side ones at the same depth, so they came out as shallow ramps while
 * the short ones stood up straight. Tying the run to the depth gives every
 * notch on the frame the same wall, and the extra width goes to the floor,
 * which is where a wider trapezoid should put it.
 */
function notch(a: Pt, b: Pt, halfW: number, depth: number): Pt[] {
  const ab = sub(b, a)
  const len = mag(ab)
  const tangent = scale(ab, 1 / len)
  const inward: Pt = [-tangent[1], tangent[0]]
  const mid = add(a, scale(ab, 0.5))
  const open = Math.min(halfW, len * 0.3)
  const wall = Math.min(depth * WALL_SLANT, open * 0.5)
  const floor = open - wall
  const down = scale(inward, depth)
  return [
    add(mid, scale(tangent, -open)),
    add(add(mid, scale(tangent, -floor)), down),
    add(add(mid, scale(tangent, floor)), down),
    add(mid, scale(tangent, open)),
  ]
}

function polyPath(verts: Vert[]): string {
  const n = verts.length
  const cmds: string[] = []
  for (let i = 0; i < n; i++) {
    const prev = verts[(i + n - 1) % n].p
    const cur = verts[i]
    const next = verts[(i + 1) % n].p
    const r = Math.min(cur.r, mag(sub(cur.p, prev)) * 0.42, mag(sub(next, cur.p)) * 0.42)
    if (r < 0.2) {
      cmds.push(i === 0 ? `M${fmt(cur.p)}` : `L${fmt(cur.p)}`)
      continue
    }
    const start = sub(cur.p, scale(normalize(sub(cur.p, prev)), r))
    const end = add(cur.p, scale(normalize(sub(next, cur.p)), r))
    cmds.push(i === 0 ? `M${fmt(start)}` : `L${fmt(start)}`)
    cmds.push(`Q${fmt(cur.p)} ${fmt(end)}`)
  }
  cmds.push('Z')
  return cmds.join('')
}

function add(a: Pt, b: Pt): Pt {
  return [a[0] + b[0], a[1] + b[1]]
}

function sub(a: Pt, b: Pt): Pt {
  return [a[0] - b[0], a[1] - b[1]]
}

function scale(a: Pt, s: number): Pt {
  return [a[0] * s, a[1] * s]
}

function mag(a: Pt): number {
  return Math.hypot(a[0], a[1]) || 1
}

function normalize(a: Pt): Pt {
  const length = mag(a)
  return [a[0] / length, a[1] / length]
}

function fmt(p: Pt): string {
  return `${p[0].toFixed(2)},${p[1].toFixed(2)}`
}

/*
 * `live` is the only thing this frame reads, and it changes once per
 * operation — but the console around it re-renders with the countdown, four
 * times a second. Memoised, the octagon geometry, the masks and the filter
 * definitions are built when the panel is resized and at no other time.
 */
export const CommandHudFrame = memo(CommandHudFrameView)
