import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROVIDER,
  PROVIDERS,
  manifestEntry,
  providerByContract,
  providerByKind,
  providerIds,
  readRelease,
  resolveProvider,
  // @ts-expect-error — pipeline tooling is plain ESM with no type declarations.
} from '../../../../tools/chain/confidential.mjs'
import { knownEngineKinds } from '../../blockchain/contract/confidential'

/**
 * The deployment pipeline's provider table, and the promise it makes to the
 * frontend.
 *
 * The two halves of a provider live in different languages and are chosen at
 * different times — an `IConfidentialEngine` picked by `CONFIDENTIAL_ENGINE`
 * at deploy time, a `ConfidentialGateway` picked by `kind` at page load —
 * and the only thing joining them is a string in the manifest. Nothing
 * type-checks that join, so it is checked here: every provider the deployer
 * can write must be one the client can read.
 */
describe('the provider table', () => {
  it('offers Fhenix and the mock, with Fhenix as the default', () => {
    // Inco is still *in* the table — it is simply not on offer. See `disabled`.
    expect(providerIds()).toEqual(['fhenix', 'mock'])
    expect(PROVIDERS.inco).toBeDefined()
    expect(DEFAULT_PROVIDER).toBe('fhenix')
    expect(PROVIDERS[DEFAULT_PROVIDER].kind).toBe('fhenix-cofhe')
    expect(PROVIDERS[DEFAULT_PROVIDER].contract).toBe('FhenixConfidentialEngine')
  })

  it('writes only kinds the frontend can build a gateway for', () => {
    const client = knownEngineKinds()
    for (const id of providerIds()) {
      expect(client).toContain(PROVIDERS[id].kind)
    }
  })

  it('finds a provider by the two things a manifest records', () => {
    expect(providerByKind('fhenix-cofhe')?.id).toBe('fhenix')
    expect(providerByContract('IncoConfidentialEngine')?.id).toBe('inco')
    expect(providerByKind('zama-fhevm')).toBeNull()
  })

  /*
   * CoFHE bills confidential work as gas on the calling transaction; Inco
   * charges a per-operation fee out of the engine's own balance. The
   * deployer funds on this flag alone, so getting it wrong either strands
   * ETH in a contract that never spends it or leaves a protocol that cannot
   * start an attack.
   */
  it('knows which engines have to hold a balance', () => {
    expect(PROVIDERS.fhenix.needsFunding).toBe(false)
    expect(PROVIDERS.inco.needsFunding).toBe(true)
    expect(PROVIDERS.mock.needsFunding).toBe(false)
  })
})

describe('resolveProvider', () => {
  it('defaults to Fhenix when nothing is configured', () => {
    const { provider, release, reuse } = resolveProvider({})
    expect(provider.id).toBe('fhenix')
    expect(release).toBe('TESTNET')
    expect(reuse).toBeNull()
  })

  it('takes the provider from CONFIDENTIAL_ENGINE', () => {
    expect(resolveProvider({ CONFIDENTIAL_ENGINE: 'mock' }).provider.id).toBe('mock')
    expect(resolveProvider({ CONFIDENTIAL_ENGINE: 'fhenix' }).provider.id).toBe('fhenix')
  })

  /*
   * A switched-off provider is refused at the point of selection, not three
   * steps later inside `assertConsistent` — the answer is "this build does
   * not deploy that any more", not "that network looks wrong".
   */
  it('refuses a provider this build has switched off, and says how to undo it', () => {
    expect(() => resolveProvider({ CONFIDENTIAL_ENGINE: 'inco' })).toThrow(/switched off in this build/)
    expect(() => resolveProvider({ CONFIDENTIAL_ENGINE: 'inco' })).toThrow(/confidential\.mjs/)
  })

  /*
   * An address is not a provider — it is an instruction to reuse an engine
   * that already exists, and which provider that engine *is* has to be read
   * off the chain (`engineKind()`) rather than guessed from configuration.
   */
  it('treats an address as reuse rather than as a provider', () => {
    const { reuse, provider } = resolveProvider({
      CONFIDENTIAL_ENGINE: '0x00000000000000000000000000000000000000ee',
    })
    expect(reuse).toBe('0x00000000000000000000000000000000000000ee')
    expect(provider).toBeNull()
  })

  it('refuses a provider it has no adapter for', () => {
    expect(() => resolveProvider({ CONFIDENTIAL_ENGINE: 'zama' })).toThrow(/Unknown CONFIDENTIAL_ENGINE "zama"/)
  })
})

describe('readRelease', () => {
  it('reads each provider’s own variable', () => {
    expect(readRelease({ COFHE_ENVIRONMENT: 'MAINNET' }, PROVIDERS.fhenix)).toBe('MAINNET')
    expect(readRelease({ INCO_PEPPER: 'testnet' }, PROVIDERS.inco)).toBe('testnet')
  })

  it('lets CONFIDENTIAL_RELEASE override whichever one applies', () => {
    expect(readRelease({ CONFIDENTIAL_RELEASE: 'LOCAL', COFHE_ENVIRONMENT: 'MAINNET' }, PROVIDERS.fhenix)).toBe('LOCAL')
    expect(readRelease({ CONFIDENTIAL_RELEASE: 'devnet', INCO_PEPPER: 'mainnet' }, PROVIDERS.inco)).toBe('devnet')
  })

  /*
   * A typo here is the failure the whole check exists for: the client
   * resolves its services from this name, so a release the provider does not
   * have produces handles nothing can open — silently, until the first Recon
   * Probe. Refusing at deploy time is the only place it is cheap.
   */
  it('refuses a release the provider does not have', () => {
    expect(() => readRelease({ COFHE_ENVIRONMENT: 'devnet' }, PROVIDERS.fhenix)).toThrow(/Unknown Fhenix CoFHE release/)
    expect(() => readRelease({ INCO_PEPPER: 'TESTNET' }, PROVIDERS.inco)).toThrow(/Unknown Inco Lightning release/)
  })

  it('has nothing to read for the mock, which has no network', () => {
    expect(readRelease({}, PROVIDERS.mock)).toBeNull()
  })
})

describe('manifestEntry', () => {
  it('records the neutral release field for every provider', () => {
    const entry = manifestEntry({
      provider: PROVIDERS.fhenix,
      release: 'TESTNET',
      address: '0xeeee',
      executor: '0xtask',
    })
    expect(entry).toMatchObject({
      kind: 'fhenix-cofhe',
      contract: 'FhenixConfidentialEngine',
      release: 'TESTNET',
      executor: '0xtask',
    })
    // Nothing Inco-shaped on a Fhenix deployment.
    expect(entry).not.toHaveProperty('pepper')
  })

  /*
   * Inco manifests keep `pepper` alongside `release`, because tooling and
   * manifests written before the rename still look for it.
   */
  it('keeps Inco’s own spelling beside the neutral one', () => {
    const entry = manifestEntry({ provider: PROVIDERS.inco, release: 'devnet', address: '0xeeee', executor: '0xexec' })
    expect(entry.release).toBe('devnet')
    expect(entry.pepper).toBe('devnet')
  })
})
