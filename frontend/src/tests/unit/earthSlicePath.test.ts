import { describe, expect, it } from 'vitest'
import { railPerimeterPath } from '../../components/command/CommandRailLive'

describe('railPerimeterPath', () => {
  it('draws a closed rounded rectangle, not an earth chord', () => {
    const stroke = railPerimeterPath(1040, 72)
    expect(stroke.startsWith('M')).toBe(true)
    expect(stroke.match(/A/g)?.length).toBe(4)
    expect(stroke).toMatch(/H/)
    expect(stroke).toMatch(/V/)
  })

  it('still closes on the compact chassis', () => {
    const stroke = railPerimeterPath(360, 108)
    expect(stroke.startsWith('M')).toBe(true)
    expect(stroke.match(/A/g)?.length).toBe(4)
  })
})
