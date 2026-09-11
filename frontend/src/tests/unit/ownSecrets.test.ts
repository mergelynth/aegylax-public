import { describe, expect, it } from 'vitest'
import {
  addPendingProbe,
  readOwnPoint,
  readPendingProbes,
  rememberUnlockedRound,
  removePendingProbe,
  wasRoundUnlocked,
  writeOwnPoint,
  type PendingProbe,
} from '../../blockchain/contract/ownSecrets'
import type { Address, Hash } from '../../game/types'

const ATTACK = '0xabc' as Hash
const LOBBY = '0xdef' as Hash
const WALLET = '0x00000000000000000000000000000000000000aa' as Address
const OTHER = '0x00000000000000000000000000000000000000AA' as Address

const point = { sector: { column: 2, row: 1 }, offsetX: 0.25, offsetY: 0.75 }

describe('own Defense Point storage', () => {
  it('survives a reload for the same wallet, checksum notwithstanding', () => {
    writeOwnPoint(ATTACK, WALLET, point)
    expect(readOwnPoint(ATTACK, OTHER)).toEqual(point)
  })

  it('does not leak a point to another attack or another wallet', () => {
    writeOwnPoint(ATTACK, WALLET, point)
    expect(readOwnPoint('0xother' as Hash, WALLET)).toBeNull()
    expect(readOwnPoint(ATTACK, '0x00000000000000000000000000000000000000bb' as Address)).toBeNull()
  })
})

describe('pending probe storage', () => {
  const pending: PendingProbe = {
    handle: '0x1111111111111111111111111111111111111111111111111111111111111111' as Hash,
    probeIndex: 1,
    lobbyId: LOBBY,
    attackId: ATTACK,
    probeId: 'probe-1',
    requestedBy: WALLET,
    txHash: '0x2222222222222222222222222222222222222222222222222222222222222222' as Hash,
    generatedAtBlock: 42,
    readableAtBlock: 50,
  }

  it('keeps a handle that has been paid for but not yet opened', () => {
    addPendingProbe(pending)
    expect(readPendingProbes(LOBBY, ATTACK, OTHER)).toEqual([pending])
  })

  it('does not duplicate the same handle', () => {
    addPendingProbe(pending)
    addPendingProbe(pending)
    expect(readPendingProbes(LOBBY, ATTACK, WALLET)).toHaveLength(1)
  })

  it('drops a handle once it has been opened', () => {
    addPendingProbe(pending)
    removePendingProbe(LOBBY, ATTACK, WALLET, pending.handle)
    expect(readPendingProbes(LOBBY, ATTACK, WALLET)).toEqual([])
  })
})

describe('unlocked round storage', () => {
  it('remembers an unlock across a reload of the same operation', () => {
    expect(wasRoundUnlocked(LOBBY)).toBe(false)
    rememberUnlockedRound(LOBBY)
    expect(wasRoundUnlocked(LOBBY)).toBe(true)
  })

  it('does not treat another operation as already unlocked', () => {
    rememberUnlockedRound(LOBBY)
    expect(wasRoundUnlocked('0xother' as Hash)).toBe(false)
  })
})
