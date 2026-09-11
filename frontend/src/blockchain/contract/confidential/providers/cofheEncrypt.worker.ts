/// <reference lib="webworker" />
import { Encryptable } from '@cofhe/sdk'
import type { CofheClient } from '@cofhe/sdk'
import type { CofheChain } from '@cofhe/sdk/chains'
import { createCofheClient, createCofheConfig } from '@cofhe/sdk/web'
import { createPublicClient, createWalletClient, custom, fallback, http, type Chain } from 'viem'
import type { CofheWorkerRequest, CofheWorkerResponse } from './cofheEncryptProtocol'

/**
 * Every expensive thing CoFHE does, on a thread that paints nothing.
 *
 * A Defense Point costs about five seconds to encrypt — a WASM proof, two
 * WASM deserialisations of key material, and a round trip to the network's
 * verifier (see `cofheEncryptProtocol`). The SDK offloads only the proof,
 * and only if its own nested worker starts; the deserialisations are on
 * whatever thread called it. In a tab that meant the board froze while a
 * threat was in flight, which is the one moment in this game where a
 * dropped frame is the whole product.
 *
 * So the tab does not call the SDK at all. It posts a value here and gets a
 * ciphertext back, and the worst that can happen on the main thread is a
 * `postMessage`.
 *
 * Nothing secret leaves this file that was not going to leave it anyway:
 * the plaintext arrives over `postMessage` inside the same origin, and what
 * comes back is the ciphertext the transaction was always going to carry.
 * The wallet is never involved — encryption is proved against the player's
 * *address*, not against a signature — which is why a worker with no
 * signer can do this at all.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope

interface Session {
  key: string
  client: Promise<CofheClient>
}

let session: Session | null = null

/**
 * The FHE public key and CRS, cached where a worker can actually reach them.
 *
 * `@cofhe/sdk/web` defaults to a cross-origin iframe for this
 * (`iframe-shared-storage`), which needs a DOM, so in a worker it is not an
 * option — and in a tab it is a third-party frame in the path of every
 * encryption, with its own multi-second timeouts. IndexedDB is available
 * here directly and the data is ours: two public blobs, a few megabytes,
 * that would otherwise be re-downloaded on every reload.
 */
const KEY_STORE_DB = 'aegylax-cofhe-keys'
const KEY_STORE_TABLE = 'keys'

function openKeyStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(KEY_STORE_DB, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(KEY_STORE_TABLE)) {
        request.result.createObjectStore(KEY_STORE_TABLE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'))
  })
}

function withKeyStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openKeyStore().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(KEY_STORE_TABLE, mode)
        const request = run(tx.objectStore(KEY_STORE_TABLE))
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
      }),
  )
}

/*
 * Key caching is an optimisation, never a precondition: a browser with
 * IndexedDB disabled re-downloads the keys and is slow, rather than being
 * unable to defend at all.
 */
const keyStorage = {
  getItem: async (name: string) => {
    try {
      return (await withKeyStore<unknown>('readonly', (store) => store.get(name))) ?? null
    } catch {
      return null
    }
  },
  setItem: async (name: string, value: unknown) => {
    try {
      await withKeyStore('readwrite', (store) => store.put(value, name))
    } catch {
      // Cache miss next time, which is slow rather than broken.
    }
  },
  removeItem: async (name: string) => {
    try {
      await withKeyStore('readwrite', (store) => store.delete(name))
    } catch {
      // As above.
    }
  },
}

function viemChain(chain: CofheWorkerRequest['chain'], rpcUrls: readonly string[]): Chain {
  return {
    id: chain.id,
    name: chain.name,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [...rpcUrls] } },
  }
}

/**
 * The client, one per wallet and chain.
 *
 * `connect` reads two things — the chain id off the public client and the
 * address off the wallet client — and the encryption path uses neither
 * afterwards: a ZK input is bound to an address, and proving it asks the
 * wallet for nothing. The wallet client here is therefore a real viem
 * client over a transport that refuses every request, which is the honest
 * shape of that invariant: if a future SDK ever did try to sign during
 * encryption, this would fail loudly here instead of silently opening a
 * prompt from a worker.
 */
function connect(request: CofheWorkerRequest): Promise<CofheClient> {
  const key = `${request.chain.id}:${request.account.toLowerCase()}`
  if (session?.key === key) return session.client

  const rpcUrls = request.rpcUrls.filter((url) => url.startsWith('https://'))
  const chain = viemChain(request.chain, rpcUrls)

  const client = (async () => {
    const cofhe = createCofheClient(
      createCofheConfig({
        supportedChains: [request.chain as CofheChain],
        fheKeyStorage: keyStorage,
        // The proof already runs off the main thread — this *is* the off-main
        // thread. A nested worker would only add a second TFHE instance and
        // its memory to the same machine.
        useWorkers: false,
      }),
    )
    const publicClient = createPublicClient({
      chain,
      transport: rpcUrls.length > 0 ? fallback(rpcUrls.map((url) => http(url))) : http(),
    })
    const walletClient = createWalletClient({
      account: request.account,
      chain,
      transport: custom({
        request: async () => {
          throw new Error('The encryption worker has no wallet and needs none.')
        },
      }),
    })
    await cofhe.connect(publicClient, walletClient)
    return cofhe
  })()

  session = { key, client }
  // A failed connect must not become the cached answer for this wallet: the
  // next Defense would inherit a rejection with no attempt of its own.
  client.catch(() => {
    if (session?.key === key) session = null
  })
  return client
}

scope.onmessage = async (event: MessageEvent<CofheWorkerRequest>) => {
  const request = event.data
  const reply = (response: CofheWorkerResponse) => scope.postMessage(response)

  try {
    const client = await connect(request)
    if (request.kind === 'warmUp') {
      reply({ id: request.id, ok: true, ctHash: '', signature: '' })
      return
    }

    const [ctHash, signature] = await client
      .encryptInputs([Encryptable.uint128(BigInt(request.value))])
      .setAccount(request.account)
      .setChainId(request.chain.id)
      .setSecurityZone(request.securityZone)
      .setConsumingContract(request.consumingContract)
      .execute()

    reply({ id: request.id, ok: true, ctHash: String(ctHash), signature: String(signature) })
  } catch (error) {
    reply({ id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
