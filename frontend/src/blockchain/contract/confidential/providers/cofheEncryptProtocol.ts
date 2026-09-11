import type { Address } from '../../../../game/types'

/**
 * The wire between the tab and the encryption worker.
 *
 * It is deliberately tiny and free of `@cofhe/sdk`: the whole reason the
 * worker exists is that importing that SDK costs a TFHE WASM module, and a
 * shared protocol module that pulled it in would put that cost back on the
 * main thread on the very first import.
 *
 * Measured on the CoFHE testnet, one encryption of a Defense Point costs
 * roughly:
 *
 *   fetch keys  ~0.5s   even from cache — the SDK re-validates the FHE key
 *                       and the CRS by deserialising them on every call
 *   pack        ~0s
 *   prove       ~3.5s   the ZK proof, single-threaded WASM
 *   verify      ~1.0s   a round trip to the network's verifier
 *
 * Five seconds, and before this worker existed the first three ran on the
 * thread painting the game — which is why placing a Defense Point froze the
 * board and pressing Defend sat silent before the wallet appeared.
 */

export interface CofheWorkerChain {
  id: number
  name: string
  network: string
  coFheUrl: string
  verifierUrl: string
  thresholdNetworkUrl: string
  environment: 'MAINNET' | 'TESTNET' | 'MOCK'
}

/** Boot the SDK and connect it. Sent once, before anybody encrypts. */
export interface CofheWarmUpRequest {
  kind: 'warmUp'
  id: number
  chain: CofheWorkerChain
  account: Address
  rpcUrls: readonly string[]
}

export interface CofheEncryptRequest {
  kind: 'encrypt'
  id: number
  chain: CofheWorkerChain
  account: Address
  rpcUrls: readonly string[]
  consumingContract: Address
  securityZone: number
  /** The packed value, as a decimal string: `postMessage` cannot carry a bigint. */
  value: string
}

export type CofheWorkerRequest = CofheWarmUpRequest | CofheEncryptRequest

export interface CofheWorkerSuccess {
  id: number
  ok: true
  /** Hex, from the SDK. Empty for a warm-up, which produces no ciphertext. */
  ctHash: string
  signature: string
}

export interface CofheWorkerFailure {
  id: number
  ok: false
  error: string
}

export type CofheWorkerResponse = CofheWorkerSuccess | CofheWorkerFailure
