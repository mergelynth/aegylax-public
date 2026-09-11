import { describe, expect, it } from 'vitest'
import { includesAddress, sameAddress } from '../../utils/address'

describe('sameAddress', () => {
  it('treats checksummed and lowercase forms as the same account', () => {
    expect(
      sameAddress('0x00000000000000000000000000000000000000aA', '0x00000000000000000000000000000000000000aa'),
    ).toBe(true)
  })

  it('rejects a different account', () => {
    expect(
      sameAddress('0x00000000000000000000000000000000000000aa', '0x00000000000000000000000000000000000000bb'),
    ).toBe(false)
  })

  it('rejects a missing side rather than calling it a match', () => {
    expect(sameAddress(null, '0x00000000000000000000000000000000000000aa')).toBe(false)
    expect(sameAddress('0x00000000000000000000000000000000000000aa', undefined)).toBe(false)
  })
})

describe('includesAddress', () => {
  it('finds a checksummed winner in a lowercase list', () => {
    expect(
      includesAddress(
        ['0x00000000000000000000000000000000000000aa'],
        '0x00000000000000000000000000000000000000AA',
      ),
    ).toBe(true)
  })
})
