import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendReconProbe } from '../../game/gameService'
import type { Address, Hash } from '../../game/types'
import { useReconProbes } from '../../hooks/useReconProbes'

const PLAYER = '0x00000000000000000000000000000000000000aa' as Address
const LOBBY = '0x1111' as Hash
const ATTACK = '0x2222'

const resolvePendingProbes = vi.fn()
const countPendingProbes = vi.fn()
let onBlock: ((n: number) => void) | null = null

const client = {
  countPendingProbes: (...args: unknown[]) => countPendingProbes(...args),
  resolvePendingProbes: (...args: unknown[]) => resolvePendingProbes(...args),
  subscribeToBlocks: vi.fn((cb: (n: number) => void) => {
    onBlock = cb
    return () => {
      onBlock = null
    }
  }),
}

vi.mock('../../hooks/useBlockchainClient', () => ({
  useBlockchainClient: () => client,
}))

vi.mock('../../hooks/useWallet', () => ({
  useWallet: () => ({ address: PLAYER }),
}))

vi.mock('../../game/gameService', () => ({
  sendReconProbe: vi.fn(),
}))

beforeEach(() => {
  resolvePendingProbes.mockReset()
  countPendingProbes.mockReset()
  vi.mocked(sendReconProbe).mockReset()
  onBlock = null
})

describe('useReconProbes — pending decrypt', () => {
  it('does not ask Inco again on every block after a decrypt failure', async () => {
    countPendingProbes.mockReturnValue(1)
    resolvePendingProbes.mockRejectedValue(new Error('Could not open your Recon Probe result: Failed to decrypt handles'))

    renderHook(() => useReconProbes(LOBBY, ATTACK))
    await waitFor(() => expect(resolvePendingProbes).toHaveBeenCalledTimes(1))

    await act(async () => {
      onBlock?.(101)
      onBlock?.(102)
      onBlock?.(103)
    })

    expect(resolvePendingProbes).toHaveBeenCalledTimes(1)
  })

  it('asks again on the next block after a quiet-network miss, rather than freezing', async () => {
    countPendingProbes.mockReturnValue(1)
    resolvePendingProbes.mockRejectedValue(
      new Error(
        'The privacy layer is slow to answer. Still calculating your result.',
      ),
    )

    const { result } = renderHook(() => useReconProbes(LOBBY, ATTACK))
    await waitFor(() => expect(result.current.error).toMatch(/still calculating/i))
    const afterMount = resolvePendingProbes.mock.calls.length

    /*
     * The next block, not the fourth.
     *
     * What is being waited out is the confidential network catching up with
     * a transaction that has already landed — seconds — because the hint is
     * granted by the send itself and there is no second transaction to
     * ingest. `withPatience` already spends an escalating backoff inside
     * each attempt, and the pull in flight is shared rather than duplicated,
     * so the extra blocks bought nothing but a screen sitting still.
     */
    await act(async () => {
      onBlock?.(101)
    })
    await waitFor(() => expect(resolvePendingProbes.mock.calls.length).toBeGreaterThan(afterMount))
    expect(result.current.status).toBe('pending')

    // And it is still one call per block, not a pull per render.
    const afterBlock = resolvePendingProbes.mock.calls.length
    await act(async () => {})
    expect(resolvePendingProbes).toHaveBeenCalledTimes(afterBlock)
  })
})

describe('useReconProbes — live sweep', () => {
  it('marks the send as live while the probe is still in flight', async () => {
    countPendingProbes.mockReturnValue(0)
    resolvePendingProbes.mockResolvedValue([])
    vi.mocked(sendReconProbe).mockResolvedValue({
      probe: null,
      tx: { hash: '0xabc' as Hash, status: 'confirmed' },
    } as Awaited<ReturnType<typeof sendReconProbe>>)

    const { result } = renderHook(() => useReconProbes(LOBBY, ATTACK, { recoverPending: false }))
    await act(async () => {
      await result.current.send(ATTACK, 'probe-1')
    })

    expect(result.current.live).toBe(true)
    expect(result.current.status).toBe('pending')
    expect(result.current.pendingCount).toBe(1)
    expect(result.current.results).toEqual([])
  })

  it('counts a probe as spent the moment send starts, before the hint lands', async () => {
    countPendingProbes.mockReturnValue(0)
    resolvePendingProbes.mockResolvedValue([])
    let release: (value: Awaited<ReturnType<typeof sendReconProbe>>) => void = () => {}
    vi.mocked(sendReconProbe).mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }),
    )

    const { result } = renderHook(() => useReconProbes(LOBBY, ATTACK, { recoverPending: false }))
    expect(result.current.pendingCount).toBe(0)

    let sendPromise: Promise<unknown> = Promise.resolve()
    act(() => {
      sendPromise = result.current.send(ATTACK, 'probe-1')
    })

    await waitFor(() => expect(result.current.pendingCount).toBe(1))

    await act(async () => {
      release({
        probe: null,
        tx: { hash: '0xabc' as Hash, status: 'confirmed' },
      } as Awaited<ReturnType<typeof sendReconProbe>>)
      await sendPromise
    })

    expect(result.current.pendingCount).toBe(1)
    expect(result.current.status).toBe('pending')
  })
})
