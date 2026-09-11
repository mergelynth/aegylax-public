import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ArcControl } from '../../components/common/ArcControl'

/**
 * The creator fee's drag used to stick: `pointerup` in the same tick as
 * `pointerdown` read a stale `dragging` flag, left pointer capture held,
 * and the next field the pointer visited kept moving the fee.
 */
describe('<ArcControl /> pointer capture', () => {
  it('stops tracking the fee once the pointer is released onto another field', () => {
    const onChange = vi.fn()
    render(
      <ArcControl
        label="Creator fee"
        value={5}
        onChange={onChange}
        min={0}
        max={20}
        readout="5%"
        valueText="5 percent"
      />,
    )

    const svg = document.querySelector('svg')
    expect(svg).not.toBeNull()

    fireEvent.pointerDown(svg!, { button: 0, pointerId: 1, buttons: 1, clientX: 20, clientY: 8 })
    const afterDown = onChange.mock.calls.length
    expect(afterDown).toBeGreaterThan(0)

    // Release happens on the window, as it does when the next click lands
    // on the neighbouring deadline field rather than on the arc.
    fireEvent.pointerUp(window, { pointerId: 1, button: 0, buttons: 0 })

    fireEvent.pointerMove(svg!, { pointerId: 1, buttons: 1, clientX: 70, clientY: 8 })
    expect(onChange).toHaveBeenCalledTimes(afterDown)
  })

  it('still names the fee for assistive tech', () => {
    render(
      <ArcControl
        label="Creator fee"
        value={5}
        onChange={vi.fn()}
        min={0}
        max={20}
        readout="5%"
        valueText="5 percent"
      />,
    )
    expect(screen.getByRole('slider', { name: /creator fee/i })).toHaveAttribute('aria-valuenow', '5')
  })
})
