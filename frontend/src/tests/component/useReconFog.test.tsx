import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Address, Hash, ReconProbeRecord } from '../../game/types'
import { buildWorld } from '../../game/world'
import { useReconFog } from '../../hooks/useReconFog'
import { TEST_MAP_GRID } from '../fixtures'

const world = buildWorld(TEST_MAP_GRID, 1000)
const NONE: ReconProbeRecord[] = []
const FIRST = [probe(0)]

function probe(index: number): ReconProbeRecord {
  return {
    id: `probe-${index}`,
    lobbyId: '0xlobby' as Hash,
    attackId: 'attack-1',
    probeId: `p${index}`,
    requestedBy: '0x00000000000000000000000000000000000000aa' as Address,
    txHash: `0x${index}` as Hash,
    bearingDegrees: 250,
    direction: 'NW',
    uncertaintyDegrees: 46,
    confidencePercent: 45,
    sectorIds: ['A1'],
    generatedAtBlock: 10,
    epochId: 1,
  }
}

describe('useReconFog — the sweep (ТЗ §1.4)', () => {
  it('leaves the sky still while the probe is in flight', () => {
    const { result } = renderHook(() => useReconFog(NONE, world, true))
    expect(result.current.waveKey).toBeNull()
    expect(result.current.scanning).toBe(false)
    expect(result.current.estimate).toBeNull()
  })

  it('does not replay a wave for stored intelligence', () => {
    const { result } = renderHook(() => useReconFog(FIRST, world, false))
    expect(result.current.waveKey).toBeNull()
    expect(result.current.estimate).not.toBeNull()
    expect(result.current.scanning).toBe(false)
  })

  it('sweeps once when the reading lands, and paints the fog with it', () => {
    const { result, rerender } = renderHook(({ results, live }) => useReconFog(results, world, live), {
      initialProps: { results: NONE as ReconProbeRecord[], live: true },
    })
    expect(result.current.waveKey).toBeNull()

    rerender({ results: FIRST, live: true })
    expect(result.current.waveKey).toBe(1)
    expect(result.current.estimate).not.toBeNull()
    expect(result.current.estimate?.probeCount).toBe(1)
    expect(result.current.scanning).toBe(false)
    expect(result.current.waveKey).toBe(1)
  })
})
