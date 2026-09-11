import { describe, expect, it } from 'vitest'
import { formatCountdown, formatEth, formatGameAmount, formatGameFigure, formatLongCountdown, formatClaimFigure, formatClaimEth } from '../../utils/format'

const oneSecond = 1000
const oneMinute = 60 * oneSecond
const oneHour = 60 * oneMinute
const oneDay = 24 * oneHour

describe('formatLongCountdown', () => {
  it('scales down to HH:MM:SS when less than a day remains', () => {
    expect(formatLongCountdown(4 * oneHour + 46 * oneMinute + 7 * oneSecond)).toBe('04:46:07')
  })

  it('adds days once they are non-zero', () => {
    expect(formatLongCountdown(145 * oneDay + 4 * oneHour)).toBe('145d 04:00:00')
  })

  it('adds years ahead of days, matching the Apocalypse Timer breakdown', () => {
    expect(formatLongCountdown(3 * 365 * oneDay + 145 * oneDay + 4 * oneHour)).toBe('3y 145d 04:00:00')
  })

  it('bottoms out at zero rather than counting negative', () => {
    expect(formatLongCountdown(-5000)).toBe('00:00:00')
  })
})

describe('formatCountdown', () => {
  it('pads each unit to two digits', () => {
    expect(formatCountdown(oneHour + 2 * oneMinute + 3 * oneSecond)).toBe('01:02:03')
  })
})

describe('formatEth', () => {
  it('trims trailing zeros', () => {
    expect(formatEth(0.002)).toBe('0.002 ETH')
    expect(formatEth(0)).toBe('0 ETH')
  })
})

describe('formatGameAmount', () => {
  it('labels the figure with whatever ticker the game is priced in', () => {
    expect(formatGameAmount(0.05, 'USDC')).toBe('0.05 USDC')
    expect(formatGameFigure(0.05)).toBe('0.05')
  })
})

describe('formatClaimFigure', () => {
  it('hard-caps at four decimals and strips trailing zeros', () => {
    expect(formatClaimFigure(0.01151234)).toBe('0.0115')
    expect(formatClaimFigure(0.25)).toBe('0.25')
    expect(formatClaimFigure(1)).toBe('1')
  })

  it('rounds rather than truncating the fifth place', () => {
    expect(formatClaimFigure(0.01156)).toBe('0.0116')
  })

  it('rounds dust to zero instead of expanding precision', () => {
    expect(formatClaimEth(0.00001)).toBe('0 ETH')
  })
})
