import type { ReactNode } from 'react'
import { EarthSphere, type EarthState } from './EarthSphere'
import { SpaceBackground } from '../space/SpaceBackground'
import styles from './EarthSpaceViewport.module.css'

const COMPACT_SCENE = '(max-width: 720px), (hover: none) and (pointer: coarse)'

function compactScene(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(COMPACT_SCENE).matches
}

export interface EarthSpaceViewportProps {
  children?: ReactNode
  /** 'hero' is the Home page's full-bleed, borderless, space-dominant treatment. 'panel' (default) is a bordered square. */
  variant?: 'panel' | 'hero'
  /**
   * The planet's own state once an operation resolves — the green shield
   * or the red impact (ТЗ §12-13). It lives here rather than in a separate
   * overlay because both effects are concentric with the globe, and the
   * globe is placed by this stylesheet.
   */
  earthState?: EarthState
  /**
   * A chain timestamp to pin the planet's rotation at, or null to follow
   * the clock (ТЗ §6) — see `EarthSphere`.
   */
  earthFrozenAtMs?: number | null
  /**
   * Whether the planet's result is *arriving* (play the shield/shockwave)
   * or merely standing (colour and shell only) — see `EarthSphere`.
   */
  earthAnnounce?: boolean
}

/**
 * The space/Earth scene (spec §11). Pure CSS/SVG — CSS 3D transforms on
 * the hero globe, not a 3D engine (§58) — and responsive with no
 * horizontal overflow (§54).
 */
export function EarthSpaceViewport({
  children,
  variant = 'panel',
  earthState = 'idle',
  earthFrozenAtMs = null,
  earthAnnounce = true,
}: EarthSpaceViewportProps) {
  const isHero = variant === 'hero'
  const compact = compactScene()

  return (
    <div className={[styles.viewport, isHero ? styles.hero : ''].filter(Boolean).join(' ')}>
      <SpaceBackground density={isHero ? (compact ? 70 : 220) : 90} />
      <EarthSphere variant={variant} state={earthState} frozenAtMs={earthFrozenAtMs} announce={earthAnnounce} />
      {children ? <div className={styles.overlay}>{children}</div> : null}
    </div>
  )
}
