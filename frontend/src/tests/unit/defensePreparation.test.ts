import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBlockchainClient } from '../../blockchain'
import type { ContractBlockchainClient } from '../../blockchain/contract/ContractBlockchainClient'
import { parseEnv } from '../../config/env'
import type { Address, DefensePoint } from '../../game/types'

/**
 * Pressing Defend used to start the encryption — a WASM proof plus a round
 * trip to the confidential network's verifier — and only then open the
 * wallet, which put several seconds of silence between the click and the
 * prompt while a threat was in flight. The point is encrypted when it is
 * placed instead, off the thread that paints the board; these are the
 * properties that make that safe.
 */

const PLAYER = '0x1111111111111111111111111111111111111111' as Address
const OTHER = '0x2222222222222222222222222222222222222222' as Address

function point(column: number, row: number): DefensePoint {
  return { sector: { column, row }, offsetX: 0.5, offsetY: 0.5 }
}

function buildEnv(): ImportMetaEnv {
  return {
    VITE_APP_NAME: 'AEGYLAX',
    VITE_APP_SUBTITLE: '',
    VITE_BLOCKCHAIN_MODE: 'contract',
    VITE_PRIVY_APP_ID: '',
    VITE_CHAIN_ID: '',
    VITE_RPC_URL: '',
    VITE_EXPLORER_URL: '',
    VITE_CONTRACT_ADDRESS: '',
    VITE_PROTOCOL_JOIN_FEE: '',
    VITE_CREATOR_FEE_PERCENT: '',
    VITE_DEFAULT_ENTRY_PRICE: '',
    VITE_EMULATOR_INITIAL_BLOCK: '1',
    VITE_EMULATOR_BLOCK_TIME_MS: '2000',
    VITE_ATTACK_EPOCH_BLOCKS: '',
    VITE_MAP_GRID_COLUMNS: '',
    VITE_MAP_GRID_ROWS: '',
  } as unknown as ImportMetaEnv
}

interface Harness {
  client: ContractBlockchainClient
  encrypt: ReturnType<typeof vi.fn>
}

/**
 * A contract client with the confidential gateway replaced by a counter.
 * Nothing here reaches a chain: every property under test is about how
 * often the client asks the gateway to encrypt, and for which point.
 */
function harness(encryptImpl?: (value: bigint) => Promise<`0x${string}`>): Harness {
  const client = createBlockchainClient(parseEnv(buildEnv())) as ContractBlockchainClient
  const encrypt = vi.fn(
    encryptImpl ?? ((value: bigint) => Promise.resolve(`0x${value.toString(16)}` as `0x${string}`)),
  )
  ;(client as unknown as { gateway: unknown }).gateway = { kind: 'test', encrypt }
  return { client, encrypt }
}

describe('preparing a Defense Point', () => {
  let bench: Harness

  beforeEach(() => {
    bench = harness()
  })

  it('encrypts the staged point once, however often the map re-primes it', async () => {
    await bench.client.prepareDefense(PLAYER, point(3, 2))
    await bench.client.prepareDefense(PLAYER, point(3, 2))

    expect(bench.encrypt).toHaveBeenCalledTimes(1)
  })

  it('re-encrypts when the marker moves', async () => {
    await bench.client.prepareDefense(PLAYER, point(3, 2))
    await bench.client.prepareDefense(PLAYER, point(4, 2))

    expect(bench.encrypt).toHaveBeenCalledTimes(2)
  })

  it('never hands one wallet the ciphertext another wallet prepared', async () => {
    await bench.client.prepareDefense(PLAYER, point(3, 2))
    await bench.client.prepareDefense(OTHER, point(3, 2))

    expect(bench.encrypt).toHaveBeenCalledTimes(2)
    expect(bench.encrypt.mock.calls.map((call) => call[1])).toEqual([PLAYER, OTHER])
  })

  it('swallows a failed preparation — the click that follows reports its own error', async () => {
    const failing = harness(() => Promise.reject(new Error('verifier unreachable')))

    await expect(failing.client.prepareDefense(PLAYER, point(3, 2))).resolves.toBeUndefined()
  })

  it('does not cache a failure: a preparation that failed is tried again', async () => {
    let attempts = 0
    const flaky = harness(() => {
      attempts += 1
      return attempts === 1 ? Promise.reject(new Error('verifier unreachable')) : Promise.resolve('0xok')
    })

    await flaky.client.prepareDefense(PLAYER, point(3, 2))
    await flaky.client.prepareDefense(PLAYER, point(3, 2))

    expect(flaky.encrypt).toHaveBeenCalledTimes(2)
  })
})

describe('preparing while a proof is already running', () => {
  /**
   * A proof is seconds of CPU and the worker takes them in order, so the
   * queue in front of the point a player actually sends has to stay empty.
   */
  function deferredHarness() {
    const gate: Array<(value: `0x${string}`) => void> = []
    const bench = harness(
      () =>
        new Promise<`0x${string}`>((resolve) => {
          gate.push(resolve)
        }),
    )
    return { ...bench, gate }
  }

  it('starts one encryption at a time', async () => {
    const { client, encrypt, gate } = deferredHarness()

    void client.prepareDefense(PLAYER, point(1, 1))
    void client.prepareDefense(PLAYER, point(2, 1))
    await Promise.resolve()

    expect(encrypt).toHaveBeenCalledTimes(1)
    expect(gate).toHaveLength(1)
  })

  it('runs the newest waiting point when the running one finishes, and drops the ones it overtook', async () => {
    const { client, encrypt, gate } = deferredHarness()

    void client.prepareDefense(PLAYER, point(1, 1))
    void client.prepareDefense(PLAYER, point(2, 1))
    void client.prepareDefense(PLAYER, point(3, 1))
    gate[0]('0xfirst')
    await vi.waitFor(() => expect(encrypt).toHaveBeenCalledTimes(2))

    // The second point was overtaken by the third and never encrypted.
    const packedValues = encrypt.mock.calls.map((call) => call[0])
    expect(packedValues).toHaveLength(2)
    expect(packedValues[1]).not.toBe(packedValues[0])
  })

  it('does not re-encrypt a point it already holds', async () => {
    const { client, encrypt, gate } = deferredHarness()

    void client.prepareDefense(PLAYER, point(1, 1))
    gate[0]('0xfirst')
    await vi.waitFor(() => expect(encrypt).toHaveBeenCalledTimes(1))
    await client.prepareDefense(PLAYER, point(1, 1))

    expect(encrypt).toHaveBeenCalledTimes(1)
  })
})

describe('submitting a prepared Defense Point', () => {
  /**
   * `send` and the read-back are stubbed: what is under test is that the
   * transaction is built from the blob the map already produced, so the
   * click costs a wallet prompt and nothing else.
   */
  function stubChain(client: ContractBlockchainClient): { args: () => unknown[] } {
    let sent: unknown[] = []
    const internals = client as unknown as {
      send: (...args: unknown[]) => Promise<unknown>
      readAttempts: () => Promise<unknown[]>
      rememberPoint: () => void
    }
    internals.send = (_lifecycle: unknown, _fn: unknown, args: unknown) => {
      sent = args as unknown[]
      return Promise.resolve({ hash: '0xtx' })
    }
    internals.readAttempts = () => Promise.resolve([])
    internals.rememberPoint = () => {}
    return { args: () => sent }
  }

  it('reuses the ciphertext the staged point already produced', async () => {
    const { client, encrypt } = harness()
    const chain = stubChain(client)
    const staged = point(3, 2)

    await client.prepareDefense(PLAYER, staged)
    await client.submitDefense(PLAYER, { lobbyId: '0xlobby', attackId: '0xattack', defensePoint: staged })

    expect(encrypt).toHaveBeenCalledTimes(1)
    expect(chain.args()[1]).toBe(await encrypt.mock.results[0].value)
  })

  it('encrypts the point it was given, not the one that was prepared', async () => {
    const { client, encrypt } = harness()
    stubChain(client)

    await client.prepareDefense(PLAYER, point(3, 2))
    await client.submitDefense(PLAYER, { lobbyId: '0xlobby', attackId: '0xattack', defensePoint: point(7, 1) })

    expect(encrypt).toHaveBeenCalledTimes(2)
  })

  it('spends the prepared blob: the next Defense encrypts its own', async () => {
    const { client, encrypt } = harness()
    stubChain(client)
    const staged = point(3, 2)

    await client.prepareDefense(PLAYER, staged)
    await client.submitDefense(PLAYER, { lobbyId: '0xlobby', attackId: '0xattack', defensePoint: staged })
    await client.submitDefense(PLAYER, { lobbyId: '0xlobby', attackId: '0xattack', defensePoint: staged })

    expect(encrypt).toHaveBeenCalledTimes(2)
  })
})
