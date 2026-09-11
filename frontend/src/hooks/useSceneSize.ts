import { useEffect, useState, type RefObject } from 'react'
import type { SceneSize } from '../game/spaceGrid'

/**
 * The pixel size of a scene-filling element, tracked live.
 *
 * The sector grid works in real pixels rather than percentages — cell
 * edges, Earth's cut-out and the transposition threshold all depend on the
 * scene's actual aspect — so a resize has to be re-measured, not scaled
 * into. Every layer that positions itself against the grid measures its
 * own `inset: 0` box with this hook, so they all read the same numbers and
 * cannot drift apart.
 *
 * Null until the first measurement, so callers render nothing rather than
 * guessing a size.
 */
export function useSceneSize(ref: RefObject<HTMLElement | null>): SceneSize | null {
  const [size, setSize] = useState<SceneSize | null>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return

    const measure = () => {
      const { width, height } = element.getBoundingClientRect()
      setSize((current) =>
        current && current.width === width && current.height === height ? current : { width, height },
      )
    }

    measure()
    // jsdom, and very old browsers, have no ResizeObserver. The window's
    // resize event misses container-only changes (the details drawer
    // opening) but keeps the grid correct for the case that matters.
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }

    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])

  return size
}
