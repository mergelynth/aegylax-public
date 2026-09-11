import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlockchainClient } from '../../blockchain'
import type { Hash, Lobby } from '../../game/types'
import { useProtocolAdvance } from '../../hooks/useProtocolAdvance'
import { __resetEpochClockForTests } from '../../hooks/useEpochClock'
import { __resetProtocolAutoAttempt } from '../../blockchain/protocolAutoAttempt'
import { useCountdownClock } from '../../hooks/useSmoothCountdown'
import { buildTestLobbyConfig } from '../fixtures'

/**
 * A client that can be asked to make the transition, which is what puts the
 * control on screen at all — the emulator settles these lazily on every read
 * and so deliberately has no `maintain`.
 */
const maintain = vi.fn().mockResolvedValue(undefined)
/*
 * The block feed is part of the contract now: the deadline the hook judges
 * is a block, so the hook reads the chain's head. These operations carry no
 * deadline block (`buildTestLobbyConfig` leaves it 0), which is exactly the
 * fallback case — the wall clock still decides — and the feed only has to
 * exist for the hook to mount.
 */
const client = {
  maintain,
  getBlockNumber: vi.fn().mockResolvedValue(1),
  getBlock: vi.fn().mockResolvedValue({ number: 1, timestamp: Date.now() }),
  subscribeToBlocks: vi.fn().mockReturnValue(() => {}),
} as unknown as BlockchainClient

vi.mock('../../hooks/useBlockchainClient', () => ({
  useBlockchainClient: () => client,
}))

const SELF = '0x2222222222222222222222222222222222222222'

vi.mock('../../hooks/useWallet', () => ({
  useWallet: () => ({ address: SELF }),
}))

const BASE_MS = new Date('2026-08-12T10:00:00Z').getTime()
const DEADLINE_MS = BASE_MS + 60_000

/**
 * The once-per-session guard lives at module scope by design, so it is shared
 * by every test in this file. Each one therefore needs its own operation, the
 * same way two operations in a session are distinct.
 */
let nextLobbyId = 0
const freshId = () => `0xlobby${(nextLobbyId += 1)}` as Hash

function buildLobby(overrides: Partial<Lobby> = {}): Lobby {
  const config = buildTestLobbyConfig()
  return {
    id: freshId(),
    creationTxHash: '0xlobby' as Hash,
    creator: '0x1111111111111111111111111111111111111111',
    createdAtBlock: 1,
    status: 'OPEN',
  ending: 'NONE',
    participantCount: 2,
    participantAddresses: [],
    currentEpochId: null,
    activeAttackId: null,
    outcome: null,
    creatorSettlement: 0,
    creatorSettled: false,
    reveal: null,
    ...overrides,
    config: {
      ...config,
      ...overrides.config,
      participation: { ...config.participation, minPlayers: 2, deadline: DEADLINE_MS, ...overrides.config?.participation },
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(BASE_MS)

  /*
   * The app's countdown clock is one module-level sample shared by every
   * readout, so it still holds the instant the previous test advanced it
   * to — which would put this test's deadline in the past before it starts.
   * Mounting a subscriber for one tick re-samples it against the clock we
   * just set.
   */
  const probe = renderHook(() => useCountdownClock())
  act(() => void vi.advanceTimersByTime(300))
  probe.unmount()

  maintain.mockClear()
})
afterEach(() => {
  __resetEpochClockForTests()
  __resetProtocolAutoAttempt()
  vi.useRealTimers()
})

describe('useProtocolAdvance', () => {
  it('offers nothing while applications are still open', () => {
    const { result } = renderHook(() => useProtocolAdvance(buildLobby()))
    expect(result.current.action).toBeNull()
  })

  /**
   * The regression this hook was rewritten for.
   *
   * Nothing on chain changes when a registration deadline passes — the whole
   * point of the transition is that nobody has sent it — so the same `Lobby`
   * object is all the hook ever sees. Reading the clock inside the memo meant
   * the answer was whatever it had been when some *other* dependency last
   * changed: the player watched the countdown reach zero and the control
   * never appeared, leaving an operation that said "applications closed" with
   * no way to close them short of reloading the page.
   */
  it('offers the transition when the deadline passes under a lobby that never changed', () => {
    const lobby = buildLobby({ participantCount: 1 })
    const { result } = renderHook(() => useProtocolAdvance(lobby))

    expect(result.current.action).toBeNull()

    act(() => void vi.advanceTimersByTime(61_000))

    expect(result.current.action).toBe('cancelLobby')
    expect(result.current.label).toBe('Cancel & refund everyone')
  })

  /**
   * A filled operation has nothing to ask for.
   *
   * It was bound to its attack when it was created, so closing applications
   * moves money and nothing else — and the first probe or defense of the
   * round does that on its way past. Offering a "Close applications" button
   * here would spend a defender's gas on a transition their next click
   * performs for free.
   */
  it('never asks anybody to start an operation that filled up', () => {
    const lobby = buildLobby({ participantCount: 2 })
    const { result } = renderHook(() => useProtocolAdvance(lobby))

    act(() => void vi.advanceTimersByTime(61_000))

    expect(result.current.action).toBeNull()
    expect(maintain).not.toHaveBeenCalled()
  })

  it('has nothing left to offer once somebody has made the transition', () => {
    const lobby = buildLobby({ status: 'ACTIVE' })
    const { result } = renderHook(() => useProtocolAdvance(lobby))

    act(() => void vi.advanceTimersByTime(61_000))

    expect(result.current.action).toBeNull()
  })

  it('sends the transition the chain is behind on', async () => {
    const lobby = buildLobby({ participantCount: 1 })
    const { result } = renderHook(() => useProtocolAdvance(lobby))
    act(() => void vi.advanceTimersByTime(61_000))

    await act(async () => void (await result.current.run()))

    expect(maintain).toHaveBeenCalledWith('cancelLobby', lobby.id, SELF)
  })
})

/**
 * The operation runs as one sequence — deadline, countdown to the launch,
 * flight, reveal — and none of the steps between them is a decision anybody
 * makes. So a defender is never asked to authorise one.
 */
describe('useProtocolAdvance: advancing without being asked', () => {
  it('cancels for a defender the moment an under-filled deadline passes', () => {
    const lobby = buildLobby({ participantCount: 1, participantAddresses: [SELF] })
    renderHook(() => useProtocolAdvance(lobby))

    expect(maintain).not.toHaveBeenCalled()

    act(() => void vi.advanceTimersByTime(61_000))

    expect(maintain).toHaveBeenCalledWith('cancelLobby', lobby.id, SELF)
  })

  it('advances an operation the creator is watching, defender or not', () => {
    const lobby = buildLobby({ participantCount: 1, creator: SELF, participantAddresses: [] })
    renderHook(() => useProtocolAdvance(lobby))

    act(() => void vi.advanceTimersByTime(61_000))

    expect(maintain).toHaveBeenCalledWith('cancelLobby', lobby.id, SELF)
  })

  /**
   * Reading an operation is not joining it. A passer-by's wallet must stay
   * shut and their gas unspent — but the control is still there, so they may
   * push it along if they choose to.
   */
  it('never spends a passer-by’s gas, while still offering them the control', () => {
    const lobby = buildLobby({
      participantCount: 1,
      creator: '0x9999999999999999999999999999999999999999',
      participantAddresses: [],
    })
    const { result } = renderHook(() => useProtocolAdvance(lobby))

    act(() => void vi.advanceTimersByTime(61_000))

    expect(maintain).not.toHaveBeenCalled()
    expect(result.current.action).toBe('cancelLobby')
  })

  /**
   * The guard the earlier automatic version got wrong: it lived in a `useRef`,
   * which a remount resets, so navigating away and back sent the same
   * transaction again.
   */
  it('attempts a transition once per session, across remounts', () => {
    const lobby = buildLobby({ participantCount: 1, participantAddresses: [SELF] })

    const first = renderHook(() => useProtocolAdvance(lobby))
    act(() => void vi.advanceTimersByTime(61_000))
    expect(maintain).toHaveBeenCalledTimes(1)
    first.unmount()

    renderHook(() => useProtocolAdvance(lobby))
    act(() => void vi.advanceTimersByTime(1_000))

    expect(maintain).toHaveBeenCalledTimes(1)
  })

  it('leaves a failed attempt retryable by hand, since nothing else will retry it', async () => {
    maintain.mockRejectedValueOnce(new Error('insufficient funds'))
    const lobby = buildLobby({ participantCount: 1, participantAddresses: [SELF] })
    const { result } = renderHook(() => useProtocolAdvance(lobby))

    await act(async () => void vi.advanceTimersByTime(61_000))

    expect(result.current.error).toMatch(/insufficient funds/i)
    expect(result.current.action).toBe('cancelLobby')

    await act(async () => void (await result.current.run()))

    expect(maintain).toHaveBeenCalledTimes(2)
    expect(result.current.error).toBeNull()
  })
})
