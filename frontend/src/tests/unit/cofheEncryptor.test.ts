import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CofheWorkerLost,
  createWorkerEncryptor,
  workersAvailable,
} from '../../blockchain/contract/confidential/providers/cofheEncryptor'
import type { CofheWorkerChain, CofheWorkerRequest } from '../../blockchain/contract/confidential/providers/cofheEncryptProtocol'

/**
 * The tab's half of the encryption worker.
 *
 * Every Defense Point in the game goes through here, and none of it had a
 * test — the same shape as the keeper, which shipped three bugs in a row
 * that compiled, survived every idle pass, and failed the first time a real
 * round needed finishing. The worker's failure mode is worse still: it is
 * invisible until somebody defends, and by then the attack has landed.
 *
 * The worker itself is not exercised here. It imports `@cofhe/sdk` and a
 * five-megabyte WASM module, and what actually breaks is not the proving —
 * it is the wire: an answer arriving for a request nobody is waiting for,
 * a worker that dies with proofs in flight, a browser that has no workers
 * at all. That is all in this file and all testable with a stub.
 */

const CHAIN: CofheWorkerChain = {
  id: 84532,
  name: 'Base Sepolia',
  network: 'base-sepolia',
  coFheUrl: 'https://cofhe.example',
  verifierUrl: 'https://verifier.example',
  thresholdNetworkUrl: 'https://threshold.example',
  environment: 'TESTNET',
}

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const
const ENGINE = '0x2222222222222222222222222222222222222222' as const

/**
 * A worker that does nothing until the test tells it to answer.
 *
 * Deliberately not a fake CoFHE: what is under test is the correspondence
 * between a `postMessage` and the promise waiting for it, so the stub only
 * has to record what went out and let a test push something back.
 */
class StubWorker {
  static last: StubWorker | null = null
  static constructions = 0

  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  readonly sent: CofheWorkerRequest[] = []
  terminated = false

  constructor() {
    StubWorker.constructions += 1
    StubWorker.last = this
  }

  postMessage(request: CofheWorkerRequest): void {
    this.sent.push(request)
  }

  terminate(): void {
    this.terminated = true
  }

  /** Answer the request at `index` the way the real worker would. */
  reply(index: number, body: Record<string, unknown>): void {
    this.onmessage?.({ data: { id: this.sent[index].id, ...body } } as MessageEvent)
  }

  die(): void {
    this.onerror?.({})
  }
}

const encryptOnce = () => ({ value: 42n, account: ACCOUNT, consumingContract: ENGINE, securityZone: 0 })

beforeEach(() => {
  StubWorker.last = null
  StubWorker.constructions = 0
  vi.stubGlobal('Worker', StubWorker)
  vi.stubGlobal('indexedDB', {})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('worker availability', () => {
  /*
   * The gateway reads `null` as "encrypt in the tab". That path is slower
   * and correct, so a browser without workers plays the game; what must not
   * happen is a throw, which would take Defense with it.
   */
  it('reports no worker when the browser has none, and hands back null', () => {
    vi.unstubAllGlobals()
    expect(workersAvailable()).toBe(false)
    expect(createWorkerEncryptor(CHAIN, ['https://rpc.example'])).toBeNull()
  })

  it('reports none when workers exist but IndexedDB does not', () => {
    // The SDK caches its keys in IndexedDB. A worker that cannot reach one
    // would fetch and re-validate the FHE key on every single proof.
    vi.stubGlobal('indexedDB', undefined)
    expect(workersAvailable()).toBe(false)
  })

  /*
   * A CSP that forbids workers has the constructor and refuses to run it,
   * so nothing is known to be wrong until the first point is encrypted.
   * That failure has to arrive as `CofheWorkerLost` and not as some other
   * error, because that is the only type the gateway treats as "stop using
   * the worker" — anything else leaves it retrying a spawn that will never
   * succeed, once per Defense, forever.
   *
   * This is where a guard used to sit in `createWorkerEncryptor`, wrapping
   * a constructor that spawns nothing. It could not catch this.
   */
  it('turns a blocked spawn into the loss the gateway knows how to survive', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('blocked by policy')
        }
      },
    )
    const encryptor = createWorkerEncryptor(CHAIN, [])
    expect(encryptor).not.toBeNull()
    await expect(encryptor!.encrypt(encryptOnce())).rejects.toBeInstanceOf(CofheWorkerLost)
  })
})

describe('one worker, many points', () => {
  it('starts the worker on first use and keeps it for the session', async () => {
    const encryptor = createWorkerEncryptor(CHAIN, ['https://rpc.example'])!
    // Nothing is spawned by construction: a page that never defends never
    // pays for the worker.
    expect(StubWorker.constructions).toBe(0)

    void encryptor.warmUp(ACCOUNT)
    void encryptor.encrypt(encryptOnce())
    expect(StubWorker.constructions).toBe(1)
    expect(StubWorker.last!.sent.map((r) => r.kind)).toEqual(['warmUp', 'encrypt'])
  })

  it('carries the value as a decimal string, because postMessage cannot take a bigint', () => {
    const encryptor = createWorkerEncryptor(CHAIN, [])!
    void encryptor.encrypt({ ...encryptOnce(), value: 2n ** 100n })
    const sent = StubWorker.last!.sent[0]
    expect(sent.kind).toBe('encrypt')
    expect(sent.kind === 'encrypt' && sent.value).toBe((2n ** 100n).toString())
  })

  /*
   * Two points in flight at once is not hypothetical: the pre-seal starts
   * on its own when a marker settles, and a player who presses Defend
   * before it lands has two requests out on the same worker.
   */
  it('answers each request with its own reply, whatever order they come back in', async () => {
    const encryptor = createWorkerEncryptor(CHAIN, [])!
    const first = encryptor.encrypt({ ...encryptOnce(), value: 1n })
    const second = encryptor.encrypt({ ...encryptOnce(), value: 2n })

    StubWorker.last!.reply(1, { ok: true, ctHash: '0x22', signature: '0xbb' })
    StubWorker.last!.reply(0, { ok: true, ctHash: '0x11', signature: '0xaa' })

    await expect(first).resolves.toEqual({ ctHash: 0x11n, signature: '0xaa' })
    await expect(second).resolves.toEqual({ ctHash: 0x22n, signature: '0xbb' })
  })

  it('reports the worker\'s own error rather than a generic one', async () => {
    const encryptor = createWorkerEncryptor(CHAIN, [])!
    const pending = encryptor.encrypt(encryptOnce())
    StubWorker.last!.reply(0, { ok: false, error: 'verifier returned 500' })
    await expect(pending).rejects.toThrow('verifier returned 500')
  })

  /*
   * A stray reply must not throw. The worker is shared, and a message whose
   * id nobody is waiting for — a late answer after a dispose, a duplicate —
   * arrives on the same handler as every real one.
   */
  it('ignores an answer nobody is waiting for', () => {
    const encryptor = createWorkerEncryptor(CHAIN, [])!
    void encryptor.encrypt(encryptOnce())
    expect(() =>
      StubWorker.last!.onmessage?.({ data: { id: 9999, ok: true, ctHash: '0x1', signature: '0x2' } } as MessageEvent),
    ).not.toThrow()
  })
})

describe('when the worker dies', () => {
  /*
   * The reason `CofheWorkerLost` is its own type. A Defense waiting on a
   * proof from a worker that is gone would otherwise hang until the attack
   * landed — the player watches a button do nothing while the round ends.
   * Failing loudly is what lets the gateway drop to encrypting in the tab.
   */
  it('fails everything in flight instead of leaving it hanging', async () => {
    const encryptor = createWorkerEncryptor(CHAIN, [])!
    const first = encryptor.encrypt({ ...encryptOnce(), value: 1n })
    const second = encryptor.encrypt({ ...encryptOnce(), value: 2n })

    StubWorker.last!.die()

    await expect(first).rejects.toBeInstanceOf(CofheWorkerLost)
    await expect(second).rejects.toBeInstanceOf(CofheWorkerLost)
  })

  it('terminates the corpse and starts a fresh worker for the next point', async () => {
    const encryptor = createWorkerEncryptor(CHAIN, [])!
    void encryptor.encrypt(encryptOnce()).catch(() => {})
    const dead = StubWorker.last!
    dead.die()
    expect(dead.terminated).toBe(true)

    void encryptor.encrypt(encryptOnce())
    expect(StubWorker.constructions).toBe(2)
    expect(StubWorker.last).not.toBe(dead)
  })

  it('fails what is in flight when the tab disposes it', async () => {
    const encryptor = createWorkerEncryptor(CHAIN, [])!
    const pending = encryptor.encrypt(encryptOnce())
    encryptor.dispose()
    await expect(pending).rejects.toBeInstanceOf(CofheWorkerLost)
    expect(StubWorker.last!.terminated).toBe(true)
  })
})
