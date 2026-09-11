import type { Address } from '../../../../game/types'
import type { CofheWorkerChain, CofheWorkerRequest, CofheWorkerResponse } from './cofheEncryptProtocol'

/**
 * The tab's handle on the encryption worker.
 *
 * One worker for the session, one message per Defense Point. The tab never
 * imports `@cofhe/sdk`: that import carries a TFHE WASM module and its
 * first use costs seconds of blocking work, which is the whole reason this
 * file talks over `postMessage` instead of calling a function.
 *
 * Workers are treated as an optimisation rather than a requirement. A
 * browser without them, and the test environment, get `null` from
 * `createWorkerEncryptor` and the gateway encrypts in the tab as it always
 * did — slowly, but correctly.
 */

/**
 * The worker itself is gone — not "this encryption failed".
 *
 * The difference decides whether the tab keeps using the worker. A verifier
 * that 500s once is a bad minute for one Defense Point; a worker that died
 * is a session that has to fall back to encrypting in the tab, freezes and
 * all, or stop being able to defend.
 */
export class CofheWorkerLost extends Error {}

export interface CofheCiphertext {
  ctHash: bigint
  signature: `0x${string}`
}

export interface CofheEncryptor {
  /** Boot the SDK and connect it, so the first real point does not pay for it. */
  warmUp(account: Address): Promise<void>
  encrypt(input: {
    value: bigint
    account: Address
    consumingContract: Address
    securityZone: number
  }): Promise<CofheCiphertext>
  dispose(): void
}

export function workersAvailable(): boolean {
  return typeof Worker !== 'undefined' && typeof indexedDB !== 'undefined'
}

/**
 * A handle on the worker, or `null` when this browser has none.
 *
 * `null` is not a failure: the gateway reads it as "encrypt in the tab",
 * which is slower and correct, and is what every build did before this
 * file existed.
 *
 * Note what is *not* here. This used to wrap the constructor in a
 * try/catch, on the reasoning that a browser which cannot start a worker
 * should still be able to defend. The reasoning is right and the guard was
 * dead: the worker is spawned lazily, on the first point rather than here,
 * so nothing this function calls can throw. A page that never defends
 * never pays for a worker, and that is worth keeping — so the guard moved
 * to where the spawn actually happens.
 */
export function createWorkerEncryptor(chain: CofheWorkerChain, rpcUrls: readonly string[]): CofheEncryptor | null {
  return workersAvailable() ? new WorkerEncryptor(chain, rpcUrls) : null
}

class WorkerEncryptor implements CofheEncryptor {
  private worker: Worker | null = null
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: CofheCiphertext) => void; reject: (error: Error) => void }>()

  constructor(
    private readonly chain: CofheWorkerChain,
    private readonly rpcUrls: readonly string[],
  ) {}

  async warmUp(account: Address): Promise<void> {
    await this.send({ kind: 'warmUp', id: 0, chain: this.chain, account, rpcUrls: [...this.rpcUrls] })
  }

  async encrypt(input: {
    value: bigint
    account: Address
    consumingContract: Address
    securityZone: number
  }): Promise<CofheCiphertext> {
    return this.send({
      kind: 'encrypt',
      id: 0,
      chain: this.chain,
      account: input.account,
      rpcUrls: [...this.rpcUrls],
      consumingContract: input.consumingContract,
      securityZone: input.securityZone,
      value: input.value.toString(),
    })
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
    this.rejectAll(new CofheWorkerLost('The encryption worker was shut down.'))
  }

  private send(request: CofheWorkerRequest): Promise<CofheCiphertext> {
    const worker = this.ensureWorker()
    const id = this.nextId++
    return new Promise<CofheCiphertext>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({ ...request, id })
    })
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    /*
     * `new URL(..., import.meta.url)` is the form bundlers recognise: Vite
     * compiles the worker as its own module graph and rewrites this to the
     * built asset. A bare path would resolve against the page at runtime and
     * 404 in production.
     */
    let worker: Worker
    try {
      worker = new Worker(new URL('./cofheEncrypt.worker.ts', import.meta.url), { type: 'module' })
    } catch (error) {
      /*
       * A Content-Security-Policy that forbids workers, or an environment
       * that has the constructor and refuses to run it, fails here and
       * nowhere earlier. `CofheWorkerLost` is the type the gateway already
       * treats as "stop using the worker": it drops the encryptor and
       * encrypts in the tab, so the browser gets a slow Defense rather than
       * no Defense, and does not pay the failure again on the next point.
       */
      throw new CofheWorkerLost(`The encryption worker could not start: ${(error as Error)?.message ?? error}`)
    }
    worker.onmessage = (event: MessageEvent<CofheWorkerResponse>) => {
      const response = event.data
      const waiting = this.pending.get(response.id)
      if (!waiting) return
      this.pending.delete(response.id)
      if (response.ok) waiting.resolve({ ctHash: BigInt(response.ctHash || '0'), signature: response.signature as `0x${string}` })
      else waiting.reject(new Error(response.error))
    }
    /*
     * A worker that dies takes every in-flight proof with it, and a Defense
     * waiting on one would otherwise hang until the attack landed. Failing
     * the pending calls lets the gateway fall back to encrypting in the tab.
     */
    worker.onerror = () => {
      this.worker = null
      worker.terminate()
      this.rejectAll(new CofheWorkerLost('The encryption worker stopped.'))
    }
    this.worker = worker
    return worker
  }

  private rejectAll(error: Error): void {
    for (const waiting of this.pending.values()) waiting.reject(error)
    this.pending.clear()
  }
}
