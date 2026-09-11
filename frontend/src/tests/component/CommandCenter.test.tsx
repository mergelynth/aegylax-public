import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommandCenter, type CommandCenterProps } from '../../components/command/CommandCenter'
import { COMMAND_HUD_SKIN } from '../../components/command/hudSkin'
import styles from '../../components/command/CommandCenter.module.css'
import type { ClaimItem } from '../../components/command/SettlementPanel'

const point = { sector: { column: 2, row: 1 }, offsetX: 0.25, offsetY: 0.75 }

function claim(overrides: Partial<ClaimItem> = {}): ClaimItem {
  return {
    key: 'reward',
    parts: ['prize'],
    note: 'Your share of the prize pool.',
    amount: 0.25,
    claimed: false,
    busy: false,
    error: null,
    onClaim: vi.fn(),
    ...overrides,
  }
}

function renderCenter(overrides: Partial<CommandCenterProps> = {}) {
  const props: CommandCenterProps = {
    lobbyPhase: 'WAITING_FOR_ATTACK',
    potEth: 0.0032,
    probesAvailable: 3,
    probesUsed: 0,
    probesMax: 6,
    stagedPoint: null,
    submittedPoint: null,
    onSendRecon: vi.fn(),
    reconBlockedReason: null,
    isReconBusy: false,
    isReconSending: false,
    onSendDefense: vi.fn(),
    defenseBlockedReason: null,
    isDefenseBusy: false,
    canRequestReveal: false,
    onRequestReveal: vi.fn(),
    isRevealBusy: false,
    claims: [],
    ...overrides,
  }
  const view = render(<CommandCenter {...props} />)
  return { ...view, props }
}

const reconButton = () => screen.getByRole('button', { name: /get recon/i })
const interceptButton = () =>
  screen.getByRole('button', { name: /^(set intercept|intercept|sealing|firing|shot fired)$/i })

describe('<CommandCenter /> the console', () => {
  it('is on screen in every running phase', () => {
    for (const phase of ['WAITING_FOR_ATTACK', 'ATTACK_INCOMING', 'ATTACK_ACTIVE'] as const) {
      const { unmount } = renderCenter({ lobbyPhase: phase })
      expect(screen.getByRole('region', { name: 'Command Center' })).toBeInTheDocument()
      expect(screen.getByRole('region', { name: 'Command Center' })).toHaveAttribute('data-hud', COMMAND_HUD_SKIN)
      unmount()
    }
  })

  it('lights the classic frame only while the attack is in the sky', () => {
    if (COMMAND_HUD_SKIN !== 'classic') return

    const pulses = (container: HTMLElement) => Array.from(container.querySelectorAll('mask path'))
    const outlines = (container: HTMLElement) =>
      Array.from(container.querySelectorAll(`.${styles.hudOuter}, .${styles.hudInner}`))

    const live = renderCenter({ lobbyPhase: 'ATTACK_ACTIVE' })
    expect(pulses(live.container)).toHaveLength(2)
    live.unmount()

    const idle: Partial<CommandCenterProps>[] = [
      { lobbyPhase: 'OPEN' },
      { lobbyPhase: 'WAITING_FOR_ATTACK' },
      { lobbyPhase: 'ATTACK_INCOMING' },
      { lobbyPhase: 'RESULT', canRequestReveal: true },
    ]

    for (const props of idle) {
      const view = renderCenter(props)
      expect(pulses(view.container)).toHaveLength(0)
      expect(outlines(view.container)).toHaveLength(2)
      view.unmount()
    }
  })

  it('is one floating rail, without nested chassis over the copy', () => {
    if (COMMAND_HUD_SKIN !== 'orbit') return
    renderCenter({ lobbyPhase: 'ATTACK_ACTIVE' })
    const region = screen.getByRole('region', { name: 'Command Center' })
    expect(region).toHaveAttribute('data-hud', 'orbit')
    expect(region).toHaveAttribute('data-state', 'play')
    expect(document.querySelector('[class*="hudGlass"]')).toBeNull()
    expect(document.querySelector('[class*="orbitFill"]')).toBeNull()
    expect(document.querySelector('[class*="orbitRail"]')).toBeNull()
  })

  it('shows pool, remaining recon, and intercept — and nothing else', () => {
    renderCenter()
    expect(screen.getByText('Pool')).toBeInTheDocument()
    expect(screen.getByLabelText('0.0032 ETH')).toBeInTheDocument()
    expect(screen.getByText('Recon')).toBeInTheDocument()
    // The target readout is gone: the primary button already carries that
    // state, from Set intercept through Shot fired.
    expect(screen.queryByText('Set target')).not.toBeInTheDocument()
    expect(screen.queryByText('Target locked')).not.toBeInTheDocument()
    expect(screen.queryByText('Defense')).not.toBeInTheDocument()
    expect(screen.queryByText('Not set')).not.toBeInTheDocument()
    expect(screen.queryByText('Attack')).not.toBeInTheDocument()
    expect(screen.queryByText(/creator fee/i)).not.toBeInTheDocument()
  })

  it('does not repeat the countdown the banner already carries', () => {
    renderCenter({ lobbyPhase: 'ATTACK_INCOMING' })
    expect(screen.getByRole('region', { name: 'Command Center' })).not.toHaveTextContent(/\d{2}:\d{2}/)
  })

  it('drops the duplicated Operation and You readouts and the epoch', () => {
    renderCenter({ lobbyPhase: 'ATTACK_ACTIVE' })
    const rail = screen.getByRole('region', { name: 'Command Center' })
    expect(rail).not.toHaveTextContent('Operation')
    expect(rail).not.toHaveTextContent(/\bYou\b/)
    expect(rail).not.toHaveTextContent(/Epoch/i)
  })

  it('carries no standing captions — a blocked control simply is not pressable', () => {
    renderCenter({ defenseBlockedReason: 'Defense opens when the attack launches' })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByText(/Defense opens when the attack launches/)).not.toBeInTheDocument()
    expect(interceptButton()).not.toHaveAttribute('title')
    expect(interceptButton()).toBeDisabled()
  })

  it('still reports a failure, which is the one thing nothing else expresses', () => {
    renderCenter({
      defenseBlockedReason: 'Defense opens when the attack launches',
      error: 'Insufficient funds for gas',
    })
    expect(screen.getByRole('alert')).toHaveTextContent('Insufficient funds for gas')
  })

  it('keeps pool, recon and the primary action on one surface', () => {
    renderCenter({ probesAvailable: 2 })
    expect(reconButton()).toBeInTheDocument()
    expect(interceptButton()).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })

  it('offers Sign in instead of intercept when the visitor is unsigned', () => {
    const onSignIn = vi.fn()
    renderCenter({ onSignIn })
    expect(screen.queryByRole('button', { name: /get recon/i })).not.toBeInTheDocument()
    const signIn = screen.getByRole('button', { name: /^sign in$/i })
    expect(signIn).toBeEnabled()
    fireEvent.click(signIn)
    expect(onSignIn).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /^intercept$/i })).not.toBeInTheDocument()
  })
})

describe('<CommandCenter /> reconnaissance', () => {
  it('pulses recon while there is no intercept to send', () => {
    renderCenter()
    expect(reconButton()).toHaveAttribute('data-live', 'true')
  })

  it('sends a probe on one press — there is nothing to target', () => {
    const { props } = renderCenter()
    fireEvent.click(reconButton())
    expect(props.onSendRecon).toHaveBeenCalledOnce()
  })

  it('shows remaining recon against capacity, not spent', () => {
    renderCenter({ probesAvailable: 2, probesUsed: 1, probesMax: 6 })
    const recon = screen.getByText('Recon').closest('div')
    expect(recon).toHaveTextContent(/2\s*\/\s*6/)
    expect(recon).not.toHaveTextContent(/2\s*\/\s*1/)
  })

  it('is inactive when a probe cannot fire, and names the reason on the control', () => {
    renderCenter({ probesAvailable: 0, reconBlockedReason: 'No Recon Probes available' })
    expect(reconButton()).toBeDisabled()
    expect(reconButton()).toHaveAttribute('title', 'No Recon Probes available')
  })

  it('cannot be pressed while the wallet is being asked to sign', () => {
    const { props } = renderCenter({ isReconBusy: true, isReconSending: true })
    expect(reconButton()).toBeDisabled()
    fireEvent.click(reconButton())
    expect(props.onSendRecon).not.toHaveBeenCalled()
    expect(screen.getByText('Scanning')).toBeInTheDocument()
  })

  it('still launches the next probe while the previous answer is ripening', () => {
    const { props } = renderCenter({ isReconBusy: true, isReconSending: false })
    expect(reconButton()).not.toBeDisabled()
    fireEvent.click(reconButton())
    expect(props.onSendRecon).toHaveBeenCalled()
  })

  it('defers to the protocol while the previous probe is inside its delay', () => {
    const { props } = renderCenter({
      isReconBusy: true,
      isReconSending: false,
      reconBlockedReason: 'Next probe in 4 blocks',
    })
    expect(reconButton()).toBeDisabled()
    expect(screen.getByText('Next recon · 4 blocks')).toBeInTheDocument()
    fireEvent.click(reconButton())
    expect(props.onSendRecon).not.toHaveBeenCalled()
  })
})

describe('<CommandCenter /> Intercept', () => {
  it('stays Set intercept, disabled, until a point is chosen', () => {
    renderCenter({ defenseBlockedReason: 'Place a Defense Point inside the sector' })
    expect(interceptButton()).toBeDisabled()
    expect(interceptButton()).toHaveTextContent(/^set intercept$/i)
    expect(screen.queryByText('Not set')).not.toBeInTheDocument()
    expect(screen.queryByText('Defense')).not.toBeInTheDocument()
  })

  it('becomes Intercept once the point is placed', () => {
    const { props } = renderCenter({ stagedPoint: point, defenseBlockedReason: null })
    expect(interceptButton()).toBeEnabled()
    expect(interceptButton()).toHaveTextContent(/^intercept$/i)
    fireEvent.click(interceptButton())
    expect(props.onSendDefense).toHaveBeenCalledOnce()
  })

  it('does not print the coordinate on the rail', () => {
    renderCenter({ stagedPoint: point })
    expect(screen.queryByText('C2 0.25 / 0.75')).not.toBeInTheDocument()
  })

  it('does not print recon-clock timing on the rail', () => {
    renderCenter({ stagedPoint: point, defenseTimingNote: 'LATE · 10 blk', defenseTimingLate: true })
    expect(screen.queryByText('LATE · 10 blk')).not.toBeInTheDocument()
  })

  it('says Shot fired after the lock, and stops being an action', () => {
    const { props } = renderCenter({ submittedPoint: point, defenseBlockedReason: 'Defense already submitted' })
    const button = screen.getByRole('button', { name: /^shot fired$/i })
    expect(button).toBeDisabled()
    expect(screen.getAllByText(/^shot fired$/i)).toHaveLength(1)
    fireEvent.click(button)
    expect(props.onSendDefense).not.toHaveBeenCalled()
  })
})

describe('<CommandCenter /> the end of the operation', () => {
  it('offers the reveal as the primary action once the attack has landed', () => {
    const { props } = renderCenter({ lobbyPhase: 'RESULT', canRequestReveal: true })
    fireEvent.click(screen.getByRole('button', { name: /reveal/i }))
    expect(props.onRequestReveal).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /get recon/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^intercept$/i })).not.toBeInTheDocument()
  })

  it('does not park a leftover HTTP 404 on the rail, and keeps Reveal pressable', () => {
    const { props } = renderCenter({
      lobbyPhase: 'RESULT',
      canRequestReveal: true,
      error: 'Not Found',
    })
    expect(screen.queryByText(/not found/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    const reveal = screen.getByRole('button', { name: /reveal/i })
    expect(reveal).toBeEnabled()
    expect(reveal).toHaveAttribute('data-kind', 'reveal')
    fireEvent.click(reveal)
    expect(props.onRequestReveal).toHaveBeenCalledOnce()
  })

  it('keeps the rail in a result state when there is no payout', () => {
    renderCenter({
      lobbyPhase: 'RESULT',
      canRequestReveal: false,
      claims: [],
      attackIntercepted: false,
    })
    expect(screen.getByRole('region', { name: 'Command Center' })).toHaveAttribute('data-state', 'result')
    expect(screen.getByText('Pool')).toBeInTheDocument()
    expect(screen.queryByText('The pool rolls into the next round.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^claim$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /get recon/i })).not.toBeInTheDocument()
  })

  /*
   * The countdown banner in the middle of the scene is the screen's
   * headline and already carries the verdict. The rail printing it again in
   * front of the figure was the same sentence twice, forty pixels apart.
   */
  it('does not repeat the verdict the banner already carries', () => {
    renderCenter({
      lobbyPhase: 'RESULT',
      canRequestReveal: false,
      claims: [],
      attackIntercepted: false,
    })
    const rail = screen.getByRole('region', { name: 'Command Center' })
    expect(rail).not.toHaveTextContent(/rocket escaped/i)
    expect(rail).not.toHaveTextContent(/round over/i)
    expect(rail).not.toHaveTextContent(/you missed/i)
  })

  it('names a miss without offering Claim', () => {
    renderCenter({
      lobbyPhase: 'RESULT',
      canRequestReveal: false,
      claims: [],
      attackIntercepted: true,
      ownHit: false,
    })
    const rail = screen.getByRole('region', { name: 'Command Center' })
    expect(rail).not.toHaveTextContent(/round over/i)
    expect(rail).not.toHaveTextContent(/you missed/i)
    // The verdict is the primary control's own state, not a line of copy.
    expect(screen.getByRole('button', { name: /^round lost$/i })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /^claim$/i })).not.toBeInTheDocument()
  })

  it('says nothing at all where the outcome has not reached the client yet', () => {
    renderCenter({ lobbyPhase: 'RESULT', canRequestReveal: false, claims: [], attackIntercepted: null })
    expect(screen.queryByRole('button', { name: /^round lost$/i })).not.toBeInTheDocument()
    expect(screen.getByText('Pool')).toBeInTheDocument()
  })

  it('waits for the reveal before offering the claim', () => {
    renderCenter({
      lobbyPhase: 'RESULT',
      canRequestReveal: true,
      claims: [claim()],
      ownHit: true,
    })
    expect(screen.getByRole('button', { name: /reveal/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^claim$/i })).not.toBeInTheDocument()
  })

  it('shows the amount and Claim on the same rail after reveal', () => {
    renderCenter({ lobbyPhase: 'RESULT', claims: [claim()], ownHit: true })
    expect(screen.getByRole('region', { name: 'Command Center' })).toHaveAttribute('data-state', 'result')
    // The window stops reading "Pool" once there is a payout: the figure is
    // the claim's, so the label is what the claim is for.
    expect(screen.getByText('Pool reward')).toBeInTheDocument()
    expect(screen.queryByText('Pool')).not.toBeInTheDocument()
    expect(screen.queryByText('You were first.')).not.toBeInTheDocument()
    expect(screen.getByLabelText('0.25 ETH')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^claim$/i })).toBeEnabled()
    expect(screen.queryByRole('region', { name: 'Payouts' })).not.toBeInTheDocument()
  })

  it('claims once and then refuses to offer a second claim', () => {
    const claimable = claim()
    const { unmount } = renderCenter({ lobbyPhase: 'RESULT', claims: [claimable], ownHit: true })
    fireEvent.click(screen.getByRole('button', { name: /^claim$/i }))
    expect(claimable.onClaim).toHaveBeenCalledOnce()
    unmount()

    renderCenter({ lobbyPhase: 'RESULT', claims: [claim({ claimed: true })], ownHit: true })
    expect(screen.getByRole('button', { name: /^claimed$/i })).toBeDisabled()
    expect(screen.getByLabelText('0.25 ETH')).toBeInTheDocument()
  })

  it('still names the payout after it has been paid', () => {
    renderCenter({
      lobbyPhase: 'RESULT',
      claims: [claim({ amount: 0.2515, claimed: true })],
      ownHit: true,
    })
    expect(screen.getByRole('button', { name: /^claimed$/i })).toBeDisabled()
    expect(screen.getByLabelText('0.2515 ETH')).toBeInTheDocument()
  })

  it('offers a single refund on a cancelled operation', () => {
    const refund = claim({
      key: 'refund',
      parts: ['entry'],
      amount: 0.0015,
      note: 'Nobody sent a probe or intercept — your prize pool comes back. The protocol keeps the creation fee.',
    })
    renderCenter({ lobbyPhase: 'CANCELLED', claims: [refund] })
    fireEvent.click(screen.getByRole('button', { name: /^claim$/i }))
    expect(refund.onClaim).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('0.0015 ETH')).toBeInTheDocument()
    expect(screen.getByText('Entry refund')).toBeInTheDocument()
    // The long wording is the claim's own sentence, and it is on hover.
    expect(screen.queryByText(/creation fee/i)).not.toBeInTheDocument()
    expect(screen.getByTitle(refund.note)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^claim$/i })).toBeDisabled()
  })

  it('puts a failed claim on the same line a connection error uses', () => {
    renderCenter({
      lobbyPhase: 'CANCELLED',
      claims: [
        claim({
          key: 'refund',
          parts: ['entry'],
          note: 'Nobody sent a probe or intercept — everything you paid in comes back.',
          error: 'The public RPC is refusing this browser.',
        }),
      ],
    })
    expect(screen.getByRole('alert')).toHaveTextContent('The public RPC is refusing this browser.')
  })

  it('labels a winner-creator claim as reward plus fee', () => {
    renderCenter({
      lobbyPhase: 'RESULT',
      ownHit: true,
      claims: [
        claim({
          parts: ['prize', 'fee'],
          amount: 0.2515,
          note:
            'You are paid 0.25 ETH as your share of the prize pool for intercepting the attack, plus 0.0015 ETH — the 5% of the entry fees this operation pays whoever created it.',
        }),
      ],
    })
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByRole('button', { name: /^claim$/i })).toBeEnabled()
    expect(screen.getByText('Pool + fee reward')).toBeInTheDocument()
    // The split's figures and the percentage are too long for the label, so
    // they are the tooltip — present, but not printed on a 72px rail.
    expect(screen.queryByText(/creator fee/i)).not.toBeInTheDocument()
    expect(screen.getByTitle(/share of the prize pool.*entry fees/i)).toBeInTheDocument()
    expect(screen.getByLabelText('0.2515 ETH')).toBeInTheDocument()
  })

  /*
   * The bug this replaced: `key` is the settlement path, not the contents.
   * A creator whose round nobody intercepted is paid through `reward` and
   * owed the Creator Fee alone, and the rail printed REWARD over it.
   */
  it('names the Creator Fee as a payout, on a round this wallet lost', () => {
    renderCenter({
      lobbyPhase: 'RESULT',
      attackIntercepted: false,
      ownHit: false,
      claims: [
        claim({
          parts: ['fee'],
          amount: 0.0001,
          note: 'You are paid 5% of the entry fees for creating this operation. This is a payout, not a charge.',
        }),
      ],
    })
    // Never a bare "Fee": everywhere else in the product a fee is money
    // leaving the wallet, and this is money arriving.
    expect(screen.getByText('Entry fee reward')).toBeInTheDocument()
    expect(screen.queryByText('Fee')).not.toBeInTheDocument()
    expect(screen.getByLabelText('0.0001 ETH')).toBeInTheDocument()
    expect(screen.getByTitle(/payout, not a charge/i)).toBeInTheDocument()
  })

  it('rounds the figure to at most four decimals', () => {
    renderCenter({
      lobbyPhase: 'CANCELLED',
      claims: [claim({ key: 'refund', parts: ['entry'], amount: 0.01151234 })],
    })
    expect(screen.getByLabelText('0.0115 ETH')).toBeInTheDocument()
    expect(screen.getByText('0.0115')).toBeInTheDocument()
  })

  it('holds Claim on the same control while the payout is in flight', () => {
    renderCenter({
      lobbyPhase: 'RESULT',
      ownHit: true,
      claims: [claim({ busy: true })],
    })
    const button = screen.getByRole('button', { name: /^claim$/i })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('locks Claim on the same press, before the parent marks it busy', () => {
    const claimable = claim()
    renderCenter({ lobbyPhase: 'RESULT', claims: [claimable], ownHit: true })
    const button = screen.getByRole('button', { name: /^claim$/i })
    expect(button).toBeEnabled()

    fireEvent.click(button)
    expect(claimable.onClaim).toHaveBeenCalledOnce()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveTextContent('Claim')

    fireEvent.click(button)
    expect(claimable.onClaim).toHaveBeenCalledOnce()
  })

  it('unlocks Claim after a failed attempt so it can be pressed again', () => {
    const first = claim()
    const { rerender, props } = renderCenter({ lobbyPhase: 'RESULT', claims: [first], ownHit: true })
    fireEvent.click(screen.getByRole('button', { name: /^claim$/i }))
    expect(screen.getByRole('button', { name: /^claim$/i })).toBeDisabled()

    const retry = claim({ error: 'The wallet rejected this transaction.' })
    rerender(<CommandCenter {...props} claims={[retry]} ownHit />)
    const button = screen.getByRole('button', { name: /^claim$/i })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(retry.onClaim).toHaveBeenCalledOnce()
  })
})

describe('Intercept, while the point is being sealed', () => {
  const staged = { lobbyPhase: 'ATTACK_ACTIVE' as const, stagedPoint: point }

  it('wears the wait on the button itself, and stays pressable', () => {
    renderCenter({ ...staged, isDefenseArming: true })
    const button = screen.getByRole('button', { name: /^sealing$/i })
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByRole('button', { name: /^intercept$/i })).toBeNull()
  })

  it('prefers Firing once a transaction is actually going out', () => {
    renderCenter({ ...staged, isDefenseArming: true, isDefenseBusy: true })
    const button = screen.getByRole('button', { name: /^firing$/i })
    expect(button).toBeInTheDocument()
    expect(button.querySelector('[data-trail]')).not.toBeNull()
    expect(screen.queryByRole('button', { name: /^intercept$/i })).toBeNull()
  })

  it('says Intercept when the point is ready to send', () => {
    renderCenter(staged)
    const button = screen.getByRole('button', { name: /^intercept$/i })
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('aria-busy', 'false')
    expect(button.querySelector('[data-trail]')).toBeNull()
  })

  it('drops the recon pulse once Intercept is the verb', () => {
    renderCenter(staged)
    expect(reconButton()).toHaveAttribute('data-live', 'false')
  })
})

describe('<CommandCenter /> wait trails', () => {
  it('draws the firing trail across Decoding', () => {
    renderCenter({ lobbyPhase: 'RESULT', canRequestReveal: true, revealAuto: true })
    const button = screen.getByRole('button', { name: /^decoding$/i })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button.querySelector('[data-trail]')).not.toBeNull()
  })

  it('draws the firing trail across Claiming', () => {
    renderCenter({
      lobbyPhase: 'RESULT',
      ownHit: true,
      claims: [claim({ busy: true })],
    })
    const button = screen.getByRole('button', { name: /^claim$/i })
    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toHaveTextContent(/claiming/i)
    expect(button.querySelector('[data-trail]')).not.toBeNull()
  })
})
