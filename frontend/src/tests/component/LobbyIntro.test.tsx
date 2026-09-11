import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { LobbyIntro } from '../../components/lobby/LobbyIntro'
import type { ProtocolAdvance } from '../../hooks/useProtocolAdvance'
import type { Hash, Lobby } from '../../game/types'
import { buildTestLobbyConfig } from '../fixtures'
import { renderWithProviders } from '../testUtils'

const IDLE: ProtocolAdvance = {
  action: null,
  label: '',
  description: '',
  pending: '',
  busy: false,
  error: null,
  run: vi.fn(),
}

function buildLobby(overrides: Partial<Lobby> = {}): Lobby {
  return {
    id: '0xlobby' as Hash,
    creationTxHash: '0xlobby' as Hash,
    creator: '0x1111111111111111111111111111111111111111',
    createdAtBlock: 1,
    status: 'OPEN',
  ending: 'NONE',
    config: buildTestLobbyConfig(),
    participantCount: 1,
    participantAddresses: [],
    currentEpochId: null,
    activeAttackId: null,
    outcome: null,
    creatorSettlement: 0,
    creatorSettled: false,
    reveal: null,
    ...overrides,
  }
}

function renderIntro(lobby: Lobby, props: Partial<Parameters<typeof LobbyIntro>[0]> = {}) {
  return renderWithProviders(
    <LobbyIntro
      lobby={lobby}
      // Every test here is about an operation still taking applications
      // unless it says otherwise; the phase cases have their own tests.
      phase="OPEN"
      hasJoined={false}
      onJoined={vi.fn()}
      onLeave={vi.fn()}
      isLeaving={false}
      refundable={0.012}
      refunded={null}
      advance={IDLE}
      participant={null}
      onBuyProbe={vi.fn()}
      isBuyingProbe={false}
      probePurchaseBlocked={null}
      probePurchaseError={null}
      {...props}
    />,
  )
}

describe('<LobbyIntro /> a cancelled operation (ТЗ §18)', () => {
  it('says it was cancelled rather than that applications are merely closed', () => {
    renderIntro(buildLobby({ status: 'CANCELLED' }), { hasJoined: true })
    // "Applications are closed" is true of a cancelled operation and useless:
    // it reads as one about to start, when in fact it never will and this
    // player's entry fee is sitting on the contract waiting to be claimed.
    expect(screen.getByText(/not enough defenders joined/i)).toBeInTheDocument()
    expect(screen.getByText(/·\s*cancelled/i)).toBeInTheDocument()
  })

  it('names the idle room, not the empty one, when enough defenders sat and nobody acted', () => {
    renderIntro(
      buildLobby({
        status: 'CANCELLED',
        ending: 'UNPLAYED',
        participantCount: 2,
      }),
      { hasJoined: true },
    )
    expect(screen.getByText('UNPLAYED')).toBeInTheDocument()
    expect(screen.getByText(/·\s*unplayed/i)).toBeInTheDocument()
    expect(screen.getByText(/nobody sent a recon probe or intercept — funds are available to claim/i)).toBeInTheDocument()
    expect(screen.queryByText(/was returned/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/not enough defenders/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/^CANCELLED$/)).not.toBeInTheDocument()
  })

  it('offers neither Join nor Leave on it — both can only be refused', () => {
    renderIntro(buildLobby({ status: 'CANCELLED' }), { hasJoined: true })
    expect(screen.queryByRole('button', { name: /^leave$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /join/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /buy probe/i })).not.toBeInTheDocument()
  })
})

describe('<LobbyIntro /> the transition nobody owns (ТЗ §10)', () => {
  it('offers it as a button once there is nothing in flight', () => {
    const run = vi.fn()
    renderIntro(buildLobby(), {
      advance: {
        action: 'cancelLobby',
        label: 'Cancel & refund everyone',
        description: 'Not enough defenders joined before the deadline.',
        pending: 'Cancelling…',
        busy: false,
        error: null,
        run,
      },
    })

    // The component never sends on its own — the hook decides whether this
    // wallet advances the operation automatically, and this is the fallback
    // for when it did not.
    expect(run).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /cancel & refund everyone/i }))
    expect(run).toHaveBeenCalledOnce()
  })

  /**
   * The ordinary case, and the one the screen is judged on: a defender who
   * sat through the countdown watches the operation carry on by itself. A
   * button here would be asking them to authorise the only thing that can
   * possibly happen next.
   */
  it('shows the operation moving, not a control, while the transition is in flight', () => {
    renderIntro(buildLobby(), {
      advance: {
        action: 'startOperation',
        label: 'Close applications',
        description: 'Applications are over and enough defenders joined.',
        pending: 'Applications closed — scheduling the attack…',
        busy: true,
        error: null,
        run: vi.fn(),
      },
    })

    expect(screen.getByText(/scheduling the attack/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /close applications/i })).not.toBeInTheDocument()
  })

  it('says what pressing it does, since it is not the player’s own move', () => {
    renderIntro(buildLobby(), {
      advance: {
        action: 'startOperation',
        label: 'Close applications',
        description: 'Applications are over and enough defenders joined.',
        pending: 'Applications closed — scheduling the attack…',
        busy: false,
        error: null,
        run: vi.fn(),
      },
    })
    expect(screen.getByText(/applications are over and enough defenders joined/i)).toBeInTheDocument()
  })

  it('shows nothing at all when the chain is up to date', () => {
    renderIntro(buildLobby())
    expect(screen.queryByRole('button', { name: /close applications|cancel &/i })).not.toBeInTheDocument()
  })
})

describe('<LobbyIntro /> leave (ТЗ §5)', () => {
  it('names the refund when leaving would pay something back', () => {
    renderIntro(buildLobby(), { hasJoined: true, refundable: 0.012 })
    expect(screen.getByRole('button', { name: /leave · refunds/i })).toBeInTheDocument()
  })

  it('is just Leave when the seat itself cost nothing', () => {
    renderIntro(buildLobby(), { hasJoined: true, refundable: 0 })
    expect(screen.getByRole('button', { name: /^leave$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /refunds/i })).not.toBeInTheDocument()
  })

  it('puts Buy probe above Leave, with the defender’s current allotment on it', () => {
    renderIntro(buildLobby(), { hasJoined: true })
    const buy = screen.getByRole('button', { name: /buy probe/i })
    const leave = screen.getByRole('button', { name: /^leave/i })
    expect(buy.compareDocumentPosition(leave) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(buy).toHaveAccessibleName(/3 ready/i)
    expect(buy).toHaveTextContent('/6')
    expect(buy.querySelector('svg')).toBeNull()
    expect(buy).toHaveAttribute('data-invite', 'on')
    expect(buy).not.toHaveTextContent(/spent|bought|ready/i)
  })

  it('does not offer Buy before the seat is taken', () => {
    renderIntro(buildLobby(), { hasJoined: false })
    expect(screen.queryByRole('button', { name: /buy probe/i })).not.toBeInTheDocument()
  })
})
