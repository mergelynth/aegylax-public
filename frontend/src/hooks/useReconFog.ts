import { useEffect, useMemo, useRef, useState } from 'react'
import { buildReconEstimate, buildReconFog, type ReconEstimate, type ReconFog } from '../game/recon'
import type { ReconProbeRecord } from '../game/types'
import type { WorldGeometry } from '../game/world'

/**
 * How long the scan wave takes to cross the working area. Matches the
 * `recon-wave` keyframes in SectorGrid.module.css — the number lives in
 * both because one is a duration and the other is a stylesheet, but they
 * describe the same sweep.
 */
export const RECON_WAVE_MS = 1500

export interface UseReconFogResult {
  /** The fog as it should be painted *now* — the wave's arrival is what updates it (ТЗ §1.4). */
  fog: ReconFog
  /** The same reading as geometry: the blue cloud, its core, and the red blotch once it exists (ТЗ §3). */
  estimate: ReconEstimate | null
  /** Changes once per probe actually sent from this screen; remounting on it is what replays the wave. */
  waveKey: number | null
  /** True while the wave is crossing and the fog it will bring has not landed yet. */
  scanning: boolean
}

/**
 * The reconnaissance picture, and the wave that delivers it (ТЗ §1.4).
 *
 * The wave plays exactly once, when a hint actually arrives: the reading
 * came back from Inco, the fix was recomputed, and the sweep is what
 * hands that new picture over. It is not a progress bar. Pulsing for the
 * whole flight — DELAY_BLOCKS of it — puts a permanent animation on the
 * map that says nothing except "still waiting", which the Send button
 * already says without moving. Whether a probe is in the air belongs to
 * the control that spent it, not to the sky.
 *
 * Only a probe genuinely sent from this screen gets a wave. A reload, a
 * wallet switch or a change of attack all reload the stored intelligence in
 * one go, and replaying a wave for each of them would set off a fireworks
 * display for reconnaissance that happened minutes ago. `live` is that
 * distinction.
 */
export function useReconFog(
  results: readonly ReconProbeRecord[],
  world: WorldGeometry,
  live = false,
): UseReconFogResult {
  const [settled, setSettled] = useState<readonly ReconProbeRecord[]>(results)
  const [waveKey, setWaveKey] = useState<number | null>(null)
  const waveCount = useRef(0)

  useEffect(() => {
    if (sameProbes(results, settled)) return

    if (!live || !isOneMoreThan(results, settled)) {
      setSettled(results)
      return
    }

    /*
     * The picture lands with the wave, not after it. Holding the fog back
     * for the sweep's duration left a blank (or stale) sky for 1.5s after
     * Inco had already answered — which is the frame the player photographs
     * as "the cloud disappeared".
     */
    waveCount.current += 1
    setWaveKey(waveCount.current)
    setSettled(results)
  }, [results, settled, live])

  const fog = useMemo(() => buildReconFog(settled, world), [settled, world])
  const estimate = useMemo(() => buildReconEstimate(fog.fix, world, settled), [fog.fix, world, settled])

  return {
    fog,
    estimate,
    waveKey,
    scanning: settled.length !== results.length,
  }
}

/** Whether `next` is exactly `previous` with one further probe on the end. */
function isOneMoreThan(next: readonly ReconProbeRecord[], previous: readonly ReconProbeRecord[]): boolean {
  return next.length === previous.length + 1 && previous.every((probe, index) => probe.id === next[index]?.id)
}

function sameProbes(a: readonly ReconProbeRecord[], b: readonly ReconProbeRecord[]): boolean {
  return a === b || (a.length === b.length && a.every((probe, index) => probe.id === b[index]?.id))
}
