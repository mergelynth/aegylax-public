import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * Everything the backend needs, resolved once and validated loudly.
 *
 * This is the only process in the system that runs unattended and holds
 * keys, so it refuses to start on a configuration it cannot honour rather
 * than discovering the gap on the first request. Nothing here has a default
 * that would let a misconfigured deploy look healthy: a faucet that boots
 * without a key and refuses forever is indistinguishable, from the outside,
 * from a faucet that is merely busy.
 *
 * The two absences it *does* tolerate are a missing faucet key and a missing
 * keeper key, because a backend with only one of them is still useful and
 * making each hostage to the other would be worse. Both are stated at
 * startup and each disabled feature says so in its own answer.
 */

/**
 * The repository root, from wherever this file ended up.
 *
 * Compiled output lives at `dist-server/api/<module>/`, so three levels
 * up is the root in the build and — because `api/<module>/` is two — this
 * is only ever correct for the built tree. That is the only tree that runs:
 * the backend is always started from `dist-server`.
 *
 * It is exported because the keeper needs it for the same reason, and a
 * second copy computed from a different file's depth is exactly how the
 * confidential client came to be looked for inside `dist-server/tools`.
 */
export const ROOT = join(__dirname, '..', '..', '..')

export interface AppConfig {
  port: number
  chain: {
    id: number
    rpcUrl: string
    contract: `0x${string}`
    network: string
    manifest: Record<string, any>
    abi: unknown[]
  }
  cors: {
    origins: string[]
    previewPattern: RegExp | null
  }
  faucet: {
    enabled: boolean
    privateKey: `0x${string}` | null
    address: `0x${string}` | null
    /** How much one drip pays out, in wei. */
    dripWei: bigint
    cooldownMs: number
    explorerApiKey: string | null
  }
  keeper: {
    enabled: boolean
    privateKey: `0x${string}` | null
    address: `0x${string}` | null
    /**
     * The longest the keeper will ever sleep — the idle cap, not the cadence.
     *
     * The sweep schedules its own next wake-up from the deadlines it just
     * read, so this only bounds how long it may go without looking at all
     * when there is nothing on the clock.
     */
    sweepMs: number
    /** How soon to come back when work was due but did not complete. */
    retryMs: number
    /**
     * How long one sweep may keep asking the confidential network for the
     * plaintexts before giving up and leaving it to the next one.
     *
     * The quorum learns about `unlockRound` by watching the chain, so "not
     * processed yet" is the normal answer for the first few seconds after
     * the unlock is mined. Waiting inside the sweep is what turns unlock and
     * reveal into one pass instead of two.
     */
    attestMs: number
    reveal: boolean
  }
  indexer: {
    enabled: boolean
    /** The first block worth reading — the deployment's own, unless overridden. */
    fromBlock: bigint
    /** How many blocks one `eth_getLogs` may cover; public RPCs cap this. */
    windowBlocks: bigint
    /** How far behind the head to stop, so a reorg is never folded in. */
    confirmations: bigint
    pollMs: number
  }
}

function read(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key]?.trim()
    if (value) return value
  }
  return undefined
}

function readPrivateKey(...keys: string[]): `0x${string}` | null {
  const value = read(...keys)
  if (!value) return null
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${keys[0]} is not a 32-byte hex private key`)
  }
  return value as `0x${string}`
}

/**
 * Who may call this backend from a browser.
 *
 * An allowlist rather than `*`, because the faucet spends real (test) money
 * on request and `*` invites every page on the internet to spend it. Local
 * development origins are always included: the alternative is every
 * developer meeting CORS by hand on their first afternoon.
 */
const CORS_DEV_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]

/**
 * How much one drip pays out.
 *
 * Configured, not derived. It used to be twice the contract's own
 * `minEntryFee`, which tracked `setParams` for free and was wrong for the
 * job: joining is not the most expensive thing a newcomer does. Creating an
 * operation costs `startPrizePool + protocolJoinFee`, and twice the entry
 * fee did not cover it — so a wallet we had just funded got
 * `IncorrectPayment` on the first button it pressed.
 *
 * The number is now a decision rather than a consequence, which means it can
 * also go stale. `FaucetService` reads the contract at startup and says so
 * when the configured drip cannot pay for a join or a create, so a drip that
 * stops being enough is stated instead of discovered by a player.
 */
function readDripWei(): bigint {
  const value = read('FAUCET_DRIP_ETH') ?? '0.02'
  let wei: bigint
  try {
    wei = parseEther(value)
  } catch {
    throw new Error(`FAUCET_DRIP_ETH is not an amount in ETH: ${value}`)
  }
  if (wei <= 0n) throw new Error('FAUCET_DRIP_ETH must be greater than zero')
  return wei
}

/**
 * Vercel gives every preview deployment a different hostname, so a demo
 * whose previews must work cannot list them. This matches the project's own
 * preview hosts and nothing else — a bare `*.vercel.app` would let any
 * Vercel user's page call this faucet.
 */
function previewPattern(): RegExp | null {
  const project = read('CORS_VERCEL_PROJECT')
  if (!project) return null
  return new RegExp(`^https://${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[a-z0-9-]+\\.vercel\\.app$`)
}

export function loadConfig(): AppConfig {
  const chainId = Number(read('CHAIN_ID', 'VITE_CHAIN_ID') ?? NaN)
  if (!Number.isFinite(chainId) || chainId <= 0) {
    throw new Error('CHAIN_ID (or VITE_CHAIN_ID) must name the chain this backend serves')
  }

  const deployments = JSON.parse(
    readFileSync(join(ROOT, 'frontend/src/contracts/generated/deployments.json'), 'utf8'),
  ) as Record<string, any>
  const manifest = deployments[String(chainId)]
  if (!manifest) throw new Error(`No deployment recorded for chain ${chainId} — deploy before starting the backend`)

  const rpcUrl = read('RPC_URL', 'VITE_RPC_URL') ?? manifest.rpcUrl
  if (!rpcUrl) throw new Error('RPC_URL (or VITE_RPC_URL) must be set')

  const faucetKey = readPrivateKey('FAUCET_EVM_PRIVATE_KEY', 'FAUCET_PRIVATE_KEY')
  const keeperKey = readPrivateKey('KEEPER_PRIVATE_KEY', 'DEPLOYER_PRIVATE_KEY')

  const configured = (read('CORS_ORIGINS') ?? '')
    .split(',')
    .map((entry) => entry.trim().replace(/\/$/, ''))
    .filter(Boolean)

  return {
    port: Number(read('PORT') ?? 8787),
    chain: {
      id: chainId,
      rpcUrl: rpcUrl.split(',')[0].trim(),
      contract: (read('VITE_CONTRACT_ADDRESS') ?? manifest.proxy) as `0x${string}`,
      network: manifest.network,
      manifest,
      abi: JSON.parse(readFileSync(join(ROOT, 'frontend/src/contracts/generated/abi.json'), 'utf8')),
    },
    cors: {
      origins: [...new Set([...configured, ...CORS_DEV_ORIGINS])],
      previewPattern: previewPattern(),
    },
    faucet: {
      enabled: read('FAUCET_ENABLED') !== 'false',
      privateKey: faucetKey,
      address: faucetKey ? privateKeyToAccount(faucetKey).address : null,
      dripWei: readDripWei(),
      cooldownMs: Number(read('FAUCET_COOLDOWN_HOURS') ?? 24) * 3_600_000,
      explorerApiKey: read('EXPLORER_API_KEY', 'BASESCAN_API_KEY', 'ETHERSCAN_API_KEY') ?? null,
    },
    keeper: {
      enabled: read('KEEPER_ENABLED') !== 'false',
      privateKey: keeperKey,
      address: keeperKey ? privateKeyToAccount(keeperKey).address : null,
      sweepMs: Number(read('KEEPER_SWEEP_SECONDS') ?? 30) * 1000,
      retryMs: Number(read('KEEPER_RETRY_SECONDS') ?? 5) * 1000,
      attestMs: Number(read('KEEPER_ATTEST_SECONDS') ?? 12) * 1000,
      reveal: read('KEEPER_REVEAL') !== 'false',
    },
    indexer: {
      enabled: read('INDEXER_ENABLED') !== 'false',
      /*
       * The deployment's own block, not zero and not the head.
       *
       * Zero would ask a public RPC for four million empty windows before
       * reaching anything this contract ever emitted; the head would answer
       * every player's record with "nothing yet" until they played again.
       * The manifest already records where this deployment starts, and it is
       * the only number that makes the first sweep both complete and cheap.
       */
      fromBlock: BigInt(read('INDEXER_FROM_BLOCK') ?? manifest.deploymentBlock ?? manifest.genesisBlock ?? 0),
      windowBlocks: BigInt(read('INDEXER_LOG_WINDOW') ?? 9000),
      confirmations: BigInt(read('INDEXER_CONFIRMATIONS') ?? 5),
      pollMs: Number(read('INDEXER_POLL_SECONDS') ?? 20) * 1000,
    },
  }
}

/** Things a running server should carry as a warning rather than crash on. */
export function configWarnings(config: AppConfig): string[] {
  const warnings: string[] = []
  if (config.faucet.enabled && !config.faucet.privateKey) {
    warnings.push('FAUCET_EVM_PRIVATE_KEY is not set — the faucet will refuse every request')
  }
  if (config.keeper.enabled && !config.keeper.privateKey) {
    warnings.push('KEEPER_PRIVATE_KEY is not set — the keeper will not run')
  }
  if (config.faucet.enabled && !config.faucet.explorerApiKey) {
    warnings.push('EXPLORER_API_KEY is not set — the faucet cooldown falls back to the public rate limit')
  }
  if (config.cors.origins.length === CORS_DEV_ORIGINS.length && !config.cors.previewPattern) {
    warnings.push('CORS_ORIGINS is not set — only local development origins may call this backend')
  }
  if (config.faucet.privateKey && config.faucet.privateKey === config.keeper.privateKey) {
    warnings.push('the faucet and the keeper share one key — a drained faucet also stops the keeper')
  }
  /*
   * The one misconfiguration that is silent and total.
   *
   * `KEEPER_PRIVATE_KEY` falls back to `DEPLOYER_PRIVATE_KEY`, which is the
   * owner's, and locally `contracts/.env` supplies that fallback without
   * anybody choosing it. The sweep then works perfectly — and this process
   * signs unattended, so a compromise of it is a compromise of the protocol
   * rather than of a gas wallet. Same for the faucet, which additionally
   * spends on request from any origin the CORS list lets through.
   */
  const owner = String(config.chain.manifest?.owner ?? '').toLowerCase()
  if (owner) {
    if (config.keeper.address?.toLowerCase() === owner) {
      warnings.push(
        'the keeper is signing with the CONTRACT OWNER key — set KEEPER_PRIVATE_KEY to a wallet that owns nothing',
      )
    }
    if (config.faucet.address?.toLowerCase() === owner) {
      warnings.push(
        'the faucet is signing with the CONTRACT OWNER key — set FAUCET_EVM_PRIVATE_KEY to a wallet that owns nothing',
      )
    }
  }
  return warnings
}

export const CONFIG = Symbol('AEGYLAX_CONFIG')
