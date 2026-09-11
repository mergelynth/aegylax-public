import { describe, expect, it } from 'vitest'
import { decodeAbiParameters, parseAbiParameters } from 'viem'
import {
  cofheServiceDefaults,
  COFHE_ENVIRONMENTS,
  createGateway,
  describeInitFailure,
  FhenixGateway,
  IncoGateway,
  isCofheEnvironment,
  isVersionSkew,
  knownEngineKinds,
  MockGateway,
  normaliseRecoveryId,
  type GatewayParams,
} from '../../blockchain/contract/confidential'
import type { Address } from '../../game/types'

const ENGINE = '0x00000000000000000000000000000000000000ee' as Address
const PLAYER = '0x00000000000000000000000000000000000000aa' as Address

function params(overrides: Partial<GatewayParams> = {}): GatewayParams {
  return {
    kind: 'fhenix-cofhe',
    release: 'TESTNET',
    chainId: 84532,
    engineAddress: ENGINE,
    publicClient: {} as never,
    getWalletClient: () => null,
    ...overrides,
  }
}

/**
 * The registry is the whole of the frontend's coupling to a confidential
 * provider. What these check is that it stays a *lookup* — that the manifest
 * decides, that an unknown manifest is refused rather than guessed at, and
 * that a provider missing the one field it cannot work without says so with
 * the fix in the message.
 */
describe('createGateway', () => {
  it('builds the provider the manifest names', () => {
    expect(createGateway(params())).toBeInstanceOf(FhenixGateway)
    expect(createGateway(params({ kind: 'mock', release: null }))).toBeInstanceOf(MockGateway)
  })

  it('builds nothing for a provider this build has switched off', () => {
    expect(knownEngineKinds()).toEqual(expect.arrayContaining(['fhenix-cofhe', 'mock']))
    expect(knownEngineKinds()).not.toContain('inco-lightning')
  })

  /*
   * The distinction this checks is the whole reason `DISABLED_KINDS` is a
   * separate table: "switched off" and "never heard of it" want different
   * next moves from whoever reads the message, and a deployment that ran on
   * Inco last month is a real thing somebody can still open the app against.
   *
   * `IncoGateway` is still imported and still constructible right here —
   * only the factory refuses it.
   */
  it('names Inco as switched off rather than as unknown', () => {
    const build = () => createGateway(params({ kind: 'inco-lightning', release: 'devnet' }))
    expect(build).toThrow(/switched off in this build/)
    expect(build).toThrow(/Fhenix CoFHE/)
    expect(build).not.toThrow(/Unknown confidential engine/)
    expect(typeof IncoGateway).toBe('function')
  })

  /*
   * Not a fallback to the default provider. A manifest naming some other
   * confidential stack used to produce a client that encrypted against the
   * wrong network and failed later, somewhere unrelated, with an error about
   * a handle.
   */
  it('refuses a kind it has no implementation for', () => {
    expect(() => createGateway(params({ kind: 'zama-fhevm' }))).toThrow(/Unknown confidential engine "zama-fhevm"/)
    expect(() => createGateway(params({ kind: 'zama-fhevm' }))).toThrow(/fhenix-cofhe/)
    expect(() => createGateway(params({ kind: null }))).toThrow(/\(unset\)/)
  })

  it('refuses a Fhenix deployment with no CoFHE environment recorded', () => {
    expect(() => createGateway(params({ release: null }))).toThrow(/no CoFHE environment recorded/)
    // The message has to name the fix: the manifest is regenerable.
    expect(() => createGateway(params({ release: null }))).toThrow(/chain:sync/)
  })

  /*
   * Kept as a note rather than a test: the "no release recorded" refusal for
   * Inco is now unreachable through the factory, because the disabled check
   * runs first. The equivalent Fhenix path above is the live one.
   */

  /*
   * The session-verifier default is Inco's and is still filled in by
   * `createGateway`; with Inco switched off nothing reads it, and what
   * matters is that filling it in does not disturb the provider that is
   * actually built.
   */
  it('fills in the session verifier without disturbing the provider it builds', () => {
    expect(createGateway(params()).kind).toBe('fhenix-cofhe')
    expect(createGateway(params({ chainId: 8453 })).kind).toBe('fhenix-cofhe')
  })
})

describe('CoFHE environments', () => {
  it('accepts the four a manifest may name and nothing else', () => {
    expect([...COFHE_ENVIRONMENTS]).toEqual(['MAINNET', 'TESTNET', 'LOCAL', 'MOCK'])
    for (const environment of COFHE_ENVIRONMENTS) expect(isCofheEnvironment(environment)).toBe(true)
    expect(isCofheEnvironment('testnet')).toBe(false)
    expect(isCofheEnvironment('devnet')).toBe(false)
    expect(isCofheEnvironment(null)).toBe(false)
  })

  /*
   * The reveal and the health ping talk to these services without the SDK —
   * the reveal must not require a wallet, and the ping must work on a page
   * with no operation open — so the table cannot be empty for a hosted
   * environment.
   */
  it('resolves hosted endpoints for the networks that have them', () => {
    for (const environment of ['MAINNET', 'TESTNET', 'LOCAL'] as const) {
      const services = cofheServiceDefaults(environment)
      expect(services.thresholdNetworkUrl).toMatch(/^https?:\/\//)
      expect(services.verifierUrl).toMatch(/^https?:\/\//)
    }
  })

  it('has nothing to reach in MOCK, where CoFHE runs on the host chain', () => {
    expect(cofheServiceDefaults('MOCK')).toEqual({})
    expect(cofheServiceDefaults('nonsense')).toEqual({})
  })
})

/**
 * The one wire format the two halves of the Fhenix integration share.
 *
 * `FhenixGateway.encrypt` produces this and
 * `FhenixConfidentialEngine.newEncryptedPoint` decodes it with
 * `abi.decode(ciphertext, (uint256, uint8, uint8, bytes))`. Nothing type-
 * checks that agreement across the language boundary, so it is asserted
 * here against the same shape the Solidity side reads.
 */
describe('the Defense Point blob', () => {
  const gateway = new FhenixGateway(
    84532,
    ENGINE,
    () => ({ account: PLAYER }) as never,
    {} as never,
    'TESTNET',
    null,
  )

  it('encodes what the engine decodes', async () => {
    const item = {
      ctHash: 0x1234567890abcdefn,
      securityZone: 0,
      utype: 6,
      signature: '0xdeadbeef',
    }
    const blob = await encryptWith(gateway, item)

    const [ctHash, securityZone, utype, signature] = decodeAbiParameters(
      parseAbiParameters('uint256, uint8, uint8, bytes'),
      blob,
    )
    expect(ctHash).toBe(item.ctHash)
    expect(securityZone).toBe(item.securityZone)
    // `euint128` on both sides — `Utils.EUINT128_TFHE` in Solidity,
    // `FheTypes.Uint128` in the SDK. A mismatch is `InvalidCiphertext`.
    expect(utype).toBe(6)
    expect(signature).toBe(item.signature)
  })
})

/**
 * Drives `encrypt` with a stubbed SDK.
 *
 * `@cofhe/sdk` is a WASM bundle loaded through a dynamic import, so the real
 * one cannot run in jsdom — and the thing worth testing is not its
 * encryption but what this repository does with the result.
 */
async function encryptWith(
  gateway: FhenixGateway,
  item: { ctHash: bigint; securityZone: number; utype: number; signature: string },
): Promise<`0x${string}`> {
  /*
   * The builder, stubbed down to the two calls that carry a decision:
   * which contract will consume the blob, and which account it is bound to.
   * Both are recorded and checked below — they are the pair that made a
   * Defense Point one transaction instead of a rejected one.
   */
  const seen: { consumingContract?: string; account?: string; securityZone?: number } = {}
  const builder = {
    setAccount(account: string) {
      seen.account = account
      return builder
    },
    setChainId: () => builder,
    setSecurityZone(zone: number) {
      seen.securityZone = zone
      return builder
    },
    setConsumingContract(address: string) {
      seen.consumingContract = address
      return builder
    },
    execute: async () => [`0x${item.ctHash.toString(16)}`, item.signature],
  }
  const stub = { encryptInputs: () => builder }

  // The client handle is private; the test stands in for `connect()` having
  // already run rather than reaching around the class's own API.
  ;(gateway as unknown as { client: Promise<unknown>; clientOwner: Address }).client = Promise.resolve(stub)
  ;(gateway as unknown as { clientOwner: Address }).clientOwner = PLAYER

  const blob = await gateway.encrypt(1234n, PLAYER)

  // The verifier binds the consuming contract into the signature, and the
  // engine — not the game proxy — is what calls `batchVerifyInputs`.
  expect(seen.consumingContract).toBe(ENGINE)
  expect(seen.account).toBe(PLAYER)
  expect(seen.securityZone).toBe(0)
  return blob
}

/**
 * What the manifest tells the client, after the field it records was
 * renamed for the thing rather than for one provider's word for it.
 */
describe('resolveDeployment — the confidential layer', () => {
  /*
   * Deliberately not asserting *which* provider is deployed. That is the
   * one fact about the confidential layer that is allowed to change without
   * a code change — pinning it here would mean every provider switch broke
   * a test that is not about the switch. What has to hold is the join: the
   * shipped manifest names a kind this build can construct a gateway for,
   * and carries the release that gateway cannot work without.
   */
  it('names a provider the client can actually build, with its release', async () => {
    const { resolveDeployment } = await import('../../config/deployment')
    const deployment = resolveDeployment(84532)

    expect(knownEngineKinds()).toContain(deployment.confidentialEngineKind)
    expect(deployment.confidentialRelease).toBeTruthy()
    expect(deployment.confidentialExecutor).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(() =>
      createGateway(
        params({
          kind: deployment.confidentialEngineKind,
          release: deployment.confidentialRelease,
          executor: deployment.confidentialExecutor,
        }),
      ),
    ).not.toThrow()
  })

  it('is null on a chain with no deployment rather than a guess', async () => {
    const { resolveDeployment } = await import('../../config/deployment')
    const deployment = resolveDeployment(999999)
    expect(deployment.confidentialEngineKind).toBeNull()
    expect(deployment.confidentialRelease).toBeNull()
    expect(deployment.confidentialServices).toBeNull()
    expect(deployment.configured).toBe(false)
  })
})

/**
 * The one CoFHE failure that must not read as a network blip.
 *
 * When the coprocessor's FHE parameters are newer than the SDK that has to
 * parse them, the SDK reports an internal error / "An internal error
 * occurred" for every call afterwards. That is indistinguishable from a
 * connection problem and is the opposite of one: no retry fixes it, and the
 * confidential layer was never going to work for that build.
 */
describe('a CoFHE deployment newer than the SDK', () => {
  it('names the version skew instead of reporting an internal error', () => {
    const message = describeInitFailure('TESTNET', {
      message: 'An internal error occurred',
      cause: { message: 'Error serializing CRS Error: "invalid value: integer `1`, expected variant index 0 <= i < 1"' },
    } as never)

    expect(message).toMatch(/version skew/i)
    expect(message).toMatch(/not a connection problem/i)
    // The one thing an operator can actually do about it, now that there is
    // no second provider to fall back to.
    expect(message).toMatch(/upgrade @cofhe\/sdk/i)
    expect(message).toMatch(/Retrying will not help/i)
  })

  it('catches the public-key half of the same skew', () => {
    const message = describeInitFailure('MAINNET', {
      message: 'An internal error occurred',
      cause: { message: 'Error serializing public key Error: Custom("invalid value: integer `78090`, expected usize")' },
    } as never)
    expect(message).toMatch(/version skew/i)
    expect(message).toContain('MAINNET')
  })

  it('leaves an ordinary failure reading as one', () => {
    const message = describeInitFailure('TESTNET', { message: 'fetch failed' })
    expect(message).toMatch(/Could not reach the "TESTNET" CoFHE deployment/)
    expect(message).toContain('fetch failed')
    expect(message).not.toMatch(/version skew/i)
  })
})

/**
 * The recovery byte, and why a reveal used to fail with everything correct.
 *
 * CoFHE's threshold network signs a decryption with a raw recovery id — `v`
 * is 0 or 1 — while `ECDSA.recover`, which its own `verifyDecryptResult`
 * calls, accepts only 27 or 28 and rejects anything else outright. Passed
 * through untouched the signature is valid in every respect and still fails,
 * and it fails in the worst place: `unlockRound` is already mined and paid
 * for by the time the second transaction is refused, so the round reads as
 * stuck rather than as misconfigured.
 *
 * Measured against Base Sepolia: the same handle and plaintext verify
 * `false` at `v = 0` and `true` at `v = 27`.
 */
describe('normaliseRecoveryId', () => {
  const body = `0x${'ab'.repeat(64)}` as const
  const sig = (v: string) => `${body}${v}` as `0x${string}`

  it('lifts a raw recovery id into the range Solidity can recover from', () => {
    expect(normaliseRecoveryId(sig('00'))).toBe(sig('1b'))
    expect(normaliseRecoveryId(sig('01'))).toBe(sig('1c'))
  })

  it('leaves a signature that already uses 27/28 alone', () => {
    expect(normaliseRecoveryId(sig('1b'))).toBe(sig('1b'))
    expect(normaliseRecoveryId(sig('1c'))).toBe(sig('1c'))
  })

  /*
   * Rewriting a byte of something this does not recognise would corrupt a
   * signature that might have been fine. Anything not 65 bytes, or with a
   * recovery id outside {0,1}, is returned untouched.
   */
  it('does not touch a shape it does not recognise', () => {
    expect(normaliseRecoveryId('0xdeadbeef')).toBe('0xdeadbeef')
    expect(normaliseRecoveryId(sig('ff'))).toBe(sig('ff'))
    expect(normaliseRecoveryId('0x')).toBe('0x')
  })
})

/**
 * A green shield over a Defend button that cannot work is worse than a
 * yellow one — it tells a player the thing they are about to spend a
 * transaction on is healthy. `isVersionSkew` is what separates "this build
 * can never use this network" from every failure that a retry might fix.
 */
describe('isVersionSkew', () => {
  it('recognises both halves of the parameter mismatch', () => {
    expect(
      isVersionSkew({
        message: 'An internal error occurred',
        cause: { message: 'Error serializing CRS Error: "invalid value: integer `1`, expected variant index 0 <= i < 1"' },
      } as never),
    ).toBe(true)
    expect(
      isVersionSkew({
        message: 'An internal error occurred',
        cause: { message: 'Error serializing public key Error: Custom("expected usize")' },
      } as never),
    ).toBe(true)
  })

  it('does not claim an ordinary outage is unfixable', () => {
    expect(isVersionSkew({ message: 'fetch failed' })).toBe(false)
    expect(isVersionSkew({ message: 'connection refused' })).toBe(false)
    expect(isVersionSkew(null)).toBe(false)
  })
})
