import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DronePanel } from '../../components/drones/DronePanel'
import type { Lobby, Participant } from '../../game/types'

const lobby: Lobby = {
  id: '0xlobby' as Lobby['id'],
  creationTxHash: '0xlobby' as Lobby['id'],
  creator: '0xcreator' as Lobby['creator'],
  createdAtBlock: 1,
  status: 'OPEN',
  ending: 'NONE',
  config: {
    name: 'Test Operation',
    participation: { minPlayers: 2, maxPlayers: 8, entryPrice: 0.01, deadline: Date.now() + 10_000, deadlineBlock: 0 },
    economics: { prizePool: 0, creatorFeePercent: 5, protocolJoinFee: 0 },
    drones: { freeCount: 3, price: 0.002, maxCount: 6 },
    attack: { epochBlocks: 150, sectorSpanKm: 1000, interceptionRadiusSectors: 0.14, defenseSpeedKmPerBlock: 250 },
    payout: { rewardAsset: { kind: 'ETH' } },
  },
  participantCount: 1,
  participantAddresses: [],
  currentEpochId: null,
  activeAttackId: null,
  outcome: null,
  creatorSettlement: 0,
  creatorSettled: false,
  reveal: null,
}

const participant: Participant = {
  lobbyId: lobby.id,
  address: '0xplayer' as Participant['address'],
  joinTxHash: '0xjoin' as Participant['joinTxHash'],
  joinedAtBlock: 1,
  freeDronesRemaining: 3,
  purchasedDrones: 1,
  actionCount: 0,
  probeIds: [],
  defenseAttemptIds: [],
  payoutState: 'NONE',
  paidIn: 0.011,
  probesPaid: 0.002,
  refunded: false,
  lastProbeBlock: 0,
}

describe('<DronePanel /> (spec §30, §34)', () => {
  it('calls onBuyDrone when the purchase button is clicked', () => {
    const onBuyDrone = vi.fn()
    render(
      <DronePanel
        lobby={lobby}
        participant={participant}
        onBuyDrone={onBuyDrone}
        isPurchasing={false}
        blockedReason={null}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /^buy probe /i }))
    expect(onBuyDrone).toHaveBeenCalledTimes(1)
  })

  /**
   * The panel takes a reason and reports it; it does not decide one.
   *
   * Whether buying is open is a question about the operation's phase and
   * the protocol's allowance, and it is answered once, in
   * `probePurchaseBlockedReason`, because the contract enforces the same
   * window and the two must not be able to disagree. A panel that
   * re-derived "maximum reached" from its own props was a second copy of
   * that rule with no test holding it to the first.
   */
  it('reports the reason it was given, and blocks on it', () => {
    render(
      <DronePanel
        lobby={lobby}
        participant={participant}
        onBuyDrone={() => {}}
        isPurchasing={false}
        blockedReason="The attack has launched — probes can no longer be bought"
      />,
    )

    expect(screen.getByRole('button', { name: /^buy probe /i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /^buy probe /i })).toHaveAttribute('data-invite', 'off')
    expect(screen.getByRole('note')).toHaveTextContent(/attack has launched/i)
  })

  it('says nothing when buying is open', () => {
    render(
      <DronePanel
        lobby={lobby}
        participant={participant}
        onBuyDrone={() => {}}
        isPurchasing={false}
        blockedReason={null}
      />,
    )

    expect(screen.getByRole('button', { name: /^buy probe /i })).toBeEnabled()
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })

  it('states the current allotment on the button, not beside it', () => {
    render(
      <DronePanel
        lobby={lobby}
        participant={participant}
        onBuyDrone={() => {}}
        isPurchasing={false}
        blockedReason={null}
      />,
    )

    const button = screen.getByRole('button', { name: /buy probe/i })
    // 3 free + 1 bought, cap 6 — remaining over max, not a second name for the probe.
    expect(button).toHaveAccessibleName(/4 ready/i)
    expect(button).toHaveTextContent('4')
    expect(button).toHaveTextContent('/6')
    expect(button.querySelector('svg')).toBeNull()
    expect(button).not.toHaveTextContent(/spent|bought|ready/i)
    expect(button).toHaveAttribute('data-invite', 'on')
    expect(screen.queryByText(/your probes/i)).not.toBeInTheDocument()
  })

  it('keeps a compact Buy in the drawer after the hero has gone', () => {
    render(
      <DronePanel
        layout="drawer"
        lobby={lobby}
        participant={participant}
        onBuyDrone={() => {}}
        isPurchasing={false}
        blockedReason={null}
      />,
    )

    expect(screen.getByText(/your probes/i)).toBeInTheDocument()
    expect(screen.getByText(/4 ready/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^buy probe /i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^buy probe /i })).not.toHaveAttribute('data-invite')
  })
})
