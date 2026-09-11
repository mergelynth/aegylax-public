import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Address, Hash, Lobby, Participant } from '../../game/types'
import { useSettlement } from '../../hooks/useSettlement'
import { buildTestLobbyConfig } from '../fixtures'

const claimReward = vi.fn()

vi.mock('../../game/gameService', () => ({
  claimReward: (...args: unknown[]) => claimReward(...args),
  claimRefund: vi.fn(),
  getLobby: vi.fn(),
  settleCreator: vi.fn(),
}))

const WALLET = '0x2222222222222222222222222222222222222222' as Address

vi.mock('../../hooks/useBlockchainClient', () => ({
  useBlockchainClient: () => ({}),
}))

vi.mock('../../hooks/useWallet', () => ({
  useWallet: () => ({ address: WALLET }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve: (value: T) => resolve(value) }
}

function buildLobby(): Lobby {
  return {
    id: '0xlobby' as Hash,
    creationTxHash: '0xlobby' as Hash,
    creator: '0x1111111111111111111111111111111111111111',
    createdAtBlock: 1,
    status: 'RESOLVED',
    ending: 'COMPLETED',
    config: buildTestLobbyConfig(),
    participantCount: 2,
    participantAddresses: [],
    currentEpochId: 1,
    activeAttackId: 'atk-1',
    outcome: {
      attackId: 'atk-1',
      intercepted: true,
      interceptionPoint: null,
      interceptionBlock: 10,
      interceptionProgress: 0.5,
      interceptionRadiusKm: 140,
      winners: [WALLET],
      rewardPerWinner: 0.25,
      resolvedAtBlock: 12,
      resolvedAtTimestamp: Date.now(),
    },
    creatorSettlement: 0,
    creatorSettled: true,
    reveal: null,
  }
}

function buildParticipant(): Participant {
  return {
    lobbyId: '0xlobby' as Hash,
    address: WALLET,
    joinTxHash: '0xjoin' as Hash,
    joinedAtBlock: 2,
    freeDronesRemaining: 0,
    purchasedDrones: 0,
    actionCount: 1,
    probeIds: [],
    defenseAttemptIds: ['def-1'],
    payoutState: 'PENDING',
    paidIn: 0.01,
    probesPaid: 0,
    refunded: false,
    lastProbeBlock: 0,
  }
}

describe('useSettlement — claim lock', () => {
  it('stays busy until the lobby re-read finishes, not merely until the write returns', async () => {
    const write = deferred<{ amount: number | null }>()
    const settled = deferred<void>()
    claimReward.mockReturnValue(write.promise)
    const onSettled = vi.fn(() => settled.promise)

    const { result } = renderHook(() => useSettlement(buildLobby(), buildParticipant(), onSettled))
    expect(result.current).toHaveLength(1)
    expect(result.current[0].busy).toBe(false)
    expect(result.current[0].claimed).toBe(false)

    act(() => {
      result.current[0].onClaim()
    })
    await waitFor(() => expect(result.current[0].busy).toBe(true))

    act(() => {
      result.current[0].onClaim()
    })
    expect(claimReward).toHaveBeenCalledOnce()

    await act(async () => {
      write.resolve({ amount: 0.25 })
    })
    expect(result.current[0].busy).toBe(true)
    expect(onSettled).toHaveBeenCalledOnce()

    await act(async () => {
      settled.resolve()
    })
    await waitFor(() => expect(result.current[0].busy).toBe(false))
  })
})

/*
 * `key` is the settlement path; `parts` is what is actually in the sum, and
 * the two answer different questions. A creator whose round nobody
 * intercepted is paid through `claimReward` and owed the Creator Fee alone,
 * so a label taken from `key` printed REWARD over a round they had lost.
 */
describe('useSettlement — what the sum is made of', () => {
  it('itemises a winner as a prize share', () => {
    const { result } = renderHook(() => useSettlement(buildLobby(), buildParticipant(), vi.fn()))
    expect(result.current[0].key).toBe('reward')
    expect(result.current[0].parts).toEqual(['prize'])
  })

  it('itemises a losing creator as a fee, not a prize', () => {
    const lobby: Lobby = {
      ...buildLobby(),
      creator: WALLET,
      creatorSettlement: 0.0001,
      creatorSettled: false,
      outcome: { ...buildLobby().outcome!, intercepted: false, rewardPerWinner: 0 },
    }
    const missed: Participant = { ...buildParticipant(), payoutState: 'NONE' }

    const { result } = renderHook(() => useSettlement(lobby, missed, vi.fn()))
    expect(result.current).toHaveLength(1)
    expect(result.current[0].key).toBe('reward')
    expect(result.current[0].parts).toEqual(['fee'])
    expect(result.current[0].amount).toBeCloseTo(0.0001)
  })

  it('itemises a winning creator as both', () => {
    const lobby: Lobby = {
      ...buildLobby(),
      creator: WALLET,
      creatorSettlement: 0.0001,
      creatorSettled: false,
    }

    const { result } = renderHook(() => useSettlement(lobby, buildParticipant(), vi.fn()))
    expect(result.current[0].parts).toEqual(['prize', 'fee'])
  })
})
