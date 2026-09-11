import { useMemo } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { OperationArena } from '../../components/arena/OperationArena'
import { EarthSpaceViewport } from '../../components/earth/EarthSpaceViewport'
import { appConfig } from '../../config/env'
import {
  aimInsideFirstCloud,
  buildReconEstimate,
  buildReconFog,
  generateReconProbeResult,
} from '../../game/recon'
import type { AttackTrajectory, Hash, ReconProbeResult } from '../../game/types'
import { buildWorld } from '../../game/world'
import styles from './RailPreviewPage.module.css'

/**
 * DEV-only: the reconnaissance picture at every probe count, built by the
 * *real* generator rather than by hand-written numbers.
 *
 * It exists because the two things that keep going wrong about the red
 * occupancy marks — whether the first one can be seen, and whether the
 * fifth can be told from it — are invisible in every other preview. The
 * rail preview has no map; a live operation needs a chain, a wallet and
 * three probe cooldowns before the second mark exists. Both properties are
 * pinned by `reconBlotchPaint.test.ts`; this is where they are *looked* at.
 *
 * Everything below the seed is the production path: `generateReconProbeResult`
 * is what the emulator spends a probe on, `buildReconFog` and
 * `buildReconEstimate` are what the operation screen draws from, and the
 * arena is the same component. Nothing here is a mock of the picture — only
 * of the round that would have produced it.
 */
const MAP_GRID = { columns: appConfig.map.columns, rows: appConfig.map.rows }
const SEED = '0xrecon-preview' as Hash
const MAX_PROBES = 6

export function ReconPreviewPage() {
  const [params] = useSearchParams()
  const requested = Number(params.get('n'))
  const count = Number.isFinite(requested) ? Math.min(MAX_PROBES, Math.max(0, requested)) : 5

  const world = useMemo(() => buildWorld(MAP_GRID, appConfig.protocol.sectorSpanKm), [])

  const { estimate, probes } = useMemo(() => {
    /* An attack coming in over the north-west, down onto the planet. */
    const path: AttackTrajectory = {
      pointA: { x: world.widthKm * 0.12, y: 0 },
      pointB: { x: world.earth.center.x - world.earth.radiusKm * 0.55, y: world.earth.center.y - world.earth.radiusKm * 0.84 },
      impactAngleRadians: -Math.PI / 2,
      lengthKm: world.heightKm,
      speedKmPerBlock: 250,
    }

    const results: ReconProbeResult[] = []
    for (let index = 0; index < count; index += 1) {
      /*
       * Probe one is a sweep — a player with no picture has nothing to aim
       * at — and every later one is aimed inside the cloud the sweep left,
       * which is exactly the sequence `LobbyPage` sends.
       */
      const aim = index === 0 ? null : aimInsideFirstCloud(results[0].bearingDegrees, results[0].uncertaintyDegrees, SEED, index)
      results.push(generateReconProbeResult(path, 4, index, world, SEED, 100 + index * 4, aim))
    }

    const fog = buildReconFog(results, world)
    return { estimate: buildReconEstimate(fog.fix, world, results), probes: results }
  }, [count, world])

  return (
    <EarthSpaceViewport variant="hero">
      <nav className={styles.strip} aria-label="Recon preview probe counts">
        {Array.from({ length: MAX_PROBES + 1 }, (_, n) => (
          <Link key={n} to={`?n=${n}`} data-active={n === count ? 'true' : undefined}>
            {n} {n === 1 ? 'probe' : 'probes'}
          </Link>
        ))}
      </nav>
      <OperationArena
        grid={MAP_GRID}
        world={world}
        estimate={estimate}
        waveKey={null}
        interactive={false}
        selectedSector={null}
        stagedPoint={null}
        submittedPoint={null}
        onSelectSector={() => undefined}
        onPlacePoint={() => undefined}
        interceptionRadiusSectors={1}
        underAttack
        reveal={null}
        viewer={null}
        showGridLabels={appConfig.map.showGridLabels}
      />
      <p className={styles.readout}>
        {count === 0
          ? 'No probes — no picture.'
          : `${count} ${count === 1 ? 'probe' : 'probes'} · ${estimate?.blotches.length ?? 0} occupancy marks · spread ${Math.round(estimate?.spreadKm ?? 0)} km`}
        {probes.length > 0 ? ` · bearings ${probes.map((p) => Math.round(p.bearingDegrees)).join('°, ')}°` : ''}
      </p>
    </EarthSpaceViewport>
  )
}
