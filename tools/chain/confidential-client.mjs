/**
 * The confidential layer, as the command-line tools need it.
 *
 * `chain:reveal` and `chain:e2e` do off chain exactly what a browser does:
 * seal a Defense Point, open a probe answer that belongs to one wallet, and
 * fetch the plaintexts a landed attack unlocked. Those three operations are
 * the whole of `ConfidentialGateway` on the frontend, and this is the same
 * boundary for Node — so that "which confidential network is this?" stays a
 * field of the manifest here too, rather than a `require('@inco/js')` in the
 * middle of a script.
 *
 * Every method waits. The confidential network learns that a handle exists,
 * or that it has been unlocked, by watching the host chain, so "not
 * processed yet" is a correct answer for a few seconds after any of these
 * transactions — the patience is the protocol working as designed, not a
 * workaround, and it belongs in any client that reveals.
 */

import { createRequire } from 'node:module'
import { log } from './lib.mjs'

const require = createRequire(import.meta.url)

/** `euint128` — the encrypted width every handle in this protocol carries. */
const FHE_UINT128 = 6

const TASK_MANAGER_ABI = [
  {
    type: 'function',
    name: 'getDecryptResultSafe',
    stateMutability: 'view',
    inputs: [{ name: 'ctHash', type: 'uint256' }],
    outputs: [
      { name: 'result', type: 'uint256' },
      { name: 'decrypted', type: 'bool' },
    ],
  },
]

const ENGINE_ADDRESS_ABI = (name) => [
  { type: 'function', name, stateMutability: 'pure', inputs: [], outputs: [{ name: '', type: 'address' }] },
]

const PEEK_ABI = [
  {
    type: 'function',
    name: 'unsafePeek',
    stateMutability: 'view',
    inputs: [{ name: 'handle', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
]

/**
 * Connects to whichever confidential network this deployment runs.
 *
 * The manifest's `kind` decides, and an unrecognised one is a refusal
 * rather than a default — a script that quietly picked a provider would
 * encrypt against the wrong network and fail somewhere unrelated.
 */
export async function connectConfidential({ manifest, chainId, rpcUrl, publicClient }) {
  const engine = manifest.confidentialEngine
  const kind = engine?.kind
  const release = engine?.release ?? engine?.pepper ?? null

  if (kind === 'fhenix-cofhe') return fhenixClient({ engine, release, chainId, publicClient })
  if (kind === 'inco-lightning') return incoClient({ engine, release, chainId, rpcUrl })
  if (kind === 'mock') return mockClient({ engine, publicClient })

  throw new Error(
    `Unknown confidential engine "${kind ?? '(unset)'}" in the manifest for chain ${chainId}. ` +
      'Known kinds: fhenix-cofhe, inco-lightning, mock.',
  )
}

// ---------------------------------------------------------------------------
// Fhenix CoFHE
// ---------------------------------------------------------------------------

async function fhenixClient({ engine, release, chainId, publicClient }) {
  if (!release) {
    throw new Error('The manifest records no CoFHE environment (confidentialEngine.release) — redeploy or resync.')
  }
  const { createCofheClient, createCofheConfig } = await import('@cofhe/sdk/node')
  const { Encryptable, FheTypes } = await import('@cofhe/sdk')

  const taskManager =
    engine.executor ??
    (await publicClient.readContract({
      address: engine.address,
      abi: ENGINE_ADDRESS_ABI('cofheTaskManager'),
      functionName: 'cofheTaskManager',
    }))

  /*
   * One chain entry, assembled from the manifest exactly as the browser
   * gateway does it (`FhenixGateway.cofheChain`). `LOCAL` is this project's
   * word and not the SDK's — a self-hosted stack is a TESTNET pointed at
   * localhost — so the same translation happens here.
   */
  const services = { ...(engine.services ?? {}), ...(COFHE_SERVICES[release] ?? {}) }
  const chain = {
    id: chainId,
    name: `chain ${chainId}`,
    network: `chain-${chainId}`,
    coFheUrl: engine.services?.coFheUrl ?? services.coFheUrl,
    verifierUrl: engine.services?.verifierUrl ?? services.verifierUrl,
    thresholdNetworkUrl: engine.services?.thresholdNetworkUrl ?? services.thresholdNetworkUrl,
    environment: release === 'LOCAL' ? 'TESTNET' : release,
  }

  /**
   * A client per wallet, rather than one re-connected per call.
   *
   * The old SDK was a singleton scoped to one wallet, so a script acting for
   * several players had to re-initialise between them; this one is an
   * object, so each player gets their own and the ACPs stay where they
   * belong. The FHE keys are cached on disk by the SDK, so the second client
   * costs a connect and nothing else.
   */
  const clients = new Map()
  const clientFor = async (walletClient) => {
    const [address] = await walletClient.getAddresses()
    const existing = clients.get(address)
    if (existing) return { client: existing, address }

    const client = createCofheClient(createCofheConfig({ supportedChains: [chain] }))
    try {
      await client.connect(publicClient, walletClient)
    } catch (error) {
      throw new Error(`Could not reach the "${release}" CoFHE deployment: ${error.message}`)
    }
    // One signature per player, here rather than lazily inside a retry loop:
    // a script has nobody to prompt twice.
    await client.acp.getOrCreateSelfACP(chainId, address)
    clients.set(address, client)
    return { client, address }
  }

  return {
    kind: 'fhenix-cofhe',
    label: `Fhenix CoFHE "${release}"`,
    provider: `TaskManager ${taskManager}`,

    /**
     * Pull the FHE key and CRS before they are on the critical path.
     *
     * `@cofhe/sdk` fetches them at the *first* `encryptInputs` rather than
     * at connect, which is the right default — a page that never encrypts
     * never pays for a four-megabyte CRS. It is the wrong shape for a run
     * with a deadline: a Defense Point may only be submitted between launch
     * and impact, and spending the first ten seconds of that window on a
     * download is how a defender misses a window they had time for.
     *
     * The warm-up is a throwaway encryption, because that is the only call
     * that pulls everything — TFHE init, keys, CRS, and the prover's own
     * first-run cost. It sends nothing and signs nothing on chain.
     */
    async warmUp(walletClient) {
      const { client, address } = await clientFor(walletClient)
      await client
        .encryptInputs([Encryptable.uint128(0n)])
        .setAccount(address)
        .setChainId(chainId)
        .setSecurityZone(SECURITY_ZONE)
        .setConsumingContract(engine.address)
        .execute()
    },

    async encrypt(value, walletClient) {
      const { client, address } = await clientFor(walletClient)
      /*
       * The consuming contract is the *engine*: it is what calls
       * `batchVerifyInputs`, and the verifier binds that address into the
       * signature. The account is the player, because the engine checks the
       * proof against them rather than against its own caller — which is
       * what keeps submitting a Defense Point one transaction.
       */
      const [ctHash, signature] = await client
        .encryptInputs([Encryptable.uint128(value)])
        .setAccount(address)
        .setChainId(chainId)
        .setSecurityZone(SECURITY_ZONE)
        .setConsumingContract(engine.address)
        .execute()
      // The ABI shape `FhenixConfidentialEngine.newEncryptedPoint` decodes.
      return encodeInput({ ctHash, securityZone: SECURITY_ZONE, utype: FHE_UINT128, signature })
    },

    async decryptForOwner(walletClient, handle, { attempts = 10, delayMs = 5000 } = {}) {
      const { client, address } = await clientFor(walletClient)
      return withPatience(
        async () =>
          client
            .decryptForView(BigInt(handle), FheTypes.Uint128)
            .setAccount(address)
            .setChainId(chainId)
            .withACP()
            /*
             * The SDK polls the threshold network itself, and this says how
             * hard. Worth having in the log: a read that looks like one call
             * from here can be a long internal wait, and stacking our own
             * retries on top of it multiplies a delay rather than surviving
             * one. First poll and every fifth, so a slow ripen is visible
             * without the log becoming the output.
             */
            .onPoll((ctx) => {
              if (ctx.attemptIndex === 0 || ctx.attemptIndex % 5 === 0) {
                log(
                  'confidential',
                  `poll ${ctx.operation} #${ctx.attemptIndex} — ${(ctx.elapsedMs / 1000).toFixed(0)}s elapsed, ` +
                    `every ${(ctx.intervalMs / 1000).toFixed(0)}s, gives up at ${(ctx.timeoutMs / 1000).toFixed(0)}s`,
                )
              }
            })
            .execute(),
        `open handle ${handle}`,
        { attempts, delayMs },
      )
    },

    /**
     * The permissionless path, and it really is permissionless: after
     * `unlockForReveal` the handles are globally decryptable, and the
     * threshold network hands the plaintext to anybody who asks — no wallet,
     * no permit, no SDK. That is what makes a reveal something a stranger
     * can finish.
     *
     * Two routes, and the on-chain one is tried first only because it needs
     * nothing to be reachable. Measured against Base Sepolia, CoFHE does
     * *not* publish decryptions to the TaskManager on its own, so in
     * practice the second route is the one that answers; the first is there
     * for a deployment where something else has already published.
     */
    async fetchAttested(handles, { attempts = 20, delayMs = 6000 } = {}) {
      return withPatience(
        async () =>
          Promise.all(
            handles.map(async (handle) => {
              const [value, decrypted] = await publicClient.readContract({
                address: taskManager,
                abi: TASK_MANAGER_ABI,
                functionName: 'getDecryptResultSafe',
                args: [BigInt(handle)],
              })
              if (decrypted) return { value, signatures: [] }
              return askThresholdNetwork(release, chainId, handle)
            }),
          ),
        `fetch ${handles.length} plaintexts`,
        { attempts, delayMs },
      )
    },
  }
}

function encodeInput(item) {
  const { encodeAbiParameters, parseAbiParameters } = require('viem')
  return encodeAbiParameters(parseAbiParameters('uint256, uint8, uint8, bytes'), [
    BigInt(item.ctHash),
    Number(item.securityZone),
    Number(item.utype),
    item.signature,
  ])
}

/**
 * The plaintext and the quorum's signature over it, straight from the
 * threshold network.
 *
 * `verifyDecryption` hands that signature back to CoFHE's own verifier, so
 * nothing here parses it — except for the recovery byte, which has to be
 * moved into the range `ECDSA.recover` accepts. See `normaliseRecoveryId`
 * in the browser gateway: the network signs with `v` of 0 or 1 and Solidity
 * takes only 27 or 28, so an untouched signature fails every reveal.
 */
async function askThresholdNetwork(release, chainId, handle) {
  const url = COFHE_THRESHOLD_URLS[release]
  if (!url) throw new Error(`No CoFHE threshold network known for "${release}"`)

  const response = await fetch(`${url}/decrypt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ct_tempkey: BigInt(handle).toString(16).padStart(64, '0'),
      host_chain_id: Number(chainId),
    }),
  })
  if (!response.ok) throw new Error(`threshold network answered ${response.status} for ${handle}`)

  const body = await response.json()
  if (body.error_message) throw new Error(`threshold network: ${body.error_message}`)
  if (!Array.isArray(body.decrypted)) throw new Error(`${handle} is not decrypted yet`)

  const value = body.decrypted.reduce((acc, byte) => (acc << 8n) | BigInt(byte & 0xff), 0n)
  return { value, signatures: [normaliseRecoveryId(body.signature)] }
}

/** `v` of 0/1 as the network sends it -> 27/28 as `ECDSA.recover` requires. */
export function normaliseRecoveryId(signature) {
  const hex = String(signature).startsWith('0x') ? String(signature) : `0x${signature}`
  if (hex.length !== 132) return hex
  const v = Number.parseInt(hex.slice(130), 16)
  if (v !== 0 && v !== 1) return hex
  return `${hex.slice(0, 130)}${(v + 27).toString(16).padStart(2, '0')}`
}

const COFHE_THRESHOLD_URLS = {
  MAINNET: 'https://mainnet-cofhe-tn.fhenix.zone',
  TESTNET: 'https://testnet-cofhe-tn.fhenix.zone',
  LOCAL: 'http://127.0.0.1:3000',
}

/**
 * The full endpoint set per environment, for the SDK's chain entry.
 *
 * The reveal path below needs only the threshold network and keeps its own
 * table above; the SDK wants all three or it will not build a chain.
 */
const COFHE_SERVICES = {
  MAINNET: {
    coFheUrl: 'https://mainnet-cofhe.fhenix.zone',
    verifierUrl: 'https://mainnet-cofhe-vrf.fhenix.zone',
    thresholdNetworkUrl: COFHE_THRESHOLD_URLS.MAINNET,
  },
  TESTNET: {
    coFheUrl: 'https://testnet-cofhe.fhenix.zone',
    verifierUrl: 'https://testnet-cofhe-vrf.fhenix.zone',
    thresholdNetworkUrl: COFHE_THRESHOLD_URLS.TESTNET,
  },
  LOCAL: {
    coFheUrl: 'http://127.0.0.1:8448',
    verifierUrl: 'http://127.0.0.1:3001',
    thresholdNetworkUrl: COFHE_THRESHOLD_URLS.LOCAL,
  },
}

/** One security zone, and it is encoded into the blob the engine verifies. */
const SECURITY_ZONE = 0

// ---------------------------------------------------------------------------
// Inco Lightning
// ---------------------------------------------------------------------------

async function incoClient({ engine, release, chainId, rpcUrl }) {
  const { Lightning } = require('@inco/js/lite')
  const pepper = release ?? 'testnet'
  const lightning = await Lightning.latest(pepper, chainId, { hostChainRpcUrls: [rpcUrl] })

  return {
    kind: 'inco-lightning',
    /** Nothing to pre-fetch: the SDK holds no key material of its own. */
    async warmUp() {},
    label: `Inco Lightning "${pepper}"`,
    provider: `executor ${lightning.executorAddress}`,

    async encrypt(value, walletClient) {
      const [address] = await walletClient.getAddresses()
      return lightning.encrypt(value, { accountAddress: address, dappAddress: engine.address })
    },

    async decryptForOwner(walletClient, handle, { attempts = 10, delayMs = 5000 } = {}) {
      return withPatience(
        async () => {
          const [attestation] = await lightning.attestedDecrypt(walletClient, [handle])
          return BigInt(attestation.plaintext.value)
        },
        `open handle ${handle}`,
        { attempts, delayMs },
      )
    },

    async fetchAttested(handles, { attempts = 20, delayMs = 6000 } = {}) {
      return withPatience(
        async () => {
          const attestations = await lightning.attestedReveal(handles)
          return attestations.map((attestation) => ({
            value: BigInt(attestation.plaintext.value),
            signatures: (attestation.covalidatorSignatures ?? []).map(toHex),
          }))
        },
        `fetch ${handles.length} plaintexts`,
        { attempts, delayMs },
      )
    },
  }
}

function toHex(signature) {
  return typeof signature === 'string'
    ? signature
    : `0x${Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

// ---------------------------------------------------------------------------
// Mock
// ---------------------------------------------------------------------------

function mockClient({ engine, publicClient }) {
  const peek = (handle) =>
    publicClient.readContract({ address: engine.address, abi: PEEK_ABI, functionName: 'unsafePeek', args: [handle] })

  return {
    kind: 'mock',
    /** Nothing to pre-fetch: the mock engine is plain storage. */
    async warmUp() {},
    label: 'Mock engine (no confidentiality)',
    provider: `storage at ${engine.address}`,

    async encrypt(value) {
      return `0x${value.toString(16).padStart(64, '0')}`
    },

    async decryptForOwner(_walletClient, handle) {
      return peek(handle)
    },

    async fetchAttested(handles) {
      const values = await Promise.all(handles.map(peek))
      return values.map((value) => ({ value, signatures: [] }))
    },
  }
}

// ---------------------------------------------------------------------------

/**
 * Retries the confidential network while it catches up with the chain.
 *
 * `delayMs` is the *ceiling* of an exponential backoff, not the wait between
 * every attempt — the same shape the browser gateway uses, and for the same
 * reason. The first miss is almost always "CoFHE has not ingested that
 * transaction yet", which resolves in a second or two; a flat five seconds
 * charged the worst case every time, and it showed up in the e2e budget as
 * five seconds of nothing on top of every probe read.
 */
const FIRST_RETRY_MS = 700

async function withPatience(action, what, { attempts, delayMs }) {
  let lastError
  let backoff = Math.min(FIRST_RETRY_MS, delayMs)
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await action()
    } catch (error) {
      lastError = error
      if (attempt < attempts) {
        log('confidential', `not ready yet — ${what} (${attempt}/${attempts}, retry in ${backoff}ms)`)
        await new Promise((resolve) => setTimeout(resolve, backoff))
        backoff = Math.min(backoff * 2, delayMs)
      }
    }
  }
  throw new Error(`Could not ${what}: ${lastError?.message ?? lastError}`)
}
