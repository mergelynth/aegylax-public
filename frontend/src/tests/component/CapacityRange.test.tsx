import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CapacityRange } from '../../components/common/CapacityRange'

/**
 * A pointer event that actually carries coordinates.
 *
 * `fireEvent.pointerDown(el, { clientX })` does not: jsdom implements no
 * `PointerEvent`, so testing-library falls back to a plain `Event`, whose
 * init has no `clientX` to assign — the press arrives at the handler with
 * undefined coordinates and every value resolves to `NaN`. A `MouseEvent`
 * dispatched under the pointer event's name carries the coordinates the
 * real event would, which is the whole of what this control reads.
 */
function press(element: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  fireEvent(element, event)
}

/** Width of the scale box the tests lay out, so `x` maps to `x / WIDTH`. */
const WIDTH = 200
const MIN = 2
const MAX = 22

/** Where a value sits along that box, in client x. */
function xOf(value: number): number {
  return ((value - MIN) / (MAX - MIN)) * WIDTH
}

function setup(lower = 4, upper = 16) {
  const onChange = vi.fn()
  render(
    <CapacityRange
      label="Players"
      handleLabels={['Min players', 'Max players']}
      lower={lower}
      upper={upper}
      onChange={onChange}
      min={MIN}
      max={MAX}
      readout={`${lower} – ${upper}`}
    />,
  )

  // The rail is the press surface: the inputs sit inside the scale, and the
  // scale sits inside the rail.
  const scale = screen.getByRole('slider', { name: 'Min players' }).parentElement
  const rail = scale?.parentElement
  if (!scale || !rail) throw new Error('rail not found')

  /*
   * The rail turns a press into a value by measuring its own scale box, and
   * jsdom lays everything out at zero size — so without this every press
   * resolves to the minimum. Defined on the one element that is measured
   * rather than on `Element.prototype`, so nothing else in the tree is
   * given a fictitious size.
   */
  Object.defineProperty(scale, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, right: WIDTH, bottom: 22, width: WIDTH, height: 22, x: 0, y: 0, toJSON: () => ({}) }),
  })

  return { onChange, rail }
}

describe('<CapacityRange />', () => {
  /*
   * The regression this exists for.
   *
   * The rail used to disable pointer events on the inputs and re-enable them
   * only on the native thumbs — the standard way to stop two stacked range
   * inputs eating each other's presses. It leaves a hole: a press on the
   * *track* lands on nothing, so the handles could be dragged but the rail
   * could not be clicked, which is the one thing every slider does.
   */
  it('moves the nearer handle to a click on the track', () => {
    const { onChange, rail } = setup(4, 16)

    // A quarter along a 2–22 rail is 7 — nearer the lower handle at 4.
    press(rail, 'pointerdown', xOf(7))

    expect(onChange).toHaveBeenCalledWith(7, 16)
  })

  it('takes the upper handle when the press is nearer to it', () => {
    const { onChange, rail } = setup(4, 16)

    // Past the upper handle at 16, so that is the one the press takes.
    press(rail, 'pointerdown', xOf(17))

    expect(onChange).toHaveBeenCalledWith(4, 17)
  })

  it('keeps following the pointer when the press becomes a drag', () => {
    const { onChange, rail } = setup(4, 16)

    press(rail, 'pointerdown', xOf(7))
    press(rail, 'pointermove', xOf(3))

    expect(onChange).toHaveBeenLastCalledWith(3, 16)
  })

  /*
   * The handles cannot cross, so dragging one past the other clamps rather
   * than swapping them — "max below min" is a state this control has no way
   * to express.
   */
  it('clamps a handle against the other rather than letting them cross', () => {
    const { onChange, rail } = setup(4, 16)

    // The press takes `upper`; dragging it below `lower` stops at `lower`.
    press(rail, 'pointerdown', xOf(17))
    press(rail, 'pointermove', xOf(MIN))

    expect(onChange).toHaveBeenLastCalledWith(4, 4)
  })

  /*
   * A collided pair has no nearer handle and no direction to infer, so the
   * choice waits for the first movement. Deciding it on the press is what
   * used to leave one handle unable to travel at all: whichever was picked
   * clamps immediately against the other.
   */
  it('resolves a collided pair from the direction of the drag', () => {
    const { onChange, rail } = setup(10, 10)

    press(rail, 'pointerdown', xOf(10))
    expect(onChange).not.toHaveBeenCalled()

    press(rail, 'pointermove', xOf(14))
    expect(onChange).toHaveBeenLastCalledWith(10, 14)
  })

  it('still exposes both handles as sliders for the keyboard', () => {
    setup(4, 16)

    expect(screen.getByRole('slider', { name: 'Min players' })).toHaveValue('4')
    expect(screen.getByRole('slider', { name: 'Max players' })).toHaveValue('16')
  })
})
