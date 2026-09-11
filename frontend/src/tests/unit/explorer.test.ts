import { describe, expect, it } from 'vitest'
import { parseEnv } from '../../config/env'
import { getAddressUrl, getBlockUrl, getTxUrl, hasExplorer, shortHash } from '../../utils/explorer'

function configWith(explorerUrl: string | undefined) {
  return parseEnv({
    VITE_BLOCKCHAIN_MODE: 'contract',
    VITE_CHAIN_ID: '84532',
    VITE_EXPLORER_URL: explorerUrl,
  } as unknown as ImportMetaEnv)
}

/**
 * Explorer links are centralized precisely so that "which network am I on"
 * is answered once (ТЗ §12). These check the two halves of that: the URL is
 * built from the active config, and the absence of an explorer produces no
 * link rather than a broken one.
 */
describe('explorer helpers', () => {
  const config = configWith('https://sepolia.basescan.org')

  it('builds transaction, block and address URLs from the active network', () => {
    expect(getTxUrl('0xabc', config)).toBe('https://sepolia.basescan.org/tx/0xabc')
    expect(getBlockUrl(1234, config)).toBe('https://sepolia.basescan.org/block/1234')
    expect(getAddressUrl('0xdef', config)).toBe('https://sepolia.basescan.org/address/0xdef')
  })

  it('tolerates a trailing slash in the configured base', () => {
    const trailing = configWith('https://sepolia.basescan.org/')
    expect(getTxUrl('0xabc', trailing)).toBe('https://sepolia.basescan.org/tx/0xabc')
  })

  it('returns null rather than a dead link when the network has no explorer', () => {
    const emulator = parseEnv({ VITE_BLOCKCHAIN_MODE: 'emulator' } as unknown as ImportMetaEnv)
    expect(hasExplorer(emulator)).toBe(false)
    expect(getTxUrl('0xabc', emulator)).toBeNull()
    expect(getBlockUrl(1, emulator)).toBeNull()
    expect(getAddressUrl('0xabc', emulator)).toBeNull()
  })

  it('returns null for missing values instead of linking to nothing', () => {
    expect(getTxUrl(null, config)).toBeNull()
    expect(getBlockUrl(null, config)).toBeNull()
    expect(getAddressUrl(undefined, config)).toBeNull()
  })

  it('accepts block zero, which is a real block', () => {
    expect(getBlockUrl(0, config)).toBe('https://sepolia.basescan.org/block/0')
  })

  it('abbreviates long hashes and leaves short ones alone', () => {
    expect(shortHash('0x1234567890abcdef1234567890abcdef')).toBe('0x1234…cdef')
    expect(shortHash('0x1234')).toBe('0x1234')
    expect(shortHash(null)).toBe('')
  })
})
