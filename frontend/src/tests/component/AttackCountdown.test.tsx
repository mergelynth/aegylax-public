import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AttackCountdown, type AttackCountdownProps } from '../../components/command/AttackCountdown'

function renderCountdown(overrides: Partial<AttackCountdownProps> = {}) {
  const props: AttackCountdownProps = {
    phase: 'WAITING_FOR_ATTACK',
    blocksRemaining: 40,
    blockTimeMs: 2000,
    // One epoch: the wait before the launch and the flight itself are the
    // same length, so the bar measures against the same total in both.
    totalBlocks: 120,
    intercepted: null,
    ownDefenseSucceeded: null,
    ...overrides,
  }
  return render(<AttackCountdown {...props} />)
}

describe('<AttackCountdown /> (ТЗ §1, §2.1)', () => {
  it('converts blocks to a clock, so the countdown cannot drift from the launch block', () => {
    renderCountdown({ blocksRemaining: 30, blockTimeMs: 2000 })
    // 30 blocks x 2s = one minute, and it starts running down from there
    // immediately — the display is smoothed between blocks rather than
    // frozen at the block-derived value (ТЗ §6, "timers are not smooth").
    expect(screen.getByText(/^00:(01:00|00:59)$/)).toBeInTheDocument()
    expect(screen.getByText('30 blocks')).toBeInTheDocument()
  })

  it('names the pre-launch state Attack Incoming', () => {
    renderCountdown({ phase: 'ATTACK_INCOMING', blocksRemaining: 5 })
    expect(screen.getAllByText(/attack incoming/i).length).toBeGreaterThan(0)
  })

  it('reports the flight as an active attack', () => {
    renderCountdown({ phase: 'ATTACK_ACTIVE', blocksRemaining: 12 })
    expect(screen.getByText(/impact in/i)).toBeInTheDocument()
  })

  it('steps back to half opacity while the attack is in flight (ТЗ §1)', () => {
    // The playfield underneath is live in exactly this phase, and the
    // largest block on the screen must not sit between the player and a
    // sector they have to click.
    const { container } = renderCountdown({ phase: 'ATTACK_ACTIVE', blocksRemaining: 12 })
    const banner = container.firstElementChild as HTMLElement
    expect(banner.className).toMatch(/recessed/)
  })

  it('stays at full weight in every other phase', () => {
    for (const phase of ['WAITING_FOR_ATTACK', 'ATTACK_INCOMING', 'RESULT'] as const) {
      const { container, unmount } = renderCountdown({ phase, intercepted: false })
      expect((container.firstElementChild as HTMLElement).className).not.toMatch(/recessed/)
      unmount()
    }
  })

  it('ends on the operation’s verdict, in the words ТЗ §16 asks for', () => {
    const { unmount } = renderCountdown({ phase: 'RESULT', intercepted: true, ownDefenseSucceeded: true })
    expect(screen.getByText('TARGET INTERCEPTED')).toBeInTheDocument()
    expect(screen.getByText('DEFENSE SUCCESS')).toBeInTheDocument()
    unmount()

    renderCountdown({ phase: 'RESULT', intercepted: false, ownDefenseSucceeded: false })
    expect(screen.getByText('TARGET REACHED')).toBeInTheDocument()
    expect(screen.getByText(/prize → global defense/i)).toBeInTheDocument()
  })

  it('separates the operation’s verdict from this player’s own (ТЗ §16)', () => {
    // Somebody else intercepted first: the threat was stopped, and this
    // defender still failed.
    renderCountdown({ phase: 'RESULT', intercepted: true, ownDefenseSucceeded: false })
    expect(screen.getByText('TARGET INTERCEPTED')).toBeInTheDocument()
    expect(screen.getByText('DEFENSE FAILED')).toBeInTheDocument()
  })

  it('names an outranked hit instead of calling it a miss', () => {
    renderCountdown({
      phase: 'RESULT',
      intercepted: true,
      ownDefenseSucceeded: false,
      ownAlreadyDown: true,
    })
    expect(screen.getByText('TARGET INTERCEPTED')).toBeInTheDocument()
    expect(screen.getByText(/already down/i)).toBeInTheDocument()
    expect(screen.queryByText('DEFENSE FAILED')).not.toBeInTheDocument()
  })

  /**
   * A passer-by is not a defender who lost.
   *
   * `ownDefenseSucceeded` has three states and the banner used to read it as
   * two — anything that was not `false` got DEFENSE SUCCESS, so a stranger
   * opening a finished round was congratulated on a defense they never sent,
   * and (with the page's old fallback) a stranger on a losing round was told
   * theirs had failed. Null means "not playing", and the honest answer to
   * that is the operation's verdict and nothing personal at all.
   */
  it('says nothing personal to somebody who did not defend the operation', () => {
    const { unmount } = renderCountdown({ phase: 'RESULT', intercepted: true, ownDefenseSucceeded: null })
    expect(screen.getByText('TARGET INTERCEPTED')).toBeInTheDocument()
    expect(screen.queryByText('DEFENSE SUCCESS')).not.toBeInTheDocument()
    expect(screen.queryByText('DEFENSE FAILED')).not.toBeInTheDocument()
    unmount()

    renderCountdown({ phase: 'RESULT', intercepted: false, ownDefenseSucceeded: null })
    expect(screen.getByText('TARGET REACHED')).toBeInTheDocument()
    expect(screen.queryByText(/defense failed/i)).not.toBeInTheDocument()
  })

  /**
   * TARGET REACHED on its own reads as an achievement to anyone not already
   * thinking about whose target it was, and the interception branch has a
   * personal verdict where this one had only a note about where the money
   * went. A defender who submitted is told they lost.
   */
  it('names the loss on an impact, not just where the prize went', () => {
    renderCountdown({ phase: 'RESULT', intercepted: false, ownDefenseSucceeded: false })
    expect(screen.getByText('TARGET REACHED')).toBeInTheDocument()
    expect(screen.getByText(/defense failed/i)).toBeInTheDocument()
  })

  it('does not announce RESULT SEALED before the chain has answered', () => {
    renderCountdown({ phase: 'RESULT', intercepted: null, revealLoaded: false })
    expect(screen.queryByText('RESULT SEALED')).not.toBeInTheDocument()
    expect(screen.queryByText(/reveal to score/i)).not.toBeInTheDocument()
    expect(screen.getByText('READING RESULT')).toBeInTheDocument()
  })

  it('keeps RESULT SEALED for a round that is actually still sealed', () => {
    renderCountdown({ phase: 'RESULT', intercepted: null, revealLoaded: true })
    expect(screen.getByText('RESULT SEALED')).toBeInTheDocument()
    expect(screen.getByText(/reveal to score/i)).toBeInTheDocument()
  })

  /**
   * The banner must not instruct an action the console is refusing.
   *
   * While the backend keeper carries the reveal, the Command Center shows a
   * disabled `Decoding` — and this line was telling the player to press it.
   * One screen, two answers. Once the keeper has had its turn (see
   * `REVEAL_PATIENCE_MS`) `revealAuto` goes false and asking is honest again.
   */
  it('reports the reveal happening rather than asking for it, while the keeper has it', () => {
    const { unmount } = renderCountdown({
      phase: 'RESULT',
      intercepted: null,
      revealLoaded: true,
      revealAuto: true,
    })
    expect(screen.getByText('RESULT SEALED')).toBeInTheDocument()
    expect(screen.getByText(/decoding the sealed trajectory/i)).toBeInTheDocument()
    expect(screen.queryByText(/reveal to score/i)).not.toBeInTheDocument()
    unmount()

    renderCountdown({ phase: 'RESULT', intercepted: null, revealLoaded: true, revealAuto: false })
    expect(screen.getByText(/reveal to score/i)).toBeInTheDocument()
  })

  it('shows dashes rather than a guess when the block feed has not arrived', () => {
    renderCountdown({ blocksRemaining: null })
    expect(screen.getByText('--:--:--')).toBeInTheDocument()
  })
})

/**
 * ТЗ §2.1 — the bar is the block count, the digits are an estimate of it.
 *
 * They are two readouts of the same fact made of different material, and
 * that is the point: seconds-per-block can only ever be measured, so the
 * digits correct themselves when the chain runs fast or slow. The bar is a
 * ratio of blocks, which the protocol decides outright, so it never has to.
 */
describe('<AttackCountdown /> progress (ТЗ §2.1)', () => {
  it('fills in proportion to the blocks already elapsed', () => {
    renderCountdown({ phase: 'ATTACK_ACTIVE', blocksRemaining: 30, totalBlocks: 120 })
    // 90 of 120 blocks gone.
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '75')
  })

  it('is empty at the start of the wait and full at its end', () => {
    const { unmount } = renderCountdown({ phase: 'WAITING_FOR_ATTACK', blocksRemaining: 120, totalBlocks: 120 })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
    unmount()

    renderCountdown({ phase: 'ATTACK_ACTIVE', blocksRemaining: 0, totalBlocks: 120 })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
  })

  it('never runs past either end, however far the block feed overshoots', () => {
    const { unmount } = renderCountdown({ phase: 'ATTACK_ACTIVE', blocksRemaining: -20, totalBlocks: 120 })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
    unmount()

    // More blocks left than the whole wait is long — a re-anchor arriving
    // before the phase has caught up.
    renderCountdown({ phase: 'WAITING_FOR_ATTACK', blocksRemaining: 500, totalBlocks: 120 })
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0')
  })

  /**
   * A finished operation is not partway through anything. A bar stuck at
   * 100% under the word CANCELLED reads as a process that stalled.
   */
  it('shows no bar once the operation has ended', () => {
    for (const phase of ['RESULT', 'CANCELLED', 'UNDERSUBSCRIBED', 'OPEN'] as const) {
      const { unmount } = renderCountdown({ phase, blocksRemaining: 0, totalBlocks: 120 })
      expect(screen.queryByRole('progressbar'), phase).not.toBeInTheDocument()
      unmount()
    }
  })

  it('shows no bar before the block feed has answered', () => {
    renderCountdown({ phase: 'ATTACK_ACTIVE', blocksRemaining: null, totalBlocks: 120 })
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })
})
