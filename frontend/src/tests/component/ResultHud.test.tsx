import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ResultHud } from '../../components/command/ResultHud'
import type {
  Address,
  AttackRevealData,
  DefenseResult,
  Hash,
  Participant,
} from '../../game/types'

const LOBBY = '0xlobby' as Hash
const YOU = '0x00000000000000000000000000000000000000aa' as Address
const RIVAL = '0x00000000000000000000000000000000000000bb' as Address

function participant(address: Address, actions: number, probes: number): Participant {
  return {
    lobbyId: LOBBY,
    address,
    joinTxHash: '0xjoin' as Hash,
    joinedAtBlock: 1,
    freeDronesRemaining: 0,
    purchasedDrones: 0,
    actionCount: actions,
    probeIds: Array.from({ length: probes }, (_, index) => `probe-${address}-${index}`),
    defenseAttemptIds: [],
    payoutState: 'NONE',
    paidIn: 0.01,
    probesPaid: 0,
    refunded: false,
    lastProbeBlock: 0,
  }
}

function result(participantAddress: Address, status: DefenseResult['status'], isWinner = false): DefenseResult {
  return {
    attemptId: `attempt-${participantAddress}`,
    participant: participantAddress,
    status,
    interceptionProgress: status === 'intercepted' ? 0.5 : null,
    interceptionBlock: status === 'intercepted' ? 40 : null,
    interceptionPoint: null,
    missDistanceKm: status === 'intercepted' ? null : 900,
    arrivalBlock: status === 'intercepted' ? 38 : 40,
    isWinner,
    reason: '',
  }
}

function reveal(results: DefenseResult[], winners: Address[]): AttackRevealData {
  return {
    attackId: 'attack-1',
    trajectory: {
      pointA: { x: 0, y: 0 },
      pointB: { x: 100, y: 100 },
      impactAngleRadians: 0,
      lengthKm: 1000,
      speedKmPerBlock: 50,
    },
    outcome: {
      attackId: 'attack-1',
      intercepted: winners.length > 0,
      interceptionPoint: null,
      interceptionBlock: winners.length > 0 ? 40 : null,
      interceptionProgress: winners.length > 0 ? 0.5 : null,
      interceptionRadiusKm: 320,
      winners,
      rewardPerWinner: winners.length > 0 ? 1 : 0,
      resolvedAtBlock: 50,
      resolvedAtTimestamp: 0,
    },
    attempts: [],
    results,
    revealedAtBlock: 51,
    launchBlock: 0,
    flightDurationBlocks: 50,
    scored: true,
  }
}

const roster = [participant(YOU, 3, 2), participant(RIVAL, 5, 4)]

/** The pill carrying a given label, so a figure is read off the right one. */
function pill(label: string): HTMLElement {
  return screen.getByText(label).parentElement!
}

describe('<ResultHud /> (ТЗ §10)', () => {
  it('reports the whole round as four short figures', () => {
    render(
      <ResultHud
        reveal={reveal([result(YOU, 'intercepted', true), result(RIVAL, 'missed')], [YOU])}
        participants={roster}
        viewer={YOU}
      />,
    )

    expect(pill('My status')).toHaveTextContent('YOU HIT')
    expect(pill('Winners')).toHaveTextContent('1')
    // Everybody who took part, and every probe they spent between them.
    expect(pill('Defenders')).toHaveTextContent('2')
    expect(pill('Probes')).toHaveTextContent('6')
  })

  it('tells a defender who missed apart from one who never defended (ТЗ §10)', () => {
    const missed = render(
      <ResultHud reveal={reveal([result(YOU, 'missed')], [])} participants={roster} viewer={YOU} />,
    )
    expect(pill('My status')).toHaveTextContent('YOU MISSED')
    missed.unmount()

    // A defender who never submitted did not miss — they did not play, and
    // flattening the two would misreport the round.
    render(<ResultHud reveal={reveal([result(RIVAL, 'missed')], [])} participants={roster} viewer={YOU} />)
    expect(pill('My status')).toHaveTextContent('NO DEFENSE')
  })

  it('names a spatial hit that arrived after the threat as TOO LATE, not as a miss in space', () => {
    const late = result(YOU, 'missed')
    late.interceptionBlock = 40
    late.arrivalBlock = 48
    late.missDistanceKm = 10
    render(<ResultHud reveal={reveal([late], [])} participants={roster} viewer={YOU} />)
    expect(pill('My status')).toHaveTextContent('TOO LATE')
  })

  it('names a spatial hit that arrived before the threat as TOO EARLY', () => {
    const early = result(YOU, 'missed')
    early.interceptionBlock = 40
    early.arrivalBlock = 32
    early.missDistanceKm = 10
    render(<ResultHud reveal={reveal([early], [])} participants={roster} viewer={YOU} />)
    expect(pill('My status')).toHaveTextContent('TOO EARLY')
  })

  it('counts every hit in the winning block as a winner', () => {
    render(
      <ResultHud
        reveal={reveal(
          [result(YOU, 'intercepted', true), result(RIVAL, 'intercepted', true)],
          [YOU, RIVAL],
        )}
        participants={roster}
        viewer={YOU}
      />,
    )

    expect(pill('My status')).toHaveTextContent('YOU HIT')
    expect(pill('Winners')).toHaveTextContent('2')
  })

  it('names a snapshot hit that lost to a higher kill as ALREADY DOWN', () => {
    render(
      <ResultHud
        reveal={reveal([result(YOU, 'intercepted', false), result(RIVAL, 'intercepted', true)], [RIVAL])}
        participants={roster}
        viewer={YOU}
      />,
    )

    // Not MISSED: nothing was wrong with the shot, and telling this defender
    // to fix their aim would be telling them to fix the wrong thing.
    expect(pill('My status')).toHaveTextContent('ALREADY DOWN')
    expect(pill('Winners')).toHaveTextContent('1')
  })

  it('says plainly when nobody stopped it', () => {
    render(<ResultHud reveal={reveal([result(YOU, 'missed')], [])} participants={roster} viewer={YOU} />)
    expect(pill('Winners')).toHaveTextContent('0')
  })
})
