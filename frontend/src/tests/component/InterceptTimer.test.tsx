import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { InterceptTimer } from '../../components/attack/InterceptTimer'

describe('<InterceptTimer />', () => {
  /*
   * The wording is the assertion.
   *
   * This block used to read "ATTACK LAUNCH" over a countdown, inside a
   * dialog that builds a *defense* — which put the creator on the wrong side
   * of their own game, as though pressing Launch scheduled an attack. It
   * names what the operation does to a threat the protocol was always going
   * to send.
   */
  it('says what the operation will intercept, not that an attack is being made', () => {
    render(<InterceptTimer msRemaining={4 * 60 * 1000 + 36 * 1000} epochId={482} launchBlock={72_400} />)

    expect(screen.getByText(/this operation intercepts/i)).toBeInTheDocument()
    expect(screen.queryByText(/attack launch/i)).not.toBeInTheDocument()

    // The epoch is an estimate off a measured block rate, and says so.
    expect(screen.getByText('≈ Epoch 482')).toBeInTheDocument()
    expect(screen.getByText('00:04:36')).toBeInTheDocument()
  })

  /*
   * The other reason this replaced the next-attack readout. An operation's
   * threat is a day and a half away for any ordinary deadline, and the old
   * HH:MM:SS-only format could not say so — it showed the next *epoch
   * boundary*, minutes away, for an arrival that was nothing of the kind.
   */
  it('spells out an arrival that is days away rather than overflowing the hours', () => {
    render(<InterceptTimer msRemaining={36 * 60 * 60 * 1000} epochId={7} launchBlock={1_150} />)

    expect(screen.getByText('1d 12:00:00')).toBeInTheDocument()
  })

  it('waits for the block clock rather than inventing a value', () => {
    render(<InterceptTimer msRemaining={null} epochId={null} launchBlock={null} />)

    expect(screen.getByText('--:--:--')).toBeInTheDocument()
    expect(screen.getByText('Epoch —')).toBeInTheDocument()
  })
})
