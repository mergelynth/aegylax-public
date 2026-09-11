import { describe, expect, it } from 'vitest'
import {
  accountAddressOf,
  clearPersistedIncoSession,
  covalidatorLagSeconds,
  defaultSessionVerifier,
  describeCovalidatorLag,
  hostChainRpcUrlsForLightning,
  incoSessionStorageKey,
  isCovalidatorBehind,
  isConfidentialNetworkQuiet,
  isNetworkUnavailable,
  isTransientDecryptFailure,
  loadPersistedIncoSession,
  savePersistedIncoSession,
  SESSION_RENEWAL_MARGIN_MS,
} from '../../blockchain/contract/confidential'
import type { Address } from '../../game/types'

describe('accountAddressOf', () => {
  it('reads a string account — the shape the signer bridge actually attaches', () => {
    const address = '0x00000000000000000000000000000000000000aa' as Address
    expect(accountAddressOf({ account: address })).toBe(address)
  })

  it('reads an Account object', () => {
    const address = '0x00000000000000000000000000000000000000aa' as Address
    expect(accountAddressOf({ account: { address } })).toBe(address)
  })

  it('does not invent an address when nothing is attached', () => {
    expect(accountAddressOf({})).toBeUndefined()
    expect(accountAddressOf(null)).toBeUndefined()
  })
})

describe('defaultSessionVerifier', () => {
  it('uses Inco\'s published Base Sepolia verifier so a probe is one transaction', () => {
    expect(defaultSessionVerifier(84532)).toBe('0xc34569efc25901bdd6b652164a2c8a7228b23005')
  })

  it('uses Inco\'s published Base verifier', () => {
    expect(defaultSessionVerifier(8453)).toBe('0x68a5b59b4caf23416885859c1662746619a471f3')
  })

  it('does not guess on a chain Inco has not published a verifier for', () => {
    expect(defaultSessionVerifier(1)).toBeNull()
  })
})

describe('hostChainRpcUrlsForLightning', () => {
  it('hands Inco only the first HTTPS URL so its unbatched signer reads do not storm the fallbacks', () => {
    expect(
      hostChainRpcUrlsForLightning([
        'https://sepolia.base.org',
        'https://base-sepolia.g.alchemy.com/v2/key',
      ]),
    ).toEqual(['https://sepolia.base.org'])
  })

  it('drops WebSocket URLs — those are the app live-block feed, not Inco\'s transport', () => {
    expect(
      hostChainRpcUrlsForLightning(['wss://base-sepolia.g.alchemy.com/v2/key', 'https://sepolia.base.org']),
    ).toEqual(['https://sepolia.base.org'])
  })

  it('returns undefined when nothing HTTP remains, so Lightning keeps its own default', () => {
    expect(hostChainRpcUrlsForLightning([])).toBeUndefined()
    expect(hostChainRpcUrlsForLightning(['wss://example.invalid'])).toBeUndefined()
  })
})

describe('isNetworkUnavailable', () => {
  it('recognises an unreachable covalidator quorum', () => {
    expect(isNetworkUnavailable(new Error('cannot reach threshold'))).toBe(true)
  })

  it('does not treat our own read deadline as the network being down', () => {
    expect(isNetworkUnavailable(new Error('Timed out waiting to fetch the revealed attack data'))).toBe(false)
  })

  it('does not treat an ACL that has not landed yet as the network being down', () => {
    expect(isNetworkUnavailable(new Error('failed to check acl'))).toBe(false)
  })
})

describe('isTransientDecryptFailure', () => {
  it('treats Inco\'s "Failed to decrypt handles" as ingestion lag, not a refused session', () => {
    expect(isTransientDecryptFailure(new Error('Failed to decrypt handles'))).toBe(true)
  })

  it('treats a covalidator that has not ingested collectProbe as ingestion lag', () => {
    expect(isTransientDecryptFailure(new Error('failed to check acl'))).toBe(true)
  })

  it('does not wait out an indexer that is half an hour behind the chain', () => {
    const error = new Error(
      'rpc error: code = Internal desc = failed to check acl; out of sync: 1725 seconds behind',
    )
    expect(isCovalidatorBehind(error)).toBe(true)
    expect(covalidatorLagSeconds(error)).toBe(1725)
    expect(describeCovalidatorLag(error)).toBe('The privacy layer is 29 minutes behind the chain.')
    expect(isTransientDecryptFailure(error)).toBe(false)
  })

  it('does not treat a declined signature as something to wait out', () => {
    expect(isTransientDecryptFailure(new Error('User rejected the request'))).toBe(false)
  })
})

describe('isConfidentialNetworkQuiet', () => {
  it('recognises the player-facing copy when the quorum will not answer', () => {
    expect(
      isConfidentialNetworkQuiet(
        new Error('The privacy layer is slow to answer. Still calculating your result.'),
      ),
    ).toBe(true)
  })

  it('does not treat a refused handle as the network being quiet', () => {
    expect(isConfidentialNetworkQuiet(new Error('Could not open your Recon Probe result: Failed to decrypt handles'))).toBe(
      false,
    )
  })
})

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value)
    },
    removeItem: (key) => {
      map.delete(key)
    },
  }
}

describe('persisted Inco session', () => {
  const owner = '0x00000000000000000000000000000000000000aa' as Address
  const key = incoSessionStorageKey(84532, owner)
  const session = {
    privateKey: `0x${'11'.repeat(32)}` as `0x${string}`,
    voucher: { kind: 'allowance' },
    expiresAtMs: Date.now() + 50 * 60 * 1000,
  }

  it('round-trips a voucher so a reload does not re-prompt', () => {
    const storage = memoryStorage()
    savePersistedIncoSession(storage, key, session)
    const loaded = loadPersistedIncoSession(storage, key)
    expect(loaded).toEqual(session)
  })

  it('drops a session close to expiry rather than handing a lapsing voucher to a read', () => {
    const storage = memoryStorage()
    savePersistedIncoSession(storage, key, {
      ...session,
      expiresAtMs: Date.now() + SESSION_RENEWAL_MARGIN_MS - 1,
    })
    expect(loadPersistedIncoSession(storage, key)).toBeNull()
    expect(storage.getItem(key)).toBeNull()
  })

  it('forgets a stored credential when asked, without implying wallet disconnect must wipe it', () => {
    const storage = memoryStorage()
    savePersistedIncoSession(storage, key, session)
    clearPersistedIncoSession(storage, key)
    expect(loadPersistedIncoSession(storage, key)).toBeNull()
  })
})
