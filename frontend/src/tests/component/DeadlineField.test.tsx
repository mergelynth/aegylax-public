import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DeadlineField } from '../../components/common/DeadlineField'
import { formatDeadlineParts } from '../../utils/format'

/** A fixed moment, so the readout is the same string every run. */
const MOMENT = new Date(2026, 8, 2, 11, 12).getTime()

function setup(value = MOMENT) {
  const onChange = vi.fn()
  render(<DeadlineField label="Application deadline" value={value} onChange={onChange} hint="When applications close" />)
  return { onChange, input: screen.getByLabelText(/application deadline/i) as HTMLInputElement }
}

describe('<DeadlineField />', () => {
  it('draws the moment in the interface’s own type, over the platform picker', () => {
    setup()

    const { date, time } = formatDeadlineParts(MOMENT)
    expect(screen.getByText(date)).toBeInTheDocument()
    expect(screen.getByText(time)).toBeInTheDocument()
  })

  it('reports a moment the picker produced', () => {
    const { onChange, input } = setup()

    fireEvent.change(input, { target: { value: '2026-10-14T09:30' } })

    expect(onChange).toHaveBeenCalledWith(new Date(2026, 9, 14, 9, 30).getTime())
  })

  /*
   * The bug this exists for, and it was a crash rather than a cosmetic
   * fault: the picker's own Clear empties the input, `new Date('').getTime()`
   * is `NaN`, and `toISOString` *throws* on an invalid date. The throw
   * happened during render, so it unmounted the tree — the whole page went
   * black.
   */
  it('survives the picker’s Clear instead of taking the page down with it', () => {
    const { onChange, input } = setup()

    expect(() => fireEvent.change(input, { target: { value: '' } })).not.toThrow()

    // The deadline is never reported as `NaN`: an operation has no
    // deadline-less state, so the edit is refused rather than propagated.
    expect(onChange).not.toHaveBeenCalled()
    // And the control is put back the way it was, rather than left empty
    // under a readout still showing the real moment.
    expect(screen.getByText(formatDeadlineParts(MOMENT).date)).toBeInTheDocument()
    expect(input.value).toBe('2026-09-02T11:12')
  })

  /*
   * Defence in depth for the same failure arriving from anywhere else: a
   * value this component cannot render must still not throw.
   */
  it('renders an unset moment as absent rather than crashing on it', () => {
    expect(() => setup(Number.NaN)).not.toThrow()
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})
