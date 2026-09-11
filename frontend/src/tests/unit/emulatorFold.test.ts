import { describe, expect, it } from 'vitest'
import { ethToWei } from '../../blockchain/contract/codec'
import type { Lobby, Participant } from '../../game/types'
import { foldPlayerLobbies, foldPlayerRecord, foldLobbySummaries } from '../../hooks/emulatorFold'
import { moneyLostWei, moneyWonWei } from '../../hooks/usePlayerRecord'

const ALICE = '0x1111111111111111111111111111111111111111' as const
const BOB = '0x2222222222222222222222222222222222222222' as const

function lobby(overrides: Partial<Lobby> = {}): Lobby {
  return {
    id: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
    creationTxHash: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
    creator: BOB,
    createdAtBlock: 10,
    status: 'RESOLVED',
    ending: 'COMPLETED',
    config: {
      name: 'Sunrise',
      participation: { minPlayers: 2, maxPlayers: 20, entryPrice: 0.0005, deadline: Date.now(), deadlineBlock: 0 },
      economics: { prizePool: 0.001, creatorFeePercent: 15, protocolJoinFee: 0.0005 },
    drones: { freeCount: 3, price: 0.0002, maxCount: 6 },
      attack: {
        epochBlocks: 16,
        sectorSpanKm: 1000,
        interceptionRadiusSectors: 0.14,
        defenseSpeedKmPerBlock: 1,
      },
      payout: { rewardAsset: { kind: 'ETH' } },
    },
    participantCount: 1,
    participantAddresses: [ALICE],
    currentEpochId: 1,
    activeAttackId: 'a1',
    outcome: {
      attackId: 'a1',
      intercepted: true,
      winners: [ALICE],
      rewardPerWinner: 0.002,
      interceptionBlock: 40,
      interceptionPoint: null,
      interceptionProgress: 0.5,
      interceptionRadiusKm: 140,
      resolvedAtBlock: 40,
      resolvedAtTimestamp: 0,
    },
    creatorSettlement: 0,
    creatorSettled: false,
    reveal: null,
    ...overrides,
  }
}

function seat(overrides: Partial<Participant> = {}): Participant {
  return {
    lobbyId: '0xaaaa000000000000000000000000000000000000000000000000000000000001',
    address: ALICE,
    joinTxHash: '0xbbbb',
    joinedAtBlock: 12,
    freeDronesRemaining: 0,
    purchasedDrones: 0,
    actionCount: 1,
    probeIds: [],
    defenseAttemptIds: ['d1'],
    payoutState: 'PENDING',
    paidIn: 0.0005,
    probesPaid: 0,
    refunded: false,
    lastProbeBlock: 0,
    ...overrides,
  }
}

describe('emulatorFold', () => {
  it('counts a won round as played, won, and winnings', () => {
    const record = foldPlayerRecord([lobby()], [seat()], ALICE)
    expect(record.roundsPlayed).toBe(1)
    expect(record.interceptions).toBe(1)
    expect(record.recentRounds).toEqual([true])
    expect(moneyWonWei(record)).toBe(ethToWei(0.002))
    expect(moneyLostWei(record)).toBe(0n)
  })

  it('counts a miss as lost money, not a win', () => {
    const record = foldPlayerRecord(
      [lobby({
        outcome: {
          attackId: 'a1',
          intercepted: false,
          winners: [],
          rewardPerWinner: 0,
          interceptionBlock: null,
          interceptionPoint: null,
          interceptionProgress: null,
          interceptionRadiusKm: 140,
          resolvedAtBlock: 40,
          resolvedAtTimestamp: 0,
        },
      })],
      [seat()],
      ALICE,
    )
    expect(record.interceptions).toBe(0)
    expect(moneyWonWei(record)).toBe(0n)
    expect(moneyLostWei(record)).toBe(ethToWei(0.0005))
  })

  it('lists this tab’s rooms newest first, and seats the wallet in live ones', () => {
    const open = lobby({
      id: '0xopen',
      creationTxHash: '0xopen',
      status: 'OPEN',
      ending: 'NONE',
      createdAtBlock: 20,
      outcome: null,
      activeAttackId: null,
    })
    const summaries = foldLobbySummaries([lobby({ createdAtBlock: 5 }), open])
    expect(summaries[0].status).toBe('open')
    expect(summaries[1].status).toBe('finished')

    const mine = foldPlayerLobbies([open], [seat({ lobbyId: open.id })], ALICE)
    expect(mine.live).toHaveLength(1)
    expect(mine.live[0].joined).toBe(true)
  })
})
