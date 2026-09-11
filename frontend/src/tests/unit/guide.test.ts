import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { placeCard } from '../../components/guide/GuideSpotlight'
import {
  ALL_STEPS,
  ENTRY_BRANCHES,
  OUTCOME_BRANCHES,
  guideSequence,
  isEntryBranch,
} from '../../guide/script'

/*
 * The source tree, resolved from the runner's root rather than from
 * `import.meta.url` — under Vitest that is a transformed module id, not a
 * file URL, and `fileURLToPath` refuses it.
 */
const SRC = [resolve(process.cwd(), 'src'), resolve(process.cwd(), 'frontend/src')].find(existsSync)!

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== 'tests' && entry !== 'node_modules') sourceFiles(path, found)
    } else if (path.endsWith('.tsx') || path.endsWith('.ts')) {
      found.push(path)
    }
  }
  return found
}

/** Every `data-guide` name the product renders as a literal. */
function declaredAnchors(): Set<string> {
  const names = new Set<string>()
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/data-guide="([^"]+)"/g)) names.add(match[1])
  }
  return names
}

/**
 * Prefixes of anchors the product builds at runtime.
 *
 * One component names its elements by a value it computes — the reveal
 * labels each committed point with its verdict — so the whole name cannot
 * be read out of the source. What can be read is the fixed part before the
 * interpolation, and that is what a step is checked against here.
 *
 * This deliberately only proves half of it: a step pointing at
 * `defense-nonsense` would pass. The other half is pinned where it can
 * actually be observed — `AttackReveal.test.tsx` renders a reveal and
 * asserts the four suffixes it emits.
 */
function declaredAnchorFamilies(): string[] {
  const prefixes: string[] = []
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/data-guide=\{`([^`$]*)\$\{/g)) prefixes.push(match[1])
  }
  return prefixes
}

describe('guide script', () => {
  it('points only at anchors the product renders', () => {
    /*
     * The one failure this whole file exists for.
     *
     * The tour reaches the real components by `data-guide` name, and a name
     * is exactly the kind of link that rots silently: rename the attribute
     * and nothing throws — the highlight simply never appears and the card
     * drifts to the bottom of the screen, on a page that otherwise looks
     * completely fine.
     */
    const declared = declaredAnchors()
    const families = declaredAnchorFamilies()
    expect(declared.size).toBeGreaterThan(0)
    expect(families.length).toBeGreaterThan(0)

    for (const step of ALL_STEPS) {
      if (!step.target) continue
      const name = step.target.match(/data-guide="([^"]+)"/)?.[1]
      expect(name, `step "${step.id}" has a target this test cannot read: ${step.target}`).toBeDefined()

      const known = declared.has(name!) || families.some((prefix) => name!.startsWith(prefix))
      expect(known, `step "${step.id}" points at "${name}", which nothing renders`).toBe(true)
    }
  })

  it('names a room for every step that shows one', () => {
    for (const step of ALL_STEPS) {
      if (step.screen === 'lobby') expect(step.room, `${step.id} is a lobby step with no room`).toBeDefined()
      else expect(step.room, `${step.id} names a room it cannot show`).toBeUndefined()
    }
  })

  it('walks all four paths, each with unique steps', () => {
    for (const entry of ENTRY_BRANCHES) {
      for (const outcome of OUTCOME_BRANCHES) {
        const steps = guideSequence(entry, outcome)
        const ids = steps.map((step) => step.id)
        expect(new Set(ids).size, `${entry}/${outcome} repeats a step`).toBe(ids.length)
        expect(ids[0]).toBe('home')

        // The path contains its own branches and neither of the others'.
        for (const step of steps) {
          if (!step.branch) continue
          expect([entry, outcome], `${entry}/${outcome} includes a ${step.branch} step`).toContain(step.branch)
        }
      }
    }
  })

  it('keeps the interception and the failures on separate paths', () => {
    /*
     * One story on one side, three on the other.
     *
     * Both paths used to walk all four outcomes, which made the choice at
     * the fork mean nothing and turned a successful interception into a
     * footnote inside a catalogue of errors. The branch is the point: a hit
     * is a hit, and failing is three different things.
     */
    const hit = guideSequence('create', 'hit')
    const miss = guideSequence('create', 'miss')

    expect(hit.filter((step) => step.branch === 'hit').map((step) => step.id)).toEqual([
      'hit-reveal',
      'hit-claim',
    ])

    const failures = ['miss-early', 'miss-late', 'miss-stray']
    for (const id of failures) {
      expect(miss.some((step) => step.id === id), `the miss path lost "${id}"`).toBe(true)
      expect(hit.some((step) => step.id === id), `"${id}" leaked onto the winning path`).toBe(false)
    }

    // Each failure stands in an operation of its own, so the map carries one
    // point against one line rather than three rings in a crowd.
    const rooms = miss.filter((step) => failures.includes(step.id)).map((step) => step.room)
    expect(new Set(rooms).size).toBe(3)
  })

  it('offers exactly two forks, and each names both of its paths', () => {
    const forks = ALL_STEPS.filter((step) => step.choice)
    expect(forks.map((step) => step.id)).toEqual(['entry', 'shot'])

    for (const fork of forks) {
      const branches = fork.choice!.options.map((option) => option.branch)
      expect(new Set(branches).size).toBe(2)
      // A fork chooses between two paths of the same kind: how you get in,
      // or how it ends. Mixing them would make one decision unreachable.
      expect(new Set(branches.map(isEntryBranch)).size).toBe(1)
    }

    expect(forks[0].choice!.options.map((o) => o.branch).sort()).toEqual(['create', 'join'])
    expect(forks[1].choice!.options.map((o) => o.branch).sort()).toEqual(['hit', 'miss'])
  })

  it('never puts a fork on the last step of a path', () => {
    // A fork replaces Next, so a fork with nothing after it would be a
    // question whose answers lead nowhere.
    for (const entry of ENTRY_BRANCHES) {
      for (const outcome of OUTCOME_BRANCHES) {
        const steps = guideSequence(entry, outcome)
        expect(steps.at(-1)?.choice).toBeUndefined()
      }
    }
  })

  it('keeps the Create dialog open for exactly the steps that are about it', () => {
    const modal = ALL_STEPS.filter((step) => step.createModal)
    expect(modal.map((step) => step.id)).toEqual(['create-terms', 'create-launch'])

    // Adjacent on their own path, or the dialog would open, close and reopen.
    const steps = guideSequence('create', 'hit')
    const first = steps.findIndex((step) => step.id === 'create-terms')
    expect(steps[first + 1].id).toBe('create-launch')
  })

  it('keeps every card short enough not to need a scrollbar', () => {
    /*
     * The cards do not scroll (see `GuideSpotlight.module.css`), so a step
     * that grew past the window would hide its own controls rather than
     * offering a scrollbar — and on the last screen that is the call to
     * action. Characters are a proxy for height, and a coarse one, but they
     * are the thing an edit actually changes: the bound is set just above
     * the longest step that has been measured on screen at 1440x720.
     */
    const MAX_CHARS = 720

    for (const step of ALL_STEPS) {
      const body = Array.isArray(step.body) ? step.body.join(' ') : step.body
      const note = step.note ? (Array.isArray(step.note) ? step.note.join(' ') : step.note) : ''
      const choice = step.choice
        ? step.choice.question + step.choice.options.map((o) => o.label + o.description).join('')
        : ''
      const total = step.title.length + body.length + note.length + choice.length

      expect(total, `step "${step.id}" is ${total} characters and will not fit its card`).toBeLessThanOrEqual(
        MAX_CHARS,
      )
    }
  })

  it('has unique ids and a readable length', () => {
    /*
     * A bound rather than a target. Every step is a screen somebody has to
     * read and press past, and a tour that quietly grew to thirty of them
     * would be a manual again — which is the thing this replaced. Twenty is
     * roughly three minutes at a comfortable pace.
     */
    const ids = ALL_STEPS.map((step) => step.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of ENTRY_BRANCHES) {
      for (const outcome of OUTCOME_BRANCHES) {
        const length = guideSequence(entry, outcome).length
        expect(length).toBeGreaterThan(8)
        expect(length).toBeLessThanOrEqual(20)
      }
    }
  })
})

describe('guide card placement', () => {
  const size = { width: 340, height: 220 }
  const viewport = { width: 1440, height: 900 }

  it('honours the preferred side when it fits', () => {
    const anchor = { left: 600, top: 400, width: 200, height: 40 }
    expect(placeCard(anchor, size, viewport, 'top').side).toBe('top')
    expect(placeCard(anchor, size, viewport, 'bottom').side).toBe('bottom')
    expect(placeCard(anchor, size, viewport, 'left').side).toBe('left')
    expect(placeCard(anchor, size, viewport, 'right').side).toBe('right')
  })

  it('flips away from an edge instead of going off screen', () => {
    const nearTop = { left: 600, top: 10, width: 200, height: 40 }
    const placed = placeCard(nearTop, size, viewport, 'top')
    expect(placed.side).toBe('bottom')
    expect(placed.top).toBeGreaterThanOrEqual(0)
    expect(placed.top + size.height).toBeLessThanOrEqual(viewport.height)
  })

  it('never covers the element it is explaining', () => {
    /*
     * The silent one: clamping the *facing* axis to keep the box on screen
     * is exactly how a tooltip ends up sitting on top of its own target.
     */
    const anchors = [
      { left: 20, top: 20, width: 120, height: 40 },
      { left: 1300, top: 840, width: 120, height: 40 },
      { left: 700, top: 440, width: 200, height: 60 },
      { left: 0, top: 430, width: 60, height: 40 },
    ]
    for (const anchor of anchors) {
      for (const side of ['top', 'bottom', 'left', 'right'] as const) {
        const placed = placeCard(anchor, size, viewport, side)
        const overlaps =
          placed.left < anchor.left + anchor.width &&
          placed.left + size.width > anchor.left &&
          placed.top < anchor.top + anchor.height &&
          placed.top + size.height > anchor.top
        expect(overlaps, `${side} over ${JSON.stringify(anchor)}`).toBe(false)
      }
    }
  })

  it('keeps the box inside the window', () => {
    const anchor = { left: 1380, top: 30, width: 50, height: 30 }
    const placed = placeCard(anchor, size, viewport, 'right')
    expect(placed.left).toBeGreaterThanOrEqual(0)
    expect(placed.left + size.width).toBeLessThanOrEqual(viewport.width)
    expect(placed.top).toBeGreaterThanOrEqual(0)
    expect(placed.top + size.height).toBeLessThanOrEqual(viewport.height)
  })

  it('points the arrow at the target, held clear of the corners', () => {
    const anchor = { left: 40, top: 400, width: 60, height: 40 }
    const placed = placeCard(anchor, size, viewport, 'bottom')
    expect(placed.arrow).toBeGreaterThanOrEqual(20)
    expect(placed.arrow).toBeLessThanOrEqual(size.width - 20)
  })
})
