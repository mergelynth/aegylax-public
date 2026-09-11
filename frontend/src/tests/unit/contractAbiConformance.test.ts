import { decodeAbiParameters, encodeAbiParameters, type AbiParameter } from 'viem'
import { describe, expect, it } from 'vitest'
import abi from '../../contracts/generated/abi.json'
import {
  toLobby,
  toLobbyConfig,
  toParticipant,
  type ChainGameParams,
  type ChainLobby,
  type ChainLobbyConfig,
  type ChainParticipant,
} from '../../blockchain/contract/codec'
import type { Address, Hash } from '../../game/types'

/**
 * The adapter, checked against the ABI it actually talks to.
 *
 * This exists because the failure it catches is *silent*. viem decodes a
 * struct into an object keyed by the ABI's own parameter names, so a field
 * the frontend renamed — or one the contract dropped — does not fail to
 * compile and does not throw. It reads back `undefined`, and `undefined`
 * then flows into a price the UI displays, a `value` a payable call is sent
 * with, or an argument list that no longer matches any function.
 *
 * That is not hypothetical: `LobbyConfig` stopped carrying the recon terms
 * when the threat became the epoch's rather than the operation's, and for as
 * long as the adapter kept reading them from there, the Recon panel priced
 * probes at `NaN` ETH and `buyProbes` was sent `undefined` wei.
 *
 * So the tests below do not assert against hand-written fixtures. They build
 * values through the *real* ABI's encoder and decode them back, which is the
 * only way to be sure the names the codec reads are the names the chain
 * sends.
 */

interface AbiFunction {
  type: string
  name: string
  inputs: AbiParameter[]
  outputs?: AbiParameter[]
  stateMutability: string
}

const FUNCTIONS = (abi as AbiFunction[]).filter((entry) => entry.type === 'function')

function fn(name: string): AbiFunction {
  const found = FUNCTIONS.find((entry) => entry.name === name)
  if (!found) throw new Error(`No "${name}" in the generated ABI`)
  return found
}

/** Every leaf of a struct filled with a distinguishable non-zero value. */
function sample(parameter: AbiParameter, seed: number): unknown {
  const components = (parameter as { components?: AbiParameter[] }).components
  if (components) {
    if (parameter.type.endsWith('[]')) return []
    const out: Record<string, unknown> = {}
    components.forEach((component, index) => {
      out[component.name ?? `_${index}`] = sample(component, seed + index + 1)
    })
    return out
  }
  if (parameter.type.endsWith('[]')) return []
  if (parameter.type === 'string') return `sample-${seed}`
  if (parameter.type === 'bool') return true
  if (parameter.type === 'address') return `0x${String(seed % 10).repeat(40)}` as Address
  if (parameter.type.startsWith('bytes')) {
    return parameter.type === 'bytes' ? '0x' : (`0x${String(seed % 10).repeat(64)}` as Hash)
  }
  return BigInt(seed + 1)
}

/**
 * A struct as the chain would actually hand it over: encoded with the ABI's
 * own types and decoded back, so the keys are the chain's keys and nothing
 * a fixture author believed is involved.
 */
function roundTrip<T>(parameter: AbiParameter, seed = 1): T {
  const value = sample(parameter, seed)
  const encoded = encodeAbiParameters([parameter], [value])
  return decodeAbiParameters([parameter], encoded)[0] as T
}

function outputOf(functionName: string, index: number): AbiParameter {
  const outputs = fn(functionName).outputs ?? []
  const parameter = outputs[index]
  if (!parameter) throw new Error(`"${functionName}" has no output at ${index}`)
  return parameter
}

/** Nothing the UI shows or pays with may be undefined or NaN. */
function expectNoHoles(value: unknown, path = '$'): void {
  if (value === undefined) throw new Error(`${path} is undefined`)
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error(`${path} is ${value}`)
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expectNoHoles(entry, `${path}[${index}]`))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) expectNoHoles(entry, `${path}.${key}`)
  }
}

describe('contract adapter conforms to the generated ABI', () => {
  /**
   * The writes the client sends, with the argument count the ABI declares.
   *
   * An argument list of the wrong length does not reach the chain at all —
   * viem refuses to encode it — so a stale call site shows up to a player as
   * a button that does nothing. Every entry here is a call that was, at some
   * point, exactly that.
   */
  it.each([
    ['createLobby', 1],
    ['joinLobby', 1],
    ['leaveLobby', 1],
    ['buyProbes', 2],
    ['sendProbe', 3],
    ['collectProbe', 1],
    ['submitDefense', 2],
    ['startOperation', 1],
    ['cancelLobby', 1],
    ['completeAttack', 1],
    ['revealEpochAttack', 4],
    ['unlockDefenses', 1],
    ['resolveLobby', 2],
    ['proveDefenses', 3],
    ['finalizeScoring', 1],
    ['revealAndResolve', 5],
    ['claimReward', 1],
    ['claimRefund', 1],
    ['settleCreator', 1],
    ['expireAttack', 1],
    ['withdrawProtocolFees', 2],
  ])('%s takes %i argument(s)', (name, arity) => {
    expect(fn(name).inputs).toHaveLength(arity)
  })

  /**
   * The two functions whose key changed when attacks became the epoch's.
   *
   * An attempt list and an outcome belong to a *team*, so both are keyed by
   * the operation — while the trajectory belongs to the epoch's one threat
   * and is keyed by the attack. Asking either of the first two for an attack
   * id is not an error on chain: it is a lookup that misses and returns a
   * zeroed struct, which is why a resolved operation showed no winner and a
   * submitted defense never came back.
   */
  it('keys attempts and outcomes by the operation, and the trajectory by the attack', () => {
    expect(fn('getDefenseAttempts').inputs[0]?.name).toBe('lobbyId')
    expect(fn('getOutcome').inputs[0]?.name).toBe('lobbyId')
    expect(fn('getTrajectory').inputs[0]?.name).toBe('attackId')
    // Landing an attack is a fact about the world, so it is keyed by epoch.
    expect(fn('completeAttack').inputs[0]?.name).toBe('epochId')
    expect(fn('completeAttack').inputs[0]?.type).toBe('uint32')
    expect(fn('revealEpochAttack').inputs[0]?.name).toBe('epochId')
  })

  it('reads a lobby config the chain encoded, with no missing fields', () => {
    const config = roundTrip<ChainLobbyConfig>(outputOf('getLobby', 1), 10)
    const params = roundTrip<ChainGameParams>(outputOf('getLobby', 2), 40)

    const mapped = toLobbyConfig(config, params)
    expectNoHoles(mapped)

    // The three the adapter used to read off the config, which no longer
    // carries any of them.
    expect(mapped.drones.freeCount).toBe(params.freeProbes)
    expect(mapped.drones.maxCount).toBe(params.maxProbesPerPlayer)
    expect(Number.isFinite(mapped.drones.price)).toBe(true)
  })

  it('reads a participant the chain encoded, with no missing fields', () => {
    const participant = roundTrip<ChainParticipant>(outputOf('getParticipant', 0), 70)
    const params = roundTrip<ChainGameParams>(outputOf('getLobby', 2), 40)

    const mapped = toParticipant(
      '0xlobby' as Hash,
      '0x1111111111111111111111111111111111111111' as Address,
      participant,
      params,
      false,
      true,
    )
    expectNoHoles(mapped)
    expect(mapped.freeDronesRemaining).toBeGreaterThanOrEqual(0)
  })

  it('reads a lobby the chain encoded, with no missing fields', () => {
    const lobby = roundTrip<ChainLobby>(outputOf('getLobby', 0), 100)
    const config = roundTrip<ChainLobbyConfig>(outputOf('getLobby', 1), 10)
    const params = roundTrip<ChainGameParams>(outputOf('getLobby', 2), 40)

    const mapped = toLobby(lobby, config, params, [], null, null)
    // `outcome` and `reveal` are legitimately null before a reveal, so they
    // are checked apart from the rest.
    expectNoHoles({ ...mapped, outcome: 0, reveal: 0 })
    expect(mapped.creator).toBe(lobby.creator)
  })

  /**
   * The params struct is where a rename is most expensive: every one of
   * these is a number the protocol prices or judges something with, and a
   * hole in any of them reaches the chain as `undefined` wei or a comparison
   * against `NaN`.
   */
  it('names every protocol parameter the way the chain does', () => {
    const params = roundTrip<ChainGameParams>(outputOf('getParams', 0), 40)

    for (const key of [
      'gridColumns',
      'gridRows',
      'sectorSpanKm',
      'interceptRadiusMilliSectors',
      'epochBlocks',
      'defenseSpeedKmPerBlock',
      'probeConeMicroRad',
      'revealGraceBlocks',
      'minPlayers',
      'maxPlayers',
      'maxProbesPerPlayer',
      'freeProbes',
      'maxCreatorFeeBps',
      'minRegistrationSeconds',
      'maxRegistrationSeconds',
      'minEntryFee',
      'maxEntryFee',
      'minStartPrizePool',
      'probePrice',
      'protocolJoinFee',
    ] satisfies Array<keyof ChainGameParams>) {
      expect(params[key], `params.${key}`).toBeDefined()
    }
  })
})
