import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { JoinLobbyButton } from '../../components/lobby/JoinLobbyButton'
import type { Lobby } from '../../game/types'
import { renderWithProviders } from '../testUtils'

const baseLobby: Lobby = {
  id: '0xlobby' as Lobby['id'],
  creationTxHash: '0xlobby' as Lobby['id'],
  creator: '0xcreator' as Lobby['creator'],
  createdAtBlock: 1,
  status: 'OPEN',
  ending: 'NONE',
  config: {
    name: 'Test Operation',
    participation: { minPlayers: 2, maxPlayers: 8, entryPrice: 0.01, deadline: Date.now() + 60_000, deadlineBlock: 0 },
    economics: { prizePool: 0, creatorFeePercent: 5, protocolJoinFee: 0 },
    drones: { freeCount: 3, price: 0.002, maxCount: 6 },
    attack: { epochBlocks: 150, sectorSpanKm: 1000, interceptionRadiusSectors: 0.14, defenseSpeedKmPerBlock: 250 },
    payout: { rewardAsset: { kind: 'ETH' } },
  },
  participantCount: 0,
  participantAddresses: [],
  currentEpochId: null,
  activeAttackId: null,
  outcome: null,
  creatorSettlement: 0,
  creatorSettled: false,
  reveal: null,
}

describe('<JoinLobbyButton /> (spec §17-18)', () => {
  it('shows JOIN for an OPEN lobby before the deadline', () => {
    renderWithProviders(<JoinLobbyButton lobby={baseLobby} hasJoined={false} onJoined={() => {}} />)
    expect(screen.getByRole('button', { name: /join/i })).toBeInTheDocument()
  })

  it('renders nothing once the caller has already joined', () => {
    const { container } = renderWithProviders(<JoinLobbyButton lobby={baseLobby} hasJoined onJoined={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing once the lobby has started', () => {
    const activeLobby: Lobby = { ...baseLobby, status: 'ACTIVE' }
    const { container } = renderWithProviders(<JoinLobbyButton lobby={activeLobby} hasJoined={false} onJoined={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says why a join failed instead of snapping back to an unchanged button', async () => {
    /*
     * The hook has always carried `join.error` and nothing rendered it, so a
     * refused join looked exactly like a dead control — the report that
     * started this was "I press Join and nothing happens". The lobby in this
     * fixture exists only in the props, so the write reaches the chain and is
     * refused there, which is the shape of the commonest real refusal: a
     * rate-limited RPC failing the simulation before a wallet ever opens.
     */
    const user = userEvent.setup()
    renderWithProviders(<JoinLobbyButton lobby={baseLobby} hasJoined={false} onJoined={() => {}} />)

    await user.click(screen.getByRole('button', { name: /join/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/not found/i)
  })

  it('signs a visitor in from the press rather than refusing them', async () => {
    /*
     * ТЗ §2 — the same resume Defense Setup does, on the app's primary call
     * to action. Pressing Join while signed out used to answer "Connect a
     * wallet before joining a lobby." — a refusal printed under the button,
     * on a screen with nothing to press to satisfy it. Joining *is* the
     * intent, so the press signs them in and finishes the join itself; here
     * that carries all the way to the chain's own answer, which is only
     * reachable at all once a wallet is attached.
     */
    const user = userEvent.setup()
    renderWithProviders(<JoinLobbyButton lobby={baseLobby} hasJoined={false} onJoined={() => {}} />)

    await user.click(screen.getByRole('button', { name: /join/i }))

    expect(await screen.findByRole('alert')).not.toHaveTextContent(/connect a wallet/i)
  })

  it('renders nothing after the deadline has passed', () => {
    const expiredLobby: Lobby = {
      ...baseLobby,
      config: { ...baseLobby.config, participation: { ...baseLobby.config.participation, deadline: Date.now() - 1000 } },
    }
    const { container } = renderWithProviders(<JoinLobbyButton lobby={expiredLobby} hasJoined={false} onJoined={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
