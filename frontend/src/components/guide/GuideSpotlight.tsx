import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GuideBranch, GuideStep } from '../../guide/script'
import styles from './GuideSpotlight.module.css'

export type Side = 'top' | 'bottom' | 'left' | 'right'

interface Box {
  left: number
  top: number
  width: number
  height: number
}

export interface Placement {
  side: Side
  left: number
  top: number
  /** Where the pointer sits along the card's facing edge, in px from its origin. */
  arrow: number
}

const GAP = 14
const MARGIN = 12
const ARROW_INSET = 20

const ORDER: Record<Side, Side[]> = {
  top: ['top', 'bottom', 'right', 'left'],
  bottom: ['bottom', 'top', 'right', 'left'],
  left: ['left', 'right', 'top', 'bottom'],
  right: ['right', 'left', 'top', 'bottom'],
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/**
 * Where the card goes, given what it explains and how much window there is.
 *
 * Pure and separate from the component, because this is the part that can
 * be quietly wrong: a card half off the bottom of a laptop screen, or one
 * sitting on top of the button it describes, both render without
 * complaint. The rules are that it stays inside the viewport and never
 * overlaps its own target — which is why the cross axis is clamped and the
 * facing axis never is. Clamping the facing axis is exactly how a tooltip
 * ends up covering the thing it points at.
 */
export function placeCard(
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  preferred: Side = 'bottom',
): Placement {
  const fits = (side: Side): Placement | null => {
    if (side === 'top' || side === 'bottom') {
      const top = side === 'top' ? anchor.top - size.height - GAP : anchor.top + anchor.height + GAP
      if (top < MARGIN || top + size.height > viewport.height - MARGIN) return null
      const left = clamp(
        anchor.left + anchor.width / 2 - size.width / 2,
        MARGIN,
        Math.max(MARGIN, viewport.width - size.width - MARGIN),
      )
      return {
        side,
        left,
        top,
        arrow: clamp(anchor.left + anchor.width / 2 - left, ARROW_INSET, Math.max(ARROW_INSET, size.width - ARROW_INSET)),
      }
    }

    const left = side === 'left' ? anchor.left - size.width - GAP : anchor.left + anchor.width + GAP
    if (left < MARGIN || left + size.width > viewport.width - MARGIN) return null
    const top = clamp(
      anchor.top + anchor.height / 2 - size.height / 2,
      MARGIN,
      Math.max(MARGIN, viewport.height - size.height - MARGIN),
    )
    return {
      side,
      left,
      top,
      arrow: clamp(anchor.top + anchor.height / 2 - top, ARROW_INSET, Math.max(ARROW_INSET, size.height - ARROW_INSET)),
    }
  }

  for (const side of ORDER[preferred]) {
    const placement = fits(side)
    if (placement) return placement
  }

  /*
   * Nothing fitted — a small window, or a target filling most of it. Put
   * the card where there is the most room and clamp it in, accepting an
   * overlap rather than rendering off screen: being partly over the target
   * is recoverable, being outside the window is not.
   */
  const room = {
    top: anchor.top,
    bottom: viewport.height - (anchor.top + anchor.height),
    left: anchor.left,
    right: viewport.width - (anchor.left + anchor.width),
  }
  const side = (Object.keys(room) as Side[]).reduce((best, key) => (room[key] > room[best] ? key : best), 'bottom')
  const left = clamp(anchor.left + anchor.width / 2 - size.width / 2, MARGIN, Math.max(MARGIN, viewport.width - size.width - MARGIN))
  const top = clamp(
    side === 'top' ? anchor.top - size.height - GAP : anchor.top + anchor.height + GAP,
    MARGIN,
    Math.max(MARGIN, viewport.height - size.height - MARGIN),
  )
  return { side, left, top, arrow: clamp(anchor.left + anchor.width / 2 - left, ARROW_INSET, Math.max(ARROW_INSET, size.width - ARROW_INSET)) }
}

/**
 * The live rectangle of the element a step points at.
 *
 * Looked up by selector every frame for a short while after the step
 * changes, because the screens are the product's own and they arrive on
 * their own schedule: the operation screen measures its scene before it can
 * place the arena, the Create dialog animates open, and the rail waits for
 * Earth's silhouette. A rectangle captured once is right for about 300ms.
 *
 * The frame loop stops after that; scroll, resize and a `ResizeObserver`
 * cover everything later. A permanent loop would burn a frame's work
 * forever on a page that is usually perfectly still.
 */
function useTargetBox(selector: string | null, stepId: string): Box | null {
  const [box, setBox] = useState<Box | null>(null)

  useEffect(() => {
    if (!selector) {
      setBox(null)
      return
    }

    setBox(null)
    let frame = 0
    let frames = 0
    let stop = false
    let observer: ResizeObserver | null = null

    const read = () => {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element) return
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return
      setBox((previous) =>
        previous &&
        previous.left === rect.left &&
        previous.top === rect.top &&
        previous.width === rect.width &&
        previous.height === rect.height
          ? previous
          : { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      )
      if (!observer) {
        observer = new ResizeObserver(read)
        observer.observe(element)
      }
    }

    const settle = () => {
      if (stop) return
      read()
      frames += 1
      if (frames < 60) frame = requestAnimationFrame(settle)
    }
    settle()

    const passive = { passive: true } as const
    window.addEventListener('resize', read, passive)
    window.addEventListener('scroll', read, { capture: true, passive: true })

    return () => {
      stop = true
      cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', read)
      window.removeEventListener('scroll', read, { capture: true } as EventListenerOptions)
    }
  }, [selector, stepId])

  return box
}

function useCompact(): boolean {
  const [compact, setCompact] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches,
  )
  useEffect(() => {
    const query = window.matchMedia('(max-width: 860px)')
    const update = () => setCompact(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return compact
}

export interface GuideSpotlightProps {
  step: GuideStep
  position: number
  total: number
  hasPrevious: boolean
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
  /** Picks a path at a fork, and moves on. */
  onChoose: (branch: GuideBranch) => void
  /** The last step's control: hands the visitor back to the product. */
  onFinish: () => void
  onExit: () => void
}

/**
 * The tour's one piece of chrome (ТЗ §7-§9).
 *
 * It floats over the real product and owns nothing about it: it reads the
 * current step, finds the element that step is about, dims everything else
 * and explains it. The dimming is one `box-shadow` with a 9999px spread on
 * the highlight ring, which darkens the whole window *except* that ring's
 * rectangle — the effect wanted, for one element, and it cannot drift out
 * of alignment with what it frames because it is the thing framing it.
 *
 * Nothing here takes pointer events except the card, so the interface
 * underneath stays live while the tour is up.
 */
export function GuideSpotlight({
  step,
  position,
  total,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  onChoose,
  onFinish,
  onExit,
}: GuideSpotlightProps) {
  const compact = useCompact()
  const box = useTargetBox(step.target, step.id)
  const cardRef = useRef<HTMLDivElement>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)

  const reposition = useCallback(() => {
    const card = cardRef.current
    if (!card || !box || compact) return
    setPlacement(
      placeCard(box, { width: card.offsetWidth, height: card.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, step.side ?? 'bottom'),
    )
  }, [box, compact, step.side])

  useLayoutEffect(reposition, [reposition])

  /*
   * On a phone the card is a sheet at the bottom of the window, so the one
   * thing that can go wrong is the sheet sitting over the control it
   * describes. Bringing the target to the middle of the screen first is the
   * fix, and it is deferred because several of these screens animate open
   * from nothing — scrolling to a panel that is one pixel tall leaves it at
   * the top once it has grown.
   */
  useEffect(() => {
    if (!compact || !step.target) return
    const scroll = () => document.querySelector(step.target!)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    scroll()
    const settled = window.setTimeout(scroll, 340)
    return () => window.clearTimeout(settled)
  }, [compact, step.target, step.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onExit()
      if (event.key === 'ArrowRight' && hasNext) onNext()
      if (event.key === 'ArrowLeft' && hasPrevious) onPrevious()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onExit, onNext, onPrevious, hasNext, hasPrevious])

  if (typeof document === 'undefined') return null

  const pinned = !compact && box !== null && placement !== null

  return createPortal(
    <div className={styles.layer}>
      {box ? (
        <div
          className={styles.ring}
          aria-hidden="true"
          style={{
            left: `${box.left - 6}px`,
            top: `${box.top - 6}px`,
            width: `${box.width + 12}px`,
            height: `${box.height + 12}px`,
          }}
        />
      ) : step.place === 'corner' ? null : (
        /* A step about the product as a whole dims it, so the card reads as
           an overlay on something paused. A `corner` step is about the
           screen *itself*, so dimming it would defeat the explanation. */
        <div className={styles.scrim} aria-hidden="true" />
      )}

      <div
        ref={cardRef}
        className={styles.card}
        role="dialog"
        aria-label={step.title}
        data-side={placement?.side ?? 'bottom'}
        data-pinned={pinned || undefined}
        data-place={!pinned ? (step.place ?? 'auto') : undefined}
        style={
          pinned
            ? { left: `${placement.left}px`, top: `${placement.top}px`, ['--arrow' as string]: `${placement.arrow}px` }
            : undefined
        }
      >
        {pinned ? <span className={styles.arrow} aria-hidden="true" /> : null}

        <p className={styles.counter}>
          Step {String(position).padStart(2, '0')} <span className={styles.of}>/ {String(total).padStart(2, '0')}</span>
        </p>
        <p className={styles.title}>{step.title}</p>
        {(Array.isArray(step.body) ? step.body : [step.body]).map((paragraph) => (
          <p key={paragraph} className={styles.body}>
            {paragraph}
          </p>
        ))}
        {step.note
          ? (Array.isArray(step.note) ? step.note : [step.note]).map((line) => (
              <p key={line} className={styles.note}>
                {line}
              </p>
            ))
          : null}

        {/*
          A fork takes the place of Next rather than sitting beside it.
          Both options move the tour on, so offering a third control that
          also moves it on would be asking the same question twice — and
          leaving one of the two answers unmade.
        */}
        {step.choice ? (
          <div className={styles.choice}>
            <p className={styles.question}>{step.choice.question}</p>
            {step.choice.options.map((option) => (
              <button
                key={option.branch}
                type="button"
                className={styles.option}
                onClick={() => onChoose(option.branch)}
              >
                <span className={styles.optionLabel}>{option.label}</span>
                <span className={styles.optionNote}>{option.description}</span>
              </button>
            ))}
          </div>
        ) : null}

        <div className={styles.actions}>
          <button type="button" className={styles.exit} onClick={onExit}>
            Exit
          </button>
          <div className={styles.move}>
            <button type="button" className={styles.prev} onClick={onPrevious} disabled={!hasPrevious}>
              Prev
            </button>
            {/*
              The slot is never empty. Prev and Next hold their places on
              every screen, so the controls do not move under the pointer
              between steps and there is always something obvious to press.
              What changes is what the right-hand one can do:

                a fork    — disabled. The two options above it are the move,
                            and a live Next beside them would offer a third
                            answer to a two-way question.
                the end   — it stops being Next and becomes the thing the
                            tour was for. A disabled Next on the last screen
                            is a dead end at the exact moment somebody has
                            decided they want to play.
            */}
            {hasNext ? (
              <button
                type="button"
                className={styles.next}
                onClick={onNext}
                disabled={Boolean(step.choice)}
              >
                Next
              </button>
            ) : (
              <button type="button" className={styles.next} onClick={onFinish}>
                Create operation
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
