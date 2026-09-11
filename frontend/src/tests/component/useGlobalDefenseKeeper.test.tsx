import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BlockchainClient } from '../../blockchain'
import { PROTOCOL_ESCROW_ADDRESS } from '../../game/globalDefense'
import type { Hash, Lobby } from '../../game/types'
import type { GlobalDefenseHudState } from '../../hooks/useGlobalDefenseDraw'
import { useGlobalDefenseKeeper } from '../../hooks/useGlobalDefenseKeeper'
import { __resetProtocolAutoAttempt } from '../../blockchain/protocolAutoAttempt'
import { __resetEpochClockForTests } from '../../hooks/useEpochClock'
import { buildTestLobbyConfig } from '../fixtures'

const maintain = vi.fn().mockResolvedValue(undefined)
const client = {
  maintain,
  getBlockNumber: vi.fn().mockResolvedValue(1),
  getBlock: vi.fn().mockResolvedValue({ number: 1, timestamp: Date.now() }),
  subscribeToBlocks: vi.fn().mockReturnValue(() => {}),
} as unknown as BlockchainClient

vi.mock('../../hooks/useBlockchainClient', () => ({
  useBlockchainClient: () => client,
}))

const wallet = vi.hoisted(() => ({
  address: '0x2222222222222222222222222222222222222222' as `0x${string}`,
  walletKind: 'managed' as string,
}))
const SELF = wallet.address

vi.mock('../../hooks/useWallet', () => ({
  useWallet: () => wallet,
}))

const BASE_MS = new Date('2026-08-12T10:00:00Z').getTime()
const DEADLINE_MS = BASE_MS + 60_000

let nextLobbyId = 0
const freshId = () => `0xgd${(nextLobbyId += 1)}` as Hash

function stuckLobby(overrides: Partial<Lobby> = {}): Lobby {
  const config = buildTestLobbyConfig()
  return {
    id: freshId(),
    creationTxHash: '0xdraw' as Hash,
    creator: PROTOCOL_ESCROW_ADDRESS,
    createdAtBlock: 1,
    status: 'OPEN',
    ending: 'NONE',
    participantCount: 1,
    participantAddresses: [],
    currentEpochId: 2000,
    activeAttackId: null,
    outcome: null,
    creatorSettlement: 0,
    creatorSettled: false,
    reveal: null,
    ...overrides,
    config: {
      ...config,
      ...overrides.config,
      participation: {
        ...config.participation,
        minPlayers: 2,
        deadline: DEADLINE_MS,
        deadlineBlock: 0,
        ...overrides.config?.participation,
      },
    },
  }
}

function drawOf(lobby: Lobby | null): GlobalDefenseHudState {
  return {
    pool: 0,
    jackpot: lobby?.config.economics.prizePool ?? 0,
    lobbyId: null,
    joinable: false,
    inPlay: true,
    nextEpoch: 3000,
    interval: 1000,
    openFromBlock: null,
    deadlineBlock: null,
    ready: true,
    drawLobbyId: lobby?.id ?? null,
    drawLobby: lobby,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(DEADLINE_MS + 1_000)
  wallet.address = SELF
  wallet.walletKind = 'managed'
  maintain.mockClear()
  __resetProtocolAutoAttempt()
})
afterEach(() => {
  __resetEpochClockForTests()
  __resetProtocolAutoAttempt()
  vi.useRealTimers()
})

describe('useGlobalDefenseKeeper', () => {
  it('cancels an under-filled protocol draw from a managed wallet on any page', () => {
    const lobby = stuckLobby()
    renderHook(() => useGlobalDefenseKeeper(drawOf(lobby)))

    expect(maintain).toHaveBeenCalledWith('cancelLobby', lobby.id, SELF)
  })

  it('does not open an external wallet that never sat in the room', () => {
    wallet.walletKind = 'external'
    const lobby = stuckLobby()
    renderHook(() => useGlobalDefenseKeeper(drawOf(lobby)))

    expect(maintain).not.toHaveBeenCalled()
  })

  it('cancels for an external wallet that did join the draw, even off that page', () => {
    wallet.walletKind = 'external'
    const lobby = stuckLobby({ participantAddresses: [SELF] })
    renderHook(() => useGlobalDefenseKeeper(drawOf(lobby)))

    expect(maintain).toHaveBeenCalledWith('cancelLobby', lobby.id, SELF)
  })

  it('leaves a player-created under-filled room alone', () => {
    const lobby = stuckLobby({ creator: '0x1111111111111111111111111111111111111111' })
    renderHook(() => useGlobalDefenseKeeper(drawOf(lobby)))

    expect(maintain).not.toHaveBeenCalled()
  })
})
