import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Hash, Lobby } from '../../game/types'
import { useLobby } from '../../hooks/useLobby'
import { buildTestLobbyConfig } from '../fixtures'

const getLobby = vi.fn()
const getLobbyParticipants = vi.fn()

vi.mock('../../game/gameService', () => ({
  getLobby: (...args: unknown[]) => getLobby(...args),
  getLobbyParticipants: (...args: unknown[]) => getLobbyParticipants(...args),
}))

const client = {
  subscribeToEvents: vi.fn().mockReturnValue(() => {}),
  subscribeToBlocks: vi.fn().mockReturnValue(() => {}),
}

vi.mock('../../hooks/useBlockchainClient', () => ({
  useBlockchainClient: () => client,
}))

vi.mock('../../hooks/useWallet', () => ({
  useWallet: () => ({ address: '0x1111111111111111111111111111111111111111' }),
}))

const ALPHA = '0xaaa1' as Hash
const BRAVO = '0xbbb2' as Hash

function buildLobby(id: Hash, name: string): Lobby {
  return {
    id,
    creationTxHash: id,
    creator: '0x1111111111111111111111111111111111111111',
    createdAtBlock: 1,
    status: 'OPEN',
    ending: 'NONE',
    config: buildTestLobbyConfig({ name }),
    participantCount: 1,
    participantAddresses: [],
    currentEpochId: null,
    activeAttackId: null,
    outcome: null,
    creatorSettlement: 0,
    creatorSettled: false,
    reveal: null,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve: (value: T) => resolve(value) }
}

describe('useLobby — switching operations', () => {
  it('drops the previous operation before the next read lands', async () => {
    const alpha = buildLobby(ALPHA, 'Alpha')
    const bravo = buildLobby(BRAVO, 'Bravo')
    getLobbyParticipants.mockResolvedValue([])
    getLobby.mockImplementation((_client: unknown, id: Hash) => Promise.resolve(id === ALPHA ? alpha : bravo))

    const { result, rerender } = renderHook(({ id }) => useLobby(id), { initialProps: { id: ALPHA } })
    await waitFor(() => expect(result.current.lobby?.config.name).toBe('Alpha'))

    const pending = deferred<Lobby>()
    getLobby.mockImplementation((_client: unknown, id: Hash) => (id === BRAVO ? pending.promise : Promise.resolve(alpha)))

    rerender({ id: BRAVO })
    expect(result.current.lobby).toBeNull()
    expect(result.current.loading).toBe(true)

    await act(async () => {
      pending.resolve(bravo)
    })
    await waitFor(() => expect(result.current.lobby?.config.name).toBe('Bravo'))
  })

  it('ignores a late reply for the operation that is no longer on screen', async () => {
    const alpha = buildLobby(ALPHA, 'Alpha')
    const bravo = buildLobby(BRAVO, 'Bravo')
    const fetchAlpha = deferred<Lobby>()
    const fetchBravo = deferred<Lobby>()
    getLobbyParticipants.mockResolvedValue([])
    getLobby.mockImplementation((_client: unknown, id: Hash) => (id === ALPHA ? fetchAlpha.promise : fetchBravo.promise))

    const { result, rerender } = renderHook(({ id }) => useLobby(id), { initialProps: { id: ALPHA } })
    rerender({ id: BRAVO })
    expect(result.current.lobby).toBeNull()

    await act(async () => {
      fetchAlpha.resolve(alpha)
    })
    expect(result.current.lobby).toBeNull()

    await act(async () => {
      fetchBravo.resolve(bravo)
    })
    await waitFor(() => expect(result.current.lobby?.config.name).toBe('Bravo'))
  })
})
