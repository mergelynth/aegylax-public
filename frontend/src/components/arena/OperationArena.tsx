import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReconEstimate } from '../../game/recon'
import { earthDiscInScene, placeGrid } from '../../game/spaceGrid'
import type { Address, AttackRevealData, DefensePoint, MapGridConfig, Sector } from '../../game/types'
import type { WorldGeometry } from '../../game/world'
import { useSceneSize } from '../../hooks/useSceneSize'
import { SectorGrid } from '../map/SectorGrid'
import { AttackReveal } from '../space/AttackReveal'
import styles from './OperationArena.module.css'

export interface OperationArenaProps {
  grid: MapGridConfig
  world: WorldGeometry

  /** The fused reconnaissance picture (ТЗ §3) and the wave that delivers each update (§1.4). */
  estimate: ReconEstimate | null
  waveKey: number | null

  /**
   * The operation is under way, so the grid is a picker (ТЗ §7). While it
   * is false the grid is drawn exactly as before but takes no clicks at
   * all — it is orientation, not a control.
   */
  interactive: boolean

  selectedSector: Sector | null
  stagedPoint: DefensePoint | null
  submittedPoint: DefensePoint | null
  onSelectSector: (sector: Sector) => void
  onPlacePoint: (point: DefensePoint) => void

  /** ТЗ §10.2 — the protocol's interception radius, in sectors. Drawn around the Defense Point. */
  interceptionRadiusSectors: number

  /*
   * True while the attack is in flight. Drives the red frame and the
   * ambient vignette for the *whole* of the flight, including after this
   * player has locked a Defense Point (ТЗ §4.2). The frame is a condition
   * of the sky, not a call to act — a standing alarm that drops the moment
   * someone submits would tell them the round was over when it is not.
   */
  underAttack: boolean

  /** Non-null only once the player has asked for the reveal and the chain has answered (ТЗ §13). */
  reveal: AttackRevealData | null
  viewer: Address | null

  /** ENV-controlled A-J / 1-5 axis labels, off by default — see `SectorGrid`. */
  showGridLabels?: boolean

  /**
   * Whether the reveal is *arriving* rather than simply being read back.
   *
   * A round revealed a week ago has no draw-in to perform: the trajectory
   * is a record by then, and replaying the strike every time somebody
   * reopens the operation turns a fact into a re-enactment. Only the client
   * that watched it happen animates it (see `LobbyPage`).
   */
  animateReveal?: boolean
  /**
   * 0..1 along the recon corridor: where the threat *would* be now, given
   * the fused bearing. Null before launch, after reveal, or with no estimate.
   * Not the real position — ТЗ §3.3 still holds; this is the same guess the
   * cloud already is, with a clock on it.
   */
  reconProgress?: number | null
  reconRemainingMs?: number | null
  reconFlightMs?: number | null
}

/**
 * The playfield (ТЗ §2), and the one place its geometry is measured.
 *
 * The grid, the reveal and the globe's cut-out all have to agree on
 * exactly where Earth is and how big a sector is. Rather than each
 * measuring the scene and re-deriving that, this component measures once
 * and hands the same `placement`/`disc` to everything below — which is
 * what makes "the grid is clipped by Earth's contour" (ТЗ §2.10) a fact
 * about one circle rather than an agreement between separate modules.
 *
 * The globe itself is *not* drawn here. It is the viewport's own hero
 * Earth, identical to the Home page's, and `earthDiscInScene` mirrors the
 * stylesheet that places it — so this layer knows exactly where the planet
 * is without owning it.
 */
export function OperationArena({
  grid,
  world,
  estimate,
  waveKey,
  interactive,
  selectedSector,
  stagedPoint,
  submittedPoint,
  onSelectSector,
  onPlacePoint,
  interceptionRadiusSectors,
  underAttack,
  reveal,
  viewer,
  showGridLabels = false,
  animateReveal = true,
  reconProgress = null,
  reconRemainingMs = null,
  reconFlightMs = null,
}: OperationArenaProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scene = useSceneSize(containerRef)

  const layout = useMemo(() => {
    if (!scene) return null
    return { placement: placeGrid(grid, scene), disc: earthDiscInScene(scene) }
  }, [grid, scene])

  /*
   * ТЗ §4.1-4.2 — the launch, announced on the frame of the working area:
   * one short red neon flash at the moment the countdown reaches zero, then
   * a faint red border that stays up for the rest of the flight.
   *
   * The flash is keyed off the *transition* into `underAttack` rather than
   * off the state itself, so it fires once when the attack starts and does
   * not replay on every re-render. A player who arrives mid-flight (or
   * reloads) still gets the flash once, because `wasUnderAttack` starts
   * false: the neon on the globe is how the screen says the sky is live.
   */
  const [flashKey, setFlashKey] = useState<number | null>(null)
  const wasUnderAttack = useRef(false)

  useEffect(() => {
    if (underAttack && !wasUnderAttack.current) setFlashKey(Date.now())
    wasUnderAttack.current = underAttack
  }, [underAttack])

  return (
    <div ref={containerRef} className={styles.arena} data-guide="arena">
      {scene && layout ? (
        <>
          <SectorGrid
            grid={grid}
            scene={scene}
            placement={layout.placement}
            earth={layout.disc}
            estimate={estimate}
            world={world}
            waveKey={waveKey}
            interactive={interactive}
            selectedSector={selectedSector}
            stagedPoint={stagedPoint}
            submittedPoint={submittedPoint}
            // Sectors are square on screen, so one sector is exactly one
            // cell — the radius converts with a single multiply and means
            // the same thing in either orientation.
            interceptionRadiusPx={interceptionRadiusSectors * layout.placement.cellSize}
            onSelectSector={onSelectSector}
            onPlacePoint={onPlacePoint}
            showGridLabels={showGridLabels}
            settled={reveal !== null}
            reconProgress={reconProgress}
            reconRemainingMs={reconRemainingMs}
            reconFlightMs={reconFlightMs}
          />

          {reveal ? (
            <AttackReveal
              reveal={reveal}
              viewer={viewer}
              world={world}
              placement={layout.placement}
              earth={layout.disc}
              scene={scene}
              animate={animateReveal}
            />
          ) : null}

          {/*
            While an attack is in flight the protocol reveals nothing about
            where it is (ТЗ §3.3), so the scene gets an edge alert and
            deliberately nothing positional — a marker here would be the
            one thing reconnaissance is supposed to be for.
          */}
          {underAttack ? (
            <>
              <div className={styles.alert} aria-hidden="true" />
              {/* ТЗ §4.2 — the faint red neon border, up for the whole flight. */}
              <div className={styles.frame} aria-hidden="true" />
              {/* ТЗ §4.1 — and the one-shot flash that opened it. */}
              {flashKey === null ? null : <div key={flashKey} className={styles.flash} aria-hidden="true" />}
            </>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
