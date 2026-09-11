import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import { animate, AnimatePresence, motion, useSpring } from 'motion/react'
import { BusySweep } from '../../motion/BusySweep'
import { prefersReducedMotion } from '../../motion/prefersReducedMotion'
import { formatClaimFigure } from '../../utils/format'
import { CrosshairIcon } from './CommandIcons'
import styles from './CommandRail.module.css'

export const RAIL_LAYOUT = { type: 'spring', stiffness: 380, damping: 36, mass: 0.65 } as const
export const RAIL_LAYOUT_OFF = { duration: 0 } as const

export function railLayout() {
  return prefersReducedMotion() ? RAIL_LAYOUT_OFF : RAIL_LAYOUT
}

/**
 * ТЗ §4.4-§4.5 — every state the primary control can be in, in the order it
 * moves through them: nothing picked, armed, going out, gone, and then the
 * two verdicts and the payout that follows one of them.
 */
export type CtaKind = 'idle' | 'ready' | 'firing' | 'fired' | 'won' | 'lost' | 'claim' | 'claimed' | 'reveal'

/**
 * The kinds that still belong to *aiming*, and so keep the crosshair.
 *
 * A verdict and a payout are not aim, and the diagram is explicit about it:
 * INTERCEPTED, ROUND LOST, CLAIM and CLAIMED carry a trailing mark instead
 * of a leading sight, because by then there is nothing left to point at.
 */
const AIMING: readonly CtaKind[] = ['idle', 'ready', 'firing', 'fired', 'reveal']

export function RailPot({
  value,
  labelled,
  caption = 'Pool',
  hint,
}: {
  value: number
  labelled: string
  caption?: string
  /** The long form of `caption`, on hover. Used for a claim's own wording. */
  hint?: string
}) {
  const shown = useTrend(value)
  const pulse = usePulse(value)
  const reduce = prefersReducedMotion()

  return (
    <div className={styles.pot} title={hint} data-hint={hint ? 'true' : undefined}>
      {/*
        The instrument window's own marks: a rule down the left edge and a
        chamfer out of the opposite corner. Between them they say "readout"
        in a way neither the buttons (a closed contour) nor a message (no
        edge at all) can be mistaken for.
      */}
      <span className={styles.potRule} aria-hidden="true" />
      {/*
        The sweep. One pass of light across the glass every eight seconds —
        Motion drives it because it is a pure `x` tween on a single element,
        which is the one shape the browser can own outright, and because a
        `repeatDelay` is how you say "rarely" without a keyframe track that
        is 90% empty.
      */}
      {reduce ? null : (
        <motion.span
          className={styles.potSweep}
          aria-hidden="true"
          initial={{ x: '-160%' }}
          animate={{ x: '160%' }}
          transition={{ duration: 1.5, ease: 'easeInOut', repeat: Infinity, repeatDelay: 6.5 }}
        />
      )}
      <span className={styles.meta}>{caption}</span>
      <strong className={styles.potValue} aria-label={labelled} data-pulse={pulse ? 'on' : 'off'}>
        <span className={styles.amount}>{formatClaimFigure(shown)}</span>
        <span className={styles.ticker}>ETH</span>
        {pulse && !reduce ? (
          <motion.span
            className={styles.potPulse}
            initial={{ opacity: 0.7, scale: 0.92 }}
            animate={{ opacity: 0, scale: 1.12 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
          />
        ) : null}
      </strong>
    </div>
  )
}

export function RailRecon({
  remaining,
  max,
  disabled,
  scanning,
  cooldown,
  title,
  describedBy,
  busy,
  onClick,
  invite = true,
}: {
  remaining: number
  max: number
  disabled: boolean
  scanning: boolean
  cooldown: string | null
  title?: string
  describedBy?: string
  busy: boolean
  onClick: () => void
  /**
   * Whether this module is the one asking to be pressed.
   *
   * False once a Defense Point is staged: INTERCEPT is then the verb, and
   * a pulse on both controls at once is two invitations for one action.
   */
  invite?: boolean
}) {
  const reduce = prefersReducedMotion()
  const count = useTrend(remaining)
  const digits = String(Math.max(0, Math.round(count))).padStart(2, '0')
  const flash = useReconFlash(scanning, remaining)
  const verb =
    cooldown ?? (scanning ? 'Scanning' : flash === 'plus' ? '+1 Recon' : flash === 'ready' ? 'Recon ready' : 'Get Recon')
  /*
   * ТЗ §4.2 — the module is a compact glyph-and-count at rest and opens to
   * the right only when it has something to say: a hover, a scan, a
   * cooldown, or the beat after a probe lands. Hover is deliberately *not*
   * in this flag — it is a pure CSS state on the button, so opening on
   * pointer does not cost a React render per module.
   */
  const open = scanning || Boolean(cooldown) || flash !== null
  const live = invite && !disabled && !scanning && !cooldown

  return (
    <div className={styles.reconWrap} data-guide="recon">
      <motion.button
        type="button"
        className={styles.recon}
        data-scanning={scanning ? 'true' : 'false'}
        data-live={live ? 'true' : 'false'}
        data-open={open ? 'true' : 'false'}
        data-cooldown={cooldown ? 'true' : 'false'}
        data-flash={flash === 'plus' ? 'true' : 'false'}
        onClick={onClick}
        disabled={disabled}
        title={title}
        aria-label="Get Recon"
        aria-disabled={disabled}
        aria-describedby={describedBy}
        whileHover={reduce || disabled || !finePointer() ? undefined : { y: -1 }}
        whileTap={reduce || disabled ? undefined : { y: 1 }}
      >
        <span className="visually-hidden">Recon</span>
        <span className="visually-hidden">
          {remaining} / {max}
        </span>
        {/*
          The verb comes *first*, and that is a layout decision rather than a
          reading order.
          
          The module is anchored to the right, against INTERCEPT, so the
          room it has to grow into is on its left. Putting the line ahead of
          the glyph means the words arrive in that room and the count never
          moves: the two characters a player is tracking stay exactly where
          they were when the module was shut.
        */}
        <span className={styles.reconVerbSlot}>
          <span className={styles.reconVerb} aria-hidden={open ? undefined : true}>
            {verb}
            {scanning && !reduce ? <RailDots /> : null}
          </span>
        </span>
        {/*
          The glyph and the count are always rendered, and the stylesheet
          decides whether the cooldown line replaces them or stands beside
          them. It has to be that way round: on a phone the module is at its
          most compact (ТЗ §6) and the line does not fit at all, so what is
          shown there is the count — and a component cannot know how wide
          the rail it landed in is, while a container query can.
        */}
        <DiamondIcon className={styles.reconDiamond} />
        <span className={styles.reconCount}>{digits}</span>
        {busy && !cooldown && !reduce ? <span className={styles.reconScan} /> : null}
      </motion.button>
    </div>
  )
}

export function RailCta({
  label,
  kind,
  disabled,
  busy,
  onClick,
  title,
  describedBy,
}: {
  label: string
  kind: CtaKind
  disabled: boolean
  busy: boolean
  onClick: () => void
  title?: string
  describedBy?: string
}) {
  const reduce = prefersReducedMotion()
  const magnet = kind === 'ready' || kind === 'reveal' || kind === 'claim'
  const pull = useMagnetic(magnet && !disabled)
  const quiet = kind === 'fired' || kind === 'claimed' || kind === 'won' || kind === 'lost'
  /*
   * FIRING's dashed trail, and the same trail on any wait that occupies
   * this slot: Decoding, Revealing, Claiming. A wait without it used to
   * look like a dead control; the dashes are the one signal that work is
   * moving.
   */
  const showTrail = kind === 'firing' || (busy && (kind === 'reveal' || kind === 'claim'))

  return (
    <span className={styles.ctaWrap} data-guide="intercept">
      <motion.button
        layoutId="command-cta"
        type="button"
        className={styles.cta}
        data-kind={kind}
        data-quiet={quiet ? 'true' : 'false'}
        style={{ x: pull.x, y: pull.y }}
        transition={railLayout()}
        onClick={onClick}
        disabled={disabled}
        aria-busy={busy}
        aria-label={kind === 'claimed' ? 'Claimed' : kind === 'claim' ? 'Claim' : undefined}
        title={title}
        aria-describedby={describedBy}
        onPointerMove={pull.onMove}
        onPointerLeave={pull.onLeave}
        whileHover={reduce || disabled || quiet || !finePointer() ? undefined : { y: -1 }}
        whileTap={reduce || disabled || quiet ? undefined : { y: 2 }}
      >
        {AIMING.includes(kind) ? (
          <span className={styles.ctaIconWrap} aria-hidden="true">
            <CrosshairIcon className={styles.ctaIcon} />
          </span>
        ) : null}
        <span className={styles.ctaCopy}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={label}
              className={styles.ctaLabel}
              initial={reduce ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? undefined : { opacity: 0, y: -6 }}
              transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
            >
              {label}
            </motion.span>
          </AnimatePresence>
        </span>
        <CtaMark kind={kind} busy={busy} />
        {showTrail ? <FireTrail /> : null}
        {busy ? <BusySweep /> : null}
      </motion.button>
    </span>
  )
}

/**
 * The trailing mark (ТЗ §4.4-§4.5): the tick that says the shot left, the
 * arrow that says there is money to take, the dots while it is being taken,
 * and the cross on a round that is over.
 */
function CtaMark({ kind, busy }: { kind: CtaKind; busy: boolean }) {
  if (kind === 'claim' && busy) {
    return (
      <span className={styles.ctaMark} aria-hidden="true">
        <RailDots />
      </span>
    )
  }

  const glyph =
    kind === 'fired' || kind === 'claimed' ? (
      <CheckIcon className={styles.ctaMarkIcon} />
    ) : kind === 'claim' ? (
      <ArrowIcon className={styles.ctaMarkIcon} />
    ) : kind === 'lost' ? (
      <CrossIcon className={styles.ctaMarkIcon} />
    ) : null

  if (!glyph) return null
  return (
    <span className={styles.ctaMark} aria-hidden="true">
      {glyph}
    </span>
  )
}

/**
 * The failure, as a *signal* rather than as an object.
 *
 * Every other thing on this rail is a control, and every control wears the
 * same chassis: a 1px contour, a 12px radius, a surface with a top
 * highlight. A message in that chassis is a button that cannot be pressed,
 * which is the one thing an error must never look like — the player's next
 * move is to press something, and a dead lookalike sends them at the wrong
 * target.
 *
 * So this has no edge at all. It is a red bloom over the row whose own
 * light falls off to nothing and a hairline that fades at both ends — the
 * panel's own vocabulary (ТЗ §3: light is feedback), spent on the one state
 * that has no control of its own. It is also inert, so the button
 * underneath still takes the retry.
 *
 * Enter and exit are spring-driven through `AnimatePresence`, which is the
 * idiom Motion's own notification examples use: physical properties on a
 * spring, opacity and blur on short tweens beside it.
 */
export function RailAlert({ message }: { message: string | null }) {
  const reduce = prefersReducedMotion()

  return (
    <div className={styles.alertLayer}>
      <AnimatePresence initial={false}>
        {message ? (
          <motion.p
            key={message}
            className={styles.alert}
            role="alert"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.96, filter: 'blur(5px)' }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.98, filter: 'blur(5px)' }}
            transition={
              reduce
                ? { duration: 0 }
                : {
                    type: 'spring',
                    stiffness: 420,
                    damping: 34,
                    mass: 0.6,
                    opacity: { duration: 0.18, ease: 'easeOut' },
                    filter: { duration: 0.24, ease: 'easeOut' },
                  }
            }
          >
            <span className={styles.alertText}>{message}</span>
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

export function RailAtmosphere() {
  return (
    <div className={styles.well} aria-hidden="true">
      <div className={styles.wellWash} />
      <div className={styles.wellShade} />
      {/* ТЗ §3 — the second surface: the inner layer sits a shade lighter
          than the shell, which is where the panel's depth comes from now
          that there is no bevel and no texture to get it from. */}
      <div className={styles.wellInner} />
    </div>
  )
}

export function RailTrace({
  hostRef,
  pulse,
  outline = null,
}: {
  hostRef: RefObject<HTMLDivElement | null>
  pulse: number
  /** The Earth silhouette, when the rail has one. Otherwise: the capsule. */
  outline?: string | null
}) {
  const [slice, setSlice] = useState({ width: 0, height: 0, stroke: '' })

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return

    const draw = () => {
      const box = host.getBoundingClientRect()
      const width = Math.round(box.width) || host.offsetWidth
      const height = Math.round(box.height) || host.offsetHeight
      if (width < 8 || height < 8) return
      setSlice({ width, height, stroke: outline ?? railPerimeterPath(width, height) })
    }

    draw()
    const ResizeObs = typeof ResizeObserver === 'undefined' ? null : ResizeObserver
    const ro = ResizeObs ? new ResizeObs(draw) : null
    if (ro) ro.observe(host)
    return () => ro?.disconnect()
  }, [hostRef, outline])

  const reduce = prefersReducedMotion()
  if (!slice.stroke) return null

  return (
    <svg className={styles.trace} aria-hidden="true" viewBox={`0 0 ${slice.width} ${slice.height}`}>
      <path d={slice.stroke} className={styles.tracePath} />
      <path d={slice.stroke} className={styles.rimGlow} />
      {/* ТЗ §5 — Perimeter Ambient: one slow pass of light around the whole
          capsule every several seconds, so a rail nobody is touching still
          reads as powered rather than as a screenshot. */}
      {reduce ? null : <path d={slice.stroke} className={styles.traceAmbient} />}
      {pulse > 0 && !reduce ? <path d={slice.stroke} className={styles.tracePulse} /> : null}
    </svg>
  )
}

/**
 * The rail's silhouette, taken from the planet it sits in.
 *
 * The Command Rail is not a card floating over the scene: it is the bottom
 * of Earth. It spans exactly the globe's width where it crosses the fold,
 * its two ends follow the curve of the limb, and its lower edge is the
 * bottom of the viewport. Nothing about that can be written in CSS, because
 * the globe's radius is `clamp(320px, 46vw, 680px)` and the chord it cuts
 * at the rail's height is a function of both that and the rail's own box.
 *
 * So it is measured. `[data-earth="globe"]` is the handle (see
 * `EarthSphere`), and the arithmetic below is one circle:
 *
 *   half-width at viewport row y  =  √(r² − (y − cy)²)
 *
 * evaluated across the rail's height. The wider reading (the bottom row)
 * gives the rail its box; the narrower one (the top row) gives the inset
 * the copy has to start after, so no label is ever printed on top of the
 * curve.
 */
export type RailSilhouette = {
  /** The rail's box, in the dock's own coordinates. */
  left: number
  width: number
  /** The outline, in the rail's own box — for `clip-path` and for the trace. */
  path: string
  /** How far in from each end the row must start to clear the arc. */
  inset: number
}

/**
 * Below this the arc stops being a silhouette and starts being a keyhole.
 * The globe is 46vw, so a 1512px window lends the rail 666px and a phone
 * lends it 256 — and four modules, one of which has to be able to print
 * NEXT RECON · 2 BLOCKS, do not live in 256. The floor is the narrowest row
 * the compact container steps in the stylesheet are known to survive; under
 * it the rail falls back to the plain capsule ТЗ §1 describes, at the width
 * the viewport can give it.
 */
const MIN_ARC_WIDTH = 460

/** Segments per curved end. Twenty-four is invisible from a straight line. */
const ARC_STEPS = 24

/**
 * Where the row actually starts, measured down from the rail's top edge.
 *
 * The copy is centred in the capsule, not pressed against its ceiling, so
 * the inset it needs is the arc's run over the *content's* span rather than
 * over the full 72px. Twelve pixels back from the top is worth a dozen
 * pixels of row on each side — which, on a rail this narrow, is a word.
 */
const CONTENT_INSET_Y = 12

export function useEarthSilhouette(
  dockRef: RefObject<HTMLElement | null>,
  railRef: RefObject<HTMLElement | null>,
): RailSilhouette | null {
  const [shape, setShape] = useState<RailSilhouette | null>(null)

  useLayoutEffect(() => {
    const dock = dockRef.current
    const rail = railRef.current
    if (!dock || !rail) return

    let frame = 0
    /*
     * Two boxes, because they are not the same box. The rows the circle has
     * to be sampled at are the *rail's* — on a phone the dock carries the
     * home-indicator inset as padding and the rail sits above it — while
     * the horizontal origin is the dock's, since `left` is set against it.
     *
     * Reading the rail's own rect to compute the rail's own width does not
     * loop: only its top and bottom are used, and those come from the
     * stylesheet, not from the answer.
     */
    const measure = () => {
      frame = 0
      const globe = document.querySelector('[data-earth="globe"]')
      const box = rail.getBoundingClientRect()
      const origin = dock.getBoundingClientRect().left
      const next = globe ? earthSilhouette(box, origin, globe.getBoundingClientRect()) : null
      setShape((prev) => (sameShape(prev, next) ? prev : next))
    }

    /*
     * Coalesced to a frame. Both observers below can fire in the same tick
     * as a window resize, and the measurement reads layout — doing it three
     * times for one resize is three forced reflows for one answer.
     */
    const schedule = () => {
      if (frame) return
      frame = requestAnimationFrame(measure)
    }

    measure()
    const ResizeObs = typeof ResizeObserver === 'undefined' ? null : ResizeObserver
    const ro = ResizeObs ? new ResizeObs(schedule) : null
    if (ro) {
      ro.observe(rail)
      const globe = document.querySelector('[data-earth="globe"]')
      if (globe) ro.observe(globe)
    }
    window.addEventListener('resize', schedule)
    /*
     * Scroll matters as much as resize here: the rail is fixed to the
     * viewport and the planet is not, so a page that scrolls at all slides
     * the globe out from under a shape cut to fit it. Passive, coalesced to
     * a frame, and on a screen that does not scroll it never fires.
     */
    window.addEventListener('scroll', schedule, { passive: true })
    return () => {
      if (frame) cancelAnimationFrame(frame)
      ro?.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule)
    }
  }, [dockRef, railRef])

  return shape
}

/** The circle, the chord, and the outline it implies. Pure — hence testable. */
export function earthSilhouette(
  dock: DOMRectReadOnly | DOMRect,
  originX: number,
  globe: DOMRectReadOnly | DOMRect,
): RailSilhouette | null {
  const r = globe.width / 2
  const cx = globe.left + globe.width / 2
  const cy = globe.top + globe.height / 2
  const height = dock.height
  if (r < 1 || height < 1) return null

  const halfAt = (y: number) => {
    const dy = y - cy
    const inside = r * r - dy * dy
    return inside > 0 ? Math.sqrt(inside) : 0
  }

  const wide = halfAt(dock.bottom)
  const narrow = halfAt(dock.top)
  const copyEdge = halfAt(dock.top + CONTENT_INSET_Y)

  /*
   * Three ways the planet can refuse to lend a shape, and all three mean
   * the same fallback rather than a squeezed one:
   *
   *   - it is not on screen, or is too small to hold the row;
   *   - the rail is not inside its lower half, so the ends would flare
   *     outwards instead of tucking in;
   *   - the globe is so large the arc across 72px is imperceptible — then
   *     the capsule is the honest drawing of the same edge.
   */
  if (narrow * 2 < MIN_ARC_WIDTH) return null
  if (narrow >= wide) return null

  const steps = ARC_STEPS
  const points: string[] = []
  const at = (i: number) => {
    const y = dock.top + (height * i) / steps
    return { half: halfAt(y), y: y - dock.top }
  }

  // Clockwise: the top edge, down the right limb, back along the bottom,
  // up the left limb.
  points.push(`M${(wide - narrow).toFixed(2)} 0`)
  points.push(`L${(wide + narrow).toFixed(2)} 0`)
  for (let i = 1; i <= steps; i += 1) {
    const p = at(i)
    points.push(`L${(wide + p.half).toFixed(2)} ${p.y.toFixed(2)}`)
  }
  for (let i = steps; i >= 0; i -= 1) {
    const p = at(i)
    points.push(`L${(wide - p.half).toFixed(2)} ${p.y.toFixed(2)}`)
  }
  points.push('Z')

  return {
    left: cx - wide - originX,
    width: wide * 2,
    path: points.join(' '),
    inset: Math.max(0, wide - copyEdge),
  }
}

function sameShape(a: RailSilhouette | null, b: RailSilhouette | null): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a.left - b.left) < 0.5 && Math.abs(a.width - b.width) < 0.5 && a.path === b.path
}

/**
 * Segmented rounded-rect perimeter — the rail's global feedback layer.
 *
 * The radius is the capsule's (ТЗ §1: 32px), clamped to half the shorter
 * side so the path stays a legal rounded rect at any size the rail is given.
 */
export function railPerimeterPath(width: number, height: number): string {
  const p = 1.4
  const r = Math.min(32, (width - p * 2) / 2, (height - p * 2) / 2)
  const x = p
  const y = p
  const w = width - p * 2
  const h = height - p * 2
  return [
    `M${(x + r).toFixed(2)} ${y.toFixed(2)}`,
    `H${(x + w - r).toFixed(2)}`,
    `A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${(x + w).toFixed(2)} ${(y + r).toFixed(2)}`,
    `V${(y + h - r).toFixed(2)}`,
    `A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${(x + w - r).toFixed(2)} ${(y + h).toFixed(2)}`,
    `H${(x + r).toFixed(2)}`,
    `A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${x.toFixed(2)} ${(y + h - r).toFixed(2)}`,
    `V${(y + r).toFixed(2)}`,
    `A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${(x + r).toFixed(2)} ${y.toFixed(2)}`,
  ].join(' ')
}

/** Three beats of progress, for the two waits that are not a sweep. */
function RailDots() {
  return (
    <span className={styles.dots} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

function DiamondIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 12 12" aria-hidden="true">
      <path d="M6 1.15 L10.85 6 L6 10.85 L1.15 6 Z" fill="none" stroke="currentColor" strokeWidth="1.15" />
    </svg>
  )
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.2" opacity="0.55" />
      <path d="M5.2 8.2 L7.2 10.2 L10.9 5.9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function CrossIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.4 5.4 L10.6 10.6 M10.6 5.4 L5.4 10.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function ArrowIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M2.6 8h10.2 M9.2 4.6 L12.9 8 L9.2 11.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * The trail under FIRING: dashes running the full width of the button,
 * along its bottom edge, while the transaction is out.
 *
 * The dashes *move*; the line does not grow. That distinction is the whole
 * fix. This used to animate Motion's `pathLength`, and `pathLength` is
 * implemented by writing `stroke-dasharray` — so it silently overwrote the
 * `5 6` pattern beside it and drew one solid segment extending from 0 to
 * 100% and snapping back. Caught at any instant that is a line that stops
 * short of the right-hand edge, which is exactly what it looked like.
 *
 * A fixed dash pattern with a travelling offset occupies the full span at
 * every frame, so there is no moment at which the trail appears cut. It is
 * a CSS animation on one property the compositor owns, which is also how
 * the rest of this panel's ambient motion is drawn.
 *
 * The box is two units tall and the line sits on unit 1 because the CSS
 * pins it 2px high at the very bottom of the button: with
 * `preserveAspectRatio="none"` the vertical scale is then exactly 1, which
 * is what keeps a 1.3 stroke rendering as 1.3px instead of being squashed
 * with the box. The dash figures are scaled to match the wider span — see
 * `.fireTrailPath`.
 */
function FireTrail() {
  return (
    <svg className={styles.fireTrail} viewBox="0 0 100 2" preserveAspectRatio="none" aria-hidden="true" data-trail="">
      <path
        className={styles.fireTrailPath}
        d="M0 1 L100 1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeDasharray="3.6 4.32"
      />
    </svg>
  )
}

function useMagnetic(enabled: boolean) {
  const x = useSpring(0, { stiffness: 240, damping: 26, mass: 0.32 })
  const y = useSpring(0, { stiffness: 240, damping: 26, mass: 0.32 })

  const onMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || !finePointer()) return
    const box = event.currentTarget.getBoundingClientRect()
    const dx = (event.clientX - (box.left + box.width / 2)) / Math.max(box.width / 2, 1)
    const dy = (event.clientY - (box.top + box.height / 2)) / Math.max(box.height / 2, 1)
    x.set(dx * 3)
    y.set(dy * 2)
  }

  const onLeave = () => {
    x.set(0)
    y.set(0)
  }

  return { x, y, onMove, onLeave }
}

function finePointer(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches
  )
}

function useTrend(value: number): number {
  const [shown, setShown] = useState(value)
  const fromRef = useRef(value)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      fromRef.current = value
      setShown(value)
      return
    }
    if (fromRef.current === value || prefersReducedMotion()) {
      fromRef.current = value
      setShown(value)
      return
    }
    const from = fromRef.current
    const controls = animate(from, value, {
      type: 'spring',
      stiffness: 220,
      damping: 28,
      onUpdate: (next) => {
        fromRef.current = next
        setShown(next)
      },
    })
    return () => controls.stop()
  }, [value])

  return shown
}

function usePulse(value: number): boolean {
  const [on, setOn] = useState(false)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (prefersReducedMotion()) return
    setOn(true)
    // ТЗ §4.1 — 300ms. Long enough to register as a change to the figure,
    // short enough that a pot ticking several times a minute does not turn
    // the rail into a strobe.
    const id = window.setTimeout(() => setOn(false), 300)
    return () => window.clearTimeout(id)
  }, [value])

  return on
}

function useReconFlash(scanning: boolean, remaining: number): 'plus' | 'ready' | null {
  const [phase, setPhase] = useState<'plus' | 'ready' | null>(null)
  const wasScanning = useRef(scanning)
  const remainingRef = useRef(remaining)

  useEffect(() => {
    const finished = wasScanning.current && !scanning
    wasScanning.current = scanning
    remainingRef.current = remaining
    if (!finished || prefersReducedMotion()) {
      if (scanning) setPhase(null)
      return
    }
    setPhase('plus')
    const ready = window.setTimeout(() => setPhase('ready'), 420)
    const clear = window.setTimeout(() => setPhase(null), 980)
    return () => {
      window.clearTimeout(ready)
      window.clearTimeout(clear)
    }
  }, [scanning, remaining])

  return phase
}
