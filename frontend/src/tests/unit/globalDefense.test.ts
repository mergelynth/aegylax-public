import { describe, expect, it } from 'vitest'
import { drawPrizePool, globalDefenseJoinWindowBlocks, globalDefenseSchedule, isInGlobalDefenseJoinWindow, isProtocolOwnedLobby, isUnfilledPastDraw, PROTOCOL_ESCROW_ADDRESS, resolveJackpot } from '../../game/globalDefense'

describe('globalDefenseJoinWindowBlocks', () => {
  it('prefers a calendar day when the interval is longer than that', () => {
    // 1000 epochs × 150 blocks × 2s = ~83h, so a day fits and half the
    // interval is left to accumulate toward the next draw.
    const window = globalDefenseJoinWindowBlocks({
      intervalEpochs: 1000,
      epochBlocks: 150,
      blockTimeMs: 2000,
    })
    expect(window).toBe(Math.round((24 * 60 * 60 * 1000) / 2000))
    expect(window).toBeLessThan(1000 * 150 / 2)
  })

  it('falls back to half the interval when N epochs is shorter than a day', () => {
    // 1000 tiny epochs that together last well under 24h.
    const window = globalDefenseJoinWindowBlocks({
      intervalEpochs: 1000,
      epochBlocks: 1,
      blockTimeMs: 2000,
    })
    expect(window).toBe(500)
  })
})

describe('globalDefenseSchedule', () => {
  it('opens the lobby only in the last join-window of the interval', () => {
    const schedule = globalDefenseSchedule({
      currentEpoch: 457,
      intervalEpochs: 1000,
      epochBlocks: 150,
      genesisBlock: 1,
      blockTimeMs: 2000,
    })
    expect(schedule).not.toBeNull()
    expect(schedule!.nextEpoch).toBe(1000)
    expect(schedule!.openFromBlock).toBe(schedule!.deadlineBlock - schedule!.joinWindowBlocks)
    expect(schedule!.openFromBlock).toBeGreaterThan(457 * 150)
  })

  it('treats the join window as closed until openFromBlock', () => {
    const schedule = globalDefenseSchedule({
      currentEpoch: 457,
      intervalEpochs: 1000,
      epochBlocks: 150,
      genesisBlock: 1,
      blockTimeMs: 2000,
    })!
    expect(isInGlobalDefenseJoinWindow(schedule, schedule.openFromBlock - 1)).toBe(false)
    expect(isInGlobalDefenseJoinWindow(schedule, schedule.openFromBlock)).toBe(true)
    expect(isInGlobalDefenseJoinWindow(schedule, schedule.deadlineBlock)).toBe(false)
  })
})

describe('isProtocolOwnedLobby', () => {
  it('recognises the emulator sentinel and the deployed contract, not a name', () => {
    expect(isProtocolOwnedLobby(PROTOCOL_ESCROW_ADDRESS)).toBe(true)
    expect(isProtocolOwnedLobby('0x3530c6f6d5d01be2bfe2f0b364a2260d19621dee', '0x3530c6f6d5d01be2bfe2f0b364a2260d19621dee')).toBe(true)
    expect(isProtocolOwnedLobby('0x1111111111111111111111111111111111111111', '0x3530c6f6d5d01be2bfe2f0b364a2260d19621dee')).toBe(false)
  })
})

describe('isUnfilledPastDraw', () => {
  const room = {
    status: 'OPEN' as const,
    participantCount: 1,
    config: { participation: { minPlayers: 2, deadline: 1_000, deadlineBlock: 50 } },
  }

  it('is due once the deadline block has passed with a short room', () => {
    expect(isUnfilledPastDraw(room as never, 50, 0)).toBe(true)
    expect(isUnfilledPastDraw(room as never, 49, 0)).toBe(false)
  })

  it('is not due while the room could still fill', () => {
    expect(isUnfilledPastDraw({ ...room, participantCount: 2 } as never, 50, 0)).toBe(false)
  })
})

describe('resolveJackpot', () => {
  const openLobby = {
    status: 'OPEN' as const,
    creatorSettled: false,
    outcome: null,
    config: { economics: { prizePool: 0.023 } },
  }

  it('shows the accumulating pool when no draw is holding the money', () => {
    expect(resolveJackpot({ pool: 0.0366, lobbyId: null, lobby: null, phase: 'idle' }).jackpot).toBeCloseTo(0.0366)
  })

  it('counts a leftover lobby bounty with the idle pool, rather than painting 0', () => {
    expect(
      resolveJackpot({ pool: 0.0366, lobbyId: '0xdraw', lobby: openLobby as never, phase: 'idle' }).jackpot,
    ).toBeCloseTo(0.0596)
  })

  it('is 0 only when both the idle pool and the live bounty are empty', () => {
    expect(resolveJackpot({ pool: 0, lobbyId: null, lobby: null, phase: 'idle' }).jackpot).toBe(0)
  })

  it('shows the idle pool while an open draw has not taken it yet', () => {
    const unfunded = { ...openLobby, config: { economics: { prizePool: 0 } } }
    expect(
      resolveJackpot({ pool: 0.033, lobbyId: '0xdraw', lobby: unfunded as never, phase: 'open' }).jackpot,
    ).toBeCloseTo(0.033)
  })

  it('adds a mint-time bounty still sitting in the lobby to later misses', () => {
    expect(
      resolveJackpot({ pool: 0.01, lobbyId: '0xdraw', lobby: openLobby as never, phase: 'open' }).jackpot,
    ).toBeCloseTo(0.033)
  })

  it('counts later misses with the live bounty once the draw is in play', () => {
    expect(
      resolveJackpot({ pool: 0.01, lobbyId: '0xdraw', lobby: openLobby as never, phase: 'play' }).jackpot,
    ).toBeCloseTo(0.033)
  })

  it('does not flash the accumulating pool while the live lobby is still loading', () => {
    expect(resolveJackpot({ pool: 0.0366, lobbyId: '0xdraw', lobby: null, phase: 'open' }).jackpot).toBe(0)
  })
})

/*
 * The figure every screen prints for a Global Defense round.
 *
 * A draw is minted with `startPrizePool: 0` and the jackpot stays in
 * `globalDefensePool` until `commitDrawBounty` escrows it at activation —
 * so the lobby's own numbers describe an empty room for exactly as long as
 * anybody is deciding whether to defend it.
 */
describe('drawPrizePool', () => {
  it('adds the jackpot to a draw that has not escrowed it', () => {
    expect(
      drawPrizePool({ lobbyPool: 0, startPrizePool: 0, protocolOwned: true, drawBounty: 0.0288 }),
    ).toBeCloseTo(0.0288)
  })

  it('still names it on a draw that was cancelled without ever starting', () => {
    // Probe money left in the room, and a bounty that went straight back to
    // the pool it never left. Both are what the round was playing for.
    expect(
      drawPrizePool({ lobbyPool: 0.0006, startPrizePool: 0, protocolOwned: true, drawBounty: 0.0288 }),
    ).toBeCloseTo(0.0294)
  })

  it('does not count it twice once the draw holds it', () => {
    // `commitDrawBounty` is the only thing that makes a draw's own
    // `startPrizePool` non-zero, which is why it is the test.
    expect(
      drawPrizePool({ lobbyPool: 0.0288, startPrizePool: 0.0288, protocolOwned: true, drawBounty: 0.0288 }),
    ).toBeCloseTo(0.0288)
  })

  it('leaves a player operation exactly as the contract reported it', () => {
    expect(
      drawPrizePool({ lobbyPool: 0.0015, startPrizePool: 0.001, protocolOwned: false, drawBounty: 0.0288 }),
    ).toBeCloseTo(0.0015)
  })

  it('says what the lobby says when nothing recorded a jackpot', () => {
    expect(drawPrizePool({ lobbyPool: 0.0015, startPrizePool: 0, protocolOwned: true })).toBeCloseTo(0.0015)
    expect(
      drawPrizePool({ lobbyPool: 0.0015, startPrizePool: 0, protocolOwned: true, drawBounty: null }),
    ).toBeCloseTo(0.0015)
  })
})
