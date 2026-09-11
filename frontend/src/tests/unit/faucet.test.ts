import { describe, expect, it, vi } from 'vitest'

vi.mock('../../config/env', () => ({
  appConfig: { protocol: { minEntryPrice: 0.0005 } },
}))

const { describeRetryWait, faucetThresholdEth, isWalletEmpty, isWalletLow } = await import(
  '../../hooks/useFaucet'
)

/**
 * The faucet's two client-side decisions: when to offer it, and how to say
 * "not yet". Everything else — the amount, the cooldown, whether the wallet
 * has already been paid — belongs to `api/faucet/`, because it is the only
 * side that can hold the key or read the chain's own record of the drips.
 */
describe('faucet eligibility (демо)', () => {
  it('offers a top-up below a session’s worth of ETH', () => {
    expect(faucetThresholdEth()).toBeCloseTo(0.02)
    expect(isWalletLow(0)).toBe(true)
    expect(isWalletLow(0.0199)).toBe(true)
  })

  it('stops offering it at the threshold', () => {
    expect(isWalletLow(0.02)).toBe(false)
    expect(isWalletLow(0.5)).toBe(false)
  })

  /*
   * The balance arrives a moment after the header does. Treating "not known
   * yet" as "empty" would flash the offer on every page load, on every
   * wallet, including the ones that are full.
   */
  it('says nothing while the balance is still loading', () => {
    expect(isWalletLow(null)).toBe(false)
  })
})

/**
 * The header's line, which is not the panel's. The drop beside the balance
 * interrupts, so it is spent only on the one balance nothing can be done
 * with — see `isWalletEmpty`.
 */
describe('the header’s drip', () => {
  it('marks an empty wallet and nothing else', () => {
    expect(isWalletEmpty(0)).toBe(true)
    expect(isWalletEmpty(0.0001)).toBe(false)
  })

  /* Low enough for the panel to offer a top-up is still not empty. */
  it('stays quiet on a wallet the panel would still offer to top up', () => {
    expect(isWalletLow(0.01)).toBe(true)
    expect(isWalletEmpty(0.01)).toBe(false)
  })

  it('does not read an unknown balance as an empty one', () => {
    expect(isWalletEmpty(null)).toBe(false)
  })
})

describe('faucet cooldown wording', () => {
  const now = 1_700_000_000_000

  it('counts in hours while there are hours left', () => {
    expect(describeRetryWait(now + 3 * 3_600_000, now)).toBe('in 3 hours')
    expect(describeRetryWait(now + 3_600_000, now)).toBe('in 1 hour')
  })

  it('drops to minutes inside the last hour', () => {
    expect(describeRetryWait(now + 12 * 60_000, now)).toBe('in 12 minutes')
    expect(describeRetryWait(now + 60_000, now)).toBe('in 1 minute')
  })

  /*
   * A wait that has already elapsed must not print as a negative number or
   * as "in 0 minutes" — by the time anybody reads it the answer is "press
   * the button".
   */
  it('never counts backwards', () => {
    expect(describeRetryWait(now - 5_000, now)).toBe('in a moment')
    expect(describeRetryWait(now, now)).toBe('in a moment')
  })
})
