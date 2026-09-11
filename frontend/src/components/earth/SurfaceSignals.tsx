import { useEffect, useRef } from 'react'
import { prefersReducedMotion } from '../../motion/prefersReducedMotion'
import { SIGNALS_WAKE } from '../../motion/timeline'
import { useBootEntrance } from '../../motion/useBootEntrance'
import styles from './SurfaceSignals.module.css'

/**
 * One decorative marker on the planet's face.
 *
 * Coordinates are the disc's own 100×100 space: centre (50, 50), radius 50.
 * Only the top ~40% of that circle is ever on screen — the hero globe is
 * translated most of the way below the fold — which is why every `y` here
 * sits between 8 and 36.
 */
export interface SurfaceSignal {
  x: number
  y: number
  /** Seconds for one full pulse, or 0 for a marker that just sits there. */
  period: number
  /** How far into that pulse it starts, in seconds. */
  phase: number
  /** Resting opacity, for the ones that do not pulse. */
  dim: number
  /** Cool white instead of cyan. */
  pale?: boolean
}

/*
 * The visible cap — the only part of the planet a marker can usefully sit
 * in.
 *
 * `.wrapHero` sits at `bottom: 0` and is then pushed down by 60 per cent of
 * its own height, so exactly the top 40 per cent of the globe is ever on
 * screen: in this 100x100 space, `y` from 0 to 40. Everything below is off
 * the bottom of the page, and a marker placed there is a marker nobody will
 * ever see.
 *
 * `CAP_MAX_R` is what puts them out at the limb. 47 of the disc's 50 leaves
 * them hard against the inside of the atmosphere rim rather than huddled in
 * the middle, which is the difference between a planet with instrumentation
 * on it and a planet with a patch of instrumentation in the centre.
 */
export const CAP_MIN_Y = 2.2
export const CAP_MAX_Y = 39.2
export const CAP_MAX_R = 47

/**
 * Closest two markers may ever be, in disc units. Sets the density.
 *
 * 6 rather than the 7 it was, and the difference is the whole cap: a
 * maximal Poisson-disk set leaves holes of up to twice the spacing, so at 7
 * the emptiest patch of the planet ran to ~9.6 units — wider than a marker
 * is from its neighbour, which is what made the surface read as islands of
 * instrumentation with sea between them rather than as one covered face. At
 * 6 the worst hole is ~8 and the typical one nearer 6, and the layer fills
 * the visible cap the way a readout over a whole planet should.
 */
export const SIGNAL_SPACING = 6
/** Bridson's k: how hard to try around one marker before giving up on it. */
const SIGNAL_CANDIDATES = 30
/**
 * A ceiling on the scatter, so a lucky run cannot quietly double the number
 * of DOM nodes and mesh segments on the landing page.
 *
 * Deliberately above what the sampler ever actually reaches at this spacing
 * (47-56 over hundreds of runs), because this cap is a fuse and not a
 * target: truncating a Bridson run mid-growth stops it wherever the active
 * list happened to be and leaves exactly the unfilled lobe this spacing was
 * lowered to get rid of.
 */
const MAX_SIGNALS = 64

function insideCap(x: number, y: number): boolean {
  if (y < CAP_MIN_Y || y > CAP_MAX_Y) return false
  return Math.hypot(x - 50, y - 50) <= CAP_MAX_R
}

/**
 * A fresh constellation on every page load.
 *
 * Poisson-disk sampling (Bridson): start somewhere, then repeatedly try to
 * place a new marker in the annulus between one and two spacings from an
 * existing one, keeping only candidates that are inside the cap and no
 * closer than `SIGNAL_SPACING` to anything already placed. What that buys
 * over scattering points at random is the thing the eye actually notices —
 * no two markers ever clump, no three ever line up, and the coverage is
 * even right out to the rim, every time, without anyone hand-placing a
 * table of coordinates.
 *
 * Random on purpose (and the reason the old fixed table is gone): the
 * planet forms a different pattern on every reload, so the surface reads as
 * a live readout rather than as artwork. Two clients seeing different
 * markers is fine here in a way it very deliberately is not for the globe's
 * rotation — that is `f(timestamp)` precisely so every client agrees on
 * which face of Earth is showing. These carry no information at all: no
 * lobby, probe, defence or player reaches this module, so there is nothing
 * for a player to read out of a marker's position however long they watch
 * it, and nothing for two players to disagree about.
 *
 * Bridson alone is *almost* maximal and the almost is visible: it gives up
 * on a marker after `SIGNAL_CANDIDATES` misses, so one run in twenty or so
 * abandoned a hole nearly two spacings across — a bare patch of planet
 * surrounded by instrumentation, which is the "island" this layer is not
 * supposed to have. `fillGaps` closes those, and is why the coverage is a
 * bound now rather than a tendency.
 *
 * Runs once, at module evaluation — which is once per document load, the
 * same clock the entrance runs on. A few thousand distance checks against a
 * set that never exceeds `MAX_SIGNALS`.
 */
/** How finely the cap is swept for holes, in disc units. */
const GAP_SWEEP = 1.5

/**
 * Every point the sweep is allowed to consider: the interior lattice, plus
 * the cap's own edge.
 *
 * The edge is not decoration. A lattice filtered by `insideCap` has nothing
 * *on* the boundary — the samples that would cover a rim point are the ones
 * just outside it, and those are discarded. That leaves the corners where
 * the rim meets a y-limit up to 1.97 units from the nearest candidate
 * rather than the 1.06 a half-diagonal would suggest, and the coverage
 * bound is only ever as good as the candidate set it is measured against.
 *
 * The consequence was a test that failed about one run in eight, on a
 * threshold derived from the half-diagonal alone. The threshold was right
 * about what the sweep should guarantee and wrong about what it could.
 */
function gapCandidates(): Array<{ x: number; y: number }> {
  const candidates: Array<{ x: number; y: number }> = []

  for (let y = CAP_MIN_Y; y <= CAP_MAX_Y; y += GAP_SWEEP) {
    for (let x = 0; x <= 100; x += GAP_SWEEP) {
      if (insideCap(x, y)) candidates.push({ x, y })
    }
  }

  /*
   * A hair inside the rim, not on it.
   *
   * `50 + CAP_MAX_R * Math.cos(angle)` comes back a bit over the radius —
   * 47.00000000000001 against a limit of 47 — and the cap test is an
   * inequality, so a marker placed exactly on the boundary reads as one
   * outside it. The inset is 1/4700 of the disc and moves nothing anybody
   * can see; it exists so the boundary is unambiguously in the cap.
   */
  const edgeR = CAP_MAX_R - 0.01

  // The rim arc, at the same spacing as the lattice so the boundary is
  // sampled no more coarsely than the interior.
  const arcStep = GAP_SWEEP / edgeR
  for (let angle = 0; angle < Math.PI * 2; angle += arcStep) {
    const x = 50 + edgeR * Math.cos(angle)
    const y = 50 + edgeR * Math.sin(angle)
    if (y >= CAP_MIN_Y && y <= CAP_MAX_Y) candidates.push({ x, y })
  }

  /*
   * The horizontal chords that chop the cap out of the disc — where there
   * is one to chop.
   *
   * `CAP_MIN_Y` is 2.2 and the disc only reaches y = 3, so the cap's lower
   * edge there is the arc, not a chord: the "chord" at 2.2 is a single
   * point 47.8 from the centre, outside the disc entirely. The clamp to
   * zero width kept it from throwing and let it through as a candidate,
   * which put a marker off the planet.
   */
  for (const y of [CAP_MIN_Y, CAP_MAX_Y]) {
    const halfWidth = Math.sqrt(Math.max(0, edgeR * edgeR - (y - 50) * (y - 50)))
    if (halfWidth <= 0) continue
    for (let x = 50 - halfWidth; x <= 50 + halfWidth; x += GAP_SWEEP) candidates.push({ x, y })
  }

  /*
   * One gate for all of them, interior and boundary alike.
   *
   * The boundary samples are constructed to be inside rather than tested
   * for it, and "constructed to be" is how the chord above escaped. This
   * makes the cap the single authority on what is in it, which is the same
   * rule the interior lattice was already following.
   */
  return candidates.filter((candidate) => insideCap(candidate.x, candidate.y))
}

/**
 * Whatever the walk left uncovered, covered.
 *
 * The cap is swept on a `GAP_SWEEP` lattice — plus its boundary, see
 * `gapCandidates` — and every sample that is at least a full spacing from
 * every marker becomes one. That is the same acceptance rule the walk uses,
 * so the result is still a set no two of whose members are closer than
 * `SIGNAL_SPACING`: this pass adds markers only where the walk *could* have
 * put one and happened not to.
 *
 * It is what turns coverage into a guarantee: afterwards no point of the
 * visible cap is further than a spacing plus half a lattice diagonal from a
 * marker (~7.1 units), where the walk on its own occasionally left 9.5.
 *
 * Swept in shuffled order rather than in rows, because taking the lattice
 * in reading order fills each hole from its top-left corner and leaves the
 * new markers faintly aligned with one another — the one thing the whole
 * sampler exists to avoid.
 */
function fillGaps(points: Array<{ x: number; y: number }>): void {
  const candidates = gapCandidates()

  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
  }

  for (const candidate of candidates) {
    if (points.length >= MAX_SIGNALS) return
    const clear = points.every(
      (point) => Math.hypot(point.x - candidate.x, point.y - candidate.y) >= SIGNAL_SPACING,
    )
    if (clear) points.push(candidate)
  }
}

export function scatterSignals(): SurfaceSignal[] {
  const points: Array<{ x: number; y: number }> = []
  const active: Array<{ x: number; y: number }> = []

  // Seed near the middle of the cap rather than at a random point: from
  // here the annulus walk reaches every part of the region, where a seed
  // hard against the rim can strand a lobe of it behind a thin neck.
  const seed = { x: 50, y: (CAP_MIN_Y + CAP_MAX_Y) / 2 }
  points.push(seed)
  active.push(seed)

  while (active.length > 0 && points.length < MAX_SIGNALS) {
    const index = Math.floor(Math.random() * active.length)
    const from = active[index]
    let placed = false

    for (let attempt = 0; attempt < SIGNAL_CANDIDATES; attempt++) {
      const angle = Math.random() * Math.PI * 2
      const distance = SIGNAL_SPACING * (1 + Math.random())
      const x = from.x + Math.cos(angle) * distance
      const y = from.y + Math.sin(angle) * distance
      if (!insideCap(x, y)) continue
      if (points.some((point) => Math.hypot(point.x - x, point.y - y) < SIGNAL_SPACING)) continue

      const point = { x, y }
      points.push(point)
      active.push(point)
      placed = true
      break
    }

    // Nowhere left to grow from here.
    if (!placed) active.splice(index, 1)
  }

  fillGaps(points)

  /*
   * Sorted top to bottom so the wake-up stagger reads as a scan down the
   * planet rather than as a shuffle — the markers come up in the order they
   * appear in this array (`SIGNALS_WAKE`).
   */
  points.sort((a, b) => a.y - b.y)

  return points.map((point, index) => {
    /*
     * Every other marker breathes; the rest just sit there. Alternating
     * down the sorted list rather than rolling a die per marker, because a
     * coin flip occasionally gives a run of six static ones in a row and
     * that patch of the planet visibly dies.
     *
     * The periods are all different and deliberately not multiples of each
     * other — six to eleven seconds, which never returns the set to the
     * same arrangement and never gives the eye a rhythm to lock onto.
     */
    const pulses = index % 2 === 0
    const period = pulses ? 6.1 + Math.random() * 4.9 : 0
    return {
      x: point.x,
      y: point.y,
      period,
      // A negative delay, so a marker is already mid-pulse when the page
      // opens instead of the whole layer rising together out of its dimmest
      // frame in the first second.
      phase: pulses ? Math.random() * period : 0,
      dim: 0.2 + Math.random() * 0.11,
      // The pale end of the ramp, on a fixed fraction rather than a chance,
      // so there are always a few and never a screenful.
      pale: index % 5 === 2,
    }
  })
}

const SURFACE_SIGNALS: SurfaceSignal[] = scatterSignals()

/** Side of a marker at the centre of the disc, in disc units (~1% of the diameter). */
const SIGNAL_SIZE = 1.08

/*
 * The markers, placed once at module load.
 *
 * A square near the limb is a square seen almost edge-on, so it is drawn
 * smaller: `facing` is the sphere's own z at that point — 1 in the middle
 * of the disc, 0 at the edge — and it is the one thing that keeps a flat
 * overlay from looking flat. Nothing here depends on props or on the
 * clock, so it is computed once for the module rather than per render.
 */
const SIGNAL_MARKS = SURFACE_SIGNALS.map((signal) => {
  const facing = Math.sqrt(Math.max(0, 1 - (Math.hypot(signal.x - 50, signal.y - 50) / 50) ** 2))
  const size = SIGNAL_SIZE * (0.62 + 0.38 * facing)
  return { ...signal, size, left: signal.x - size / 2, top: signal.y - size / 2 }
})

/*
 * ТЗ §22 — which markers are joined, decided once at module load.
 *
 * Each marker reaches for its three nearest neighbours and no further,
 * rather than joining everything inside a radius. A flat radius over this
 * set yields a cobweb wherever the sampler happened to place four markers
 * close together; nearest-k holds its edge count however the scatter is
 * retuned, because it is a property of each marker rather than of the
 * local density.
 *
 * Three, not the two it used to be. Two is the smallest number that draws
 * *a* mesh and it is not enough to draw a *continuous* one: a nearest-two
 * graph is mostly short chains, so the picture broke into small joined
 * clumps with unlinked water between them — the same "separate islands" the
 * spacing above is about, drawn in lines instead of squares. Three is the
 * point where the segments close into a web that carries across the cap and
 * is still nowhere near a cobweb (~90 segments over ~52 markers, under two
 * per marker, because most of them are reciprocal).
 *
 * And then `bridgeIslands` guarantees what nearest-k only tends to: a graph
 * built from local rules can still come apart into pieces, roughly one run
 * in twenty here, and the run it happens on is the one somebody screenshots.
 * The pass walks the components and joins the closest pair of markers
 * across each break, so the mesh is one web on every load rather than on
 * most of them.
 *
 * Static because the pairs are static: the markers only ever move a couple
 * of units under the cursor, nowhere near enough to make a new neighbour.
 * Recomputing the graph every frame would be the expensive half of this
 * effect and would buy a connection flickering into existence as a square
 * drifts past a threshold.
 */
const LINK_RADIUS = 11
const LINK_NEIGHBOURS = 3

export interface Link {
  from: number
  to: number
}

/** The nearest-k graph, before it is checked for being in one piece. */
export function nearestLinks(marks: Array<{ x: number; y: number }>): Map<string, Link> {
  const pairs = new Map<string, Link>()
  marks.forEach((mark, i) => {
    marks
      .map((other, j) => ({ j, distance: Math.hypot(other.x - mark.x, other.y - mark.y) }))
      .filter((candidate) => candidate.j !== i && candidate.distance <= LINK_RADIUS)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, LINK_NEIGHBOURS)
      .forEach(({ j }) => {
        const from = Math.min(i, j)
        const to = Math.max(i, j)
        pairs.set(`${from}-${to}`, { from, to })
      })
  })
  return pairs
}

/**
 * Whatever the nearest-k rule left in separate pieces, joined at its
 * narrowest point.
 *
 * Union-find over the edges gives the pieces; each pass then bridges the
 * component holding marker 0 to whichever marker outside it is closest to
 * it, which both keeps the new segment as short as any that exist and
 * cannot cross the whole planet. It repeats until one piece is left. At
 * ~52 markers and rarely more than one break, that is a few thousand
 * distance checks once, at module load.
 *
 * `LINK_RADIUS` deliberately does not apply here: a bridge exists precisely
 * because nothing inside the radius was available, and a mesh in two halves
 * is a worse picture than one long segment.
 */
export function bridgeIslands(marks: Array<{ x: number; y: number }>, pairs: Map<string, Link>): void {
  const parent = marks.map((_, i) => i)
  const find = (a: number): number => {
    let root = a
    while (parent[root] !== root) root = parent[root]
    while (parent[a] !== root) {
      const next = parent[a]
      parent[a] = root
      a = next
    }
    return root
  }
  const union = (a: number, b: number): boolean => {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return false
    parent[ra] = rb
    return true
  }

  for (const link of pairs.values()) union(link.from, link.to)

  // One bridge per pass, because joining two components changes who is
  // "outside" for the next one.
  for (;;) {
    const home = find(0)
    let best: { from: number; to: number; distance: number } | null = null
    marks.forEach((mark, i) => {
      if (find(i) !== home) return
      marks.forEach((other, j) => {
        if (find(j) === home) return
        const distance = Math.hypot(other.x - mark.x, other.y - mark.y)
        if (!best || distance < best.distance) best = { from: i, to: j, distance }
      })
    })
    if (!best) return

    const { from, to } = best as { from: number; to: number }
    pairs.set(`${Math.min(from, to)}-${Math.max(from, to)}`, {
      from: Math.min(from, to),
      to: Math.max(from, to),
    })
    union(from, to)
  }
}

const LINKS: Link[] = (() => {
  const pairs = nearestLinks(SIGNAL_MARKS)
  bridgeIslands(SIGNAL_MARKS, pairs)
  return [...pairs.values()]
})()

/**
 * How close the pointer has to get, in disc units, before a marker feels
 * it. Roughly a sixth of the disc — near enough that the field reads as
 * local to the cursor rather than as the whole planet reacting.
 */
const INFLUENCE = 16
/** Furthest a marker is ever pushed, in disc units. About two marker widths. */
const MAX_PUSH = 2.4
/** Spring constants. Stiff and well damped: a lean toward the answer, never a wobble. */
const STIFFNESS = 190
const DAMPING = 21
/** Below this total motion the field is considered at rest and the loop stops. */
const REST = 0.0004

/**
 * ТЗ §21 — how much the pointer's speed matters.
 *
 * A slow pointer displaces at `SPEED_FLOOR` of full strength and a fast one
 * at `SPEED_CEILING`. The range is deliberately narrow: ТЗ §21 asks for a
 * stronger reaction to a faster pointer and explicitly rules out the
 * squares "jumping", so speed modulates a reaction that is already gentle
 * rather than unlocking a different one.
 */
const SPEED_FLOOR = 0.75
const SPEED_CEILING = 1.35
/** Disc units per second at which the reaction reaches `SPEED_CEILING`. */
const FAST_POINTER = 140

interface MarkState {
  dx: number
  dy: number
  vx: number
  vy: number
  /** 0..1 — how strongly the cursor is activating this marker (ТЗ §23). */
  glow: number
}

/**
 * ТЗ §4-§10, §19-§23 — the planet's quiet activity, and its one reaction to
 * the person watching it.
 *
 * Still decorative in the strict sense: no lobby, probe, defence or player
 * reaches this component, so there is nothing here for a player to read a
 * position or a count out of, however long they watch it.
 *
 * Three separate channels of motion, on three nested elements, which is the
 * arrangement the whole component is built around:
 *
 *   `<g class="wake">`   the staggered wake-up, CSS, once per document load
 *   `<g class="pulse">`  the slow idle breathing, CSS, forever
 *   `<rect>`             the cursor's magnetic push, JavaScript
 *
 * They are nested rather than combined because each animates `transform`
 * and `opacity`, and two animations on one element fight over both. Giving
 * each channel an element of its own means the wake can play while a marker
 * is already breathing *and* being pushed, with nothing to reconcile.
 */
export function SurfaceSignals() {
  const entering = useBootEntrance()
  const svg = useRef<SVGSVGElement | null>(null)
  const rects = useRef<Array<SVGRectElement | null>>([])
  const lines = useRef<Array<SVGLineElement | null>>([])

  useEffect(() => {
    if (prefersReducedMotion()) return

    const marks: MarkState[] = SIGNAL_MARKS.map(() => ({ dx: 0, dy: 0, vx: 0, vy: 0, glow: 0 }))
    /*
     * The pointer in the disc's own 100×100 space, or null when it is
     * nowhere near. Kept in a plain object rather than React state: it
     * changes on every pointer event and nothing about it should ever cause
     * a render.
     */
    let pointer: { x: number; y: number } | null = null
    let speed = 0
    let previous: { x: number; y: number; at: number } | null = null
    let frame = 0
    let last = 0

    const step = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now

      const strength =
        SPEED_FLOOR + (SPEED_CEILING - SPEED_FLOOR) * Math.min(1, speed / FAST_POINTER)

      let energy = 0

      for (let i = 0; i < marks.length; i++) {
        const mark = SIGNAL_MARKS[i]
        const state = marks[i]

        let targetX = 0
        let targetY = 0
        let targetGlow = 0

        if (pointer) {
          const awayX = mark.x - pointer.x
          const awayY = mark.y - pointer.y
          const distance = Math.hypot(awayX, awayY)
          if (distance < INFLUENCE && distance > 0.001) {
            /*
             * Falls off as the square of the remaining distance, so the
             * effect is concentrated right under the cursor and fades to
             * nothing well before the edge of its reach. A linear falloff
             * makes the whole influence circle visibly move together, which
             * reads as a bubble rather than as a field.
             */
            const closeness = 1 - distance / INFLUENCE
            const push = closeness * closeness * MAX_PUSH * strength
            targetX = (awayX / distance) * push
            targetY = (awayY / distance) * push
            targetGlow = closeness
          }
        }

        // One critically-damped-ish spring per axis, integrated forward.
        // This is the "soft return" of ТЗ §23 as much as it is the push:
        // the same spring carries the marker back when the cursor leaves.
        state.vx += ((targetX - state.dx) * STIFFNESS - state.vx * DAMPING) * dt
        state.vy += ((targetY - state.dy) * STIFFNESS - state.vy * DAMPING) * dt
        state.dx += state.vx * dt
        state.dy += state.vy * dt
        state.glow += (targetGlow - state.glow) * Math.min(1, dt * 9)

        energy += Math.abs(state.vx) + Math.abs(state.vy) + Math.abs(targetGlow - state.glow)

        const node = rects.current[i]
        if (node) {
          node.style.transform = `translate(${state.dx.toFixed(3)}px, ${state.dy.toFixed(3)}px)`
          /*
           * ТЗ §23 — the activation is written as a *fill*, not as opacity.
           *
           * Opacity is already spoken for: the CSS pulse above owns it, and
           * the two would overwrite each other frame by frame. Brightening
           * the colour instead leaves that channel alone, and is closer to
           * what the effect means anyway — the marker is not becoming more
           * present, it is lighting up.
           */
          node.style.fill =
            state.glow > 0.01
              ? `color-mix(in srgb, var(--color-accent-soft) ${(state.glow * 100).toFixed(1)}%, ${
                  mark.pale ? 'var(--color-accent-soft)' : 'var(--color-accent)'
                })`
              : ''
        }
      }

      for (let i = 0; i < LINKS.length; i++) {
        const node = lines.current[i]
        if (!node) continue
        const link = LINKS[i]
        const from = SIGNAL_MARKS[link.from]
        const to = SIGNAL_MARKS[link.to]
        const a = marks[link.from]
        const b = marks[link.to]

        node.setAttribute('x1', (from.x + a.dx).toFixed(2))
        node.setAttribute('y1', (from.y + a.dy).toFixed(2))
        node.setAttribute('x2', (to.x + b.dx).toFixed(2))
        node.setAttribute('y2', (to.y + b.dy).toFixed(2))
        /*
         * ТЗ §22 — a connection is brighter when the cursor is near either
         * of its ends. Taking the stronger of the two glows rather than the
         * average means a line lights as soon as the cursor reaches one end
         * of it, which is what makes the mesh feel like it is responding to
         * the pointer rather than to its own midpoint.
         */
        node.style.opacity = `${(0.18 + 0.55 * Math.max(a.glow, b.glow)).toFixed(3)}`
      }

      /*
       * Stop when nothing is moving and nothing is being pointed at. The
       * loop is restarted by the next pointer event, so an idle page costs
       * exactly nothing — which matters here more than anywhere else in the
       * product, because this sits on the landing page's largest element.
       */
      if (pointer || energy > REST) {
        frame = requestAnimationFrame(step)
      } else {
        frame = 0
      }
    }

    const wake = () => {
      if (frame) return
      last = performance.now()
      frame = requestAnimationFrame(step)
    }

    /*
     * Tracked on the window rather than on the disc.
     *
     * The globe is overlaid by the hero copy and the countdown, both of
     * which would swallow the pointer and make the field die in patches
     * wherever the UI happens to sit. One window listener also means the
     * markers are already leaning away before the cursor formally arrives
     * over the planet, which is what a field does.
     */
    const onPointerMove = (event: PointerEvent) => {
      const element = svg.current
      if (!element) return
      const box = element.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) return

      const x = ((event.clientX - box.left) / box.width) * 100
      const y = ((event.clientY - box.top) / box.height) * 100

      // A generous margin so the field starts responding just before the
      // cursor crosses the disc, and is released cleanly once it is well
      // clear rather than snapping off at the edge.
      const near = x > -INFLUENCE && x < 100 + INFLUENCE && y > -INFLUENCE && y < 100 + INFLUENCE
      const now = performance.now()

      if (previous) {
        const elapsed = Math.max(1, now - previous.at)
        speed = (Math.hypot(x - previous.x, y - previous.y) / elapsed) * 1000
      }
      previous = { x, y, at: now }

      pointer = near ? { x, y } : null
      if (near) wake()
    }

    const onPointerLeave = () => {
      pointer = null
      previous = null
      wake()
    }

    window.addEventListener('pointermove', onPointerMove, { passive: true })
    document.addEventListener('pointerleave', onPointerLeave)

    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerleave', onPointerLeave)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <svg ref={svg} className={styles.signals} viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      {/*
        ТЗ §22 — the mesh, under the markers it joins.
        Drawn first so a line always passes behind a square rather than
        across it, which is the difference between a connection and a
        scratch.
      */}
      <g
        className={[styles.links, entering ? styles.linksWake : ''].filter(Boolean).join(' ')}
        style={entering ? { animationDelay: `${SIGNALS_WAKE.delay + 180}ms` } : undefined}
      >
        {LINKS.map((link, index) => (
          <line
            key={`link-${link.from}-${link.to}`}
            ref={(node) => {
              lines.current[index] = node
            }}
            className={styles.link}
            x1={SIGNAL_MARKS[link.from].x}
            y1={SIGNAL_MARKS[link.from].y}
            x2={SIGNAL_MARKS[link.to].x}
            y2={SIGNAL_MARKS[link.to].y}
          />
        ))}
      </g>
      {SIGNAL_MARKS.map((mark, index) => (
        /*
          Three elements per marker, one motion channel each — see the
          component's own comment. The wake carries the boot stagger, the
          pulse carries the idle breathing, the rect carries the cursor.
        */
        <g
          key={`signal-${mark.x}-${mark.y}`}
          className={entering ? styles.wake : undefined}
          style={
            entering
              ? { animationDelay: `${SIGNALS_WAKE.delay + index * SIGNALS_WAKE.stagger}ms` }
              : undefined
          }
        >
          <g
            className={mark.period ? styles.pulse : undefined}
            style={
              mark.period
                ? /*
                    A *negative* delay, for the same reason the globe's own
                    spin uses one: it starts the animation already that far
                    in, so the layer opens mid-activity instead of every
                    marker rising together out of its dimmest frame.
                  */
                  { animationDuration: `${mark.period}s`, animationDelay: `-${mark.phase}s` }
                : { opacity: mark.dim }
            }
          >
            <rect
              ref={(node) => {
                rects.current[index] = node
              }}
              className={[styles.signal, mark.pale ? styles.signalPale : ''].filter(Boolean).join(' ')}
              x={mark.left}
              y={mark.top}
              width={mark.size}
              height={mark.size}
            />
          </g>
        </g>
      ))}
    </svg>
  )
}
