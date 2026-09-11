#!/usr/bin/env node
/**
 * Turns deployment manifests into the frontend's contract configuration
 * (ТЗ §9, §14).
 *
 * This is the step that makes "never hand-edit an address" true rather than
 * aspirational. Everything the UI needs to talk to a deployment — proxy
 * address, chain id, deployment block, explorer, version, and the merged
 * ABI — is generated from `deployments/*.json` into
 * `frontend/src/contracts/generated/`, and that directory is the *only* place in the
 * frontend where a contract address exists.
 *
 * Every network that has ever been deployed is written out, keyed by chain
 * id, and the frontend picks one at runtime from its configured chain. So a
 * build can be pointed at Base Sepolia or at a local node by changing an env
 * var, with no code change and no second copy of an address to keep in step.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEPLOYMENTS_DIR, GENERATED_DIR, artifact, log, mergeAbis, ok, readManifest, writeJson } from './lib.mjs'

/**
 * One ABI for the one address a client talks to: the game's own functions
 * plus the read functions its lens facet answers, merged, because from
 * outside the proxy they are the same contract.
 *
 * The rule libraries are merged in for their errors alone. They are external
 * libraries, so a revert from `validateConfig` reaches the client as a
 * selector the game's own ABI cannot name — and `InvalidConfig("entryPrice")`
 * is only useful if the field survives decoding.
 */
export function buildAbi() {
  return mergeAbis(artifact('AegylaxGame').abi, artifact('AegylaxLens').abi, errorsOf('ProtocolRules'), errorsOf('Resolution'), errorsOf('Scoring'))
}

/** Just the error entries of a library, for decoding reverts it raises. */
function errorsOf(name) {
  return artifact(name).abi.filter((entry) => entry.type === 'error')
}

/** Every network with a manifest on disk. */
export function listDeployedChains() {
  if (!existsSync(DEPLOYMENTS_DIR)) return []
  return readdirSync(DEPLOYMENTS_DIR)
    .filter((file) => /^\d+\.json$/.test(file))
    .map((file) => Number(file.replace('.json', '')))
    .sort((a, b) => a - b)
}

function toDeployment(manifest) {
  return {
    name: manifest.name,
    network: manifest.network,
    chainId: manifest.chainId,
    version: manifest.version,
    proxy: manifest.proxy,
    implementation: manifest.implementation,
    lens: manifest.lens,
    confidentialEngine: manifest.confidentialEngine,
    deploymentBlock: manifest.deploymentBlock,
    genesisBlock: manifest.genesisBlock ?? manifest.deploymentBlock,
    explorerUrl: manifest.explorer?.url ?? '',
    rpcUrl: manifest.rpcUrl ?? '',
    deployedAt: manifest.deployedAt,
    /*
     * The protocol parameters `initialize()` actually wrote into contract
     * storage.
     *
     * They travel with the address for the same reason the address is
     * generated rather than typed: the frontend has its own copy of every
     * limit in ENV, and two copies of a number drift. A form built from a
     * `.env` that says 9999 players against a contract that says 20 offers a
     * creator a configuration the chain will reject, and one built from an
     * epoch length of 150 against a chain running 120 shows every countdown
     * a quarter too long. Shipping them here makes the deployment the single
     * authority and leaves ENV as what it is documented to be — a fallback
     * for builds with no deployment behind them.
     */
    params: manifest.params ?? null,
    /*
     * How often the protocol plays for its own pool, in epochs.
     *
     * Beside `params` rather than inside it because the contract keeps it
     * that way: `GameParams` is snapshotted onto every lobby and has no room
     * for a cadence that belongs to the protocol, so the interval has its own
     * slot and its own setter. Null when the manifest predates it being
     * recorded, which leaves the ENV value in place.
     */
    globalDefenseEpochInterval: manifest.globalDefenseEpochInterval ?? null,
  }
}

export function syncFrontend(chainId = null) {
  const chains = chainId ? [chainId] : listDeployedChains()

  // Existing generated deployments survive a sync of one network, so
  // deploying to a testnet never quietly drops the mainnet entry.
  const existingPath = join(GENERATED_DIR, 'deployments.json')
  let deployments = {}
  if (existsSync(existingPath)) {
    try {
      deployments = JSON.parse(readFileSync(existingPath, 'utf8'))
    } catch {
      deployments = {}
    }
  }

  for (const id of chains) {
    const manifest = readManifest(id)
    if (!manifest) throw new Error(`No manifest for chain ${id}. Deploy first.`)
    deployments[String(id)] = toDeployment(manifest)
  }

  mkdirSync(GENERATED_DIR, { recursive: true })
  writeJson(existingPath, deployments)
  writeJson(join(GENERATED_DIR, 'abi.json'), buildAbi())
  writeFileSync(join(GENERATED_DIR, 'index.ts'), indexModule())

  for (const id of chains) ok(`chain ${id} -> ${deployments[String(id)].proxy}`)
  return deployments
}

function indexModule() {
  return `/**
 * GENERATED FILE — do not edit.
 *
 * Written by \`npm run chain:deploy\` / \`npm run chain:upgrade\` from the
 * manifests in deployments/. Editing it by hand would put the frontend's
 * idea of the contract out of step with the chain's, which is exactly the
 * failure this file exists to make impossible.
 */

import abi from './abi.json'
import deployments from './deployments.json'

export interface GeneratedDeployment {
  name: string
  network: string
  chainId: number
  version: string
  proxy: \`0x\${string}\`
  implementation: \`0x\${string}\`
  lens: \`0x\${string}\`
  confidentialEngine: {
    /**
     * Which confidential stack this deployment runs — \`fhenix-cofhe\`,
     * \`inco-lightning\`, \`mock\`. The client's gateway registry is keyed by
     * it and refuses a kind it has no implementation for.
     */
    kind: string
    address: \`0x\${string}\`
    contract: string | null
    /**
     * Which deployment of that stack — Inco's pepper, CoFHE's environment.
     * The client SDK resolves its services from this, so a value that
     * disagrees with what the engine was wired to produces handles nothing
     * can open.
     */
    release?: string | null
    /** What Inco deployments recorded before the field was named for the thing. */
    pepper?: string | null
    /**
     * The confidential network's own contract on this chain, recorded at
     * deploy time. \`address\` above is this protocol's adapter; this one is
     * theirs, and it is what the privacy claim actually rests on.
     */
    executor?: \`0x\${string}\` | null
    /**
     * Service endpoints an operator running their own confidential
     * infrastructure has overridden. Absent means the release's hosted
     * defaults.
     */
    services?: Record<string, string> | null
    /**
     * The confidential network's session-verifier contract, when the operator
     * has recorded one.
     *
     * With it, a player signs one session voucher and every Recon Probe after
     * that is a single transaction; without it each confidential read costs
     * its own wallet signature. Absent by default because the address belongs
     * to the confidential network's own deployment, not to ours — set
     * VITE_CONFIDENTIAL_SESSION_VERIFIER to supply it without a redeploy.
     */
    sessionVerifier?: \`0x\${string}\` | null
  }
  deploymentBlock: number
  /**
   * The contract's epoch-grid origin (\`genesisBlock()\`), pinned at
   * initialize. Distinct from \`deploymentBlock\` after an upgrade.
   */
  genesisBlock: number
  explorerUrl: string
  rpcUrl: string
  deployedAt: string
  /**
   * The protocol parameters this deployment's \`initialize()\` wrote into
   * contract storage — decimal strings, in the contract's own units (wei for
   * money, seconds for windows, basis points for the creator fee,
   * thousandths of a sector for the interception radius).
   *
   * \`config/env.ts\` derives the app's protocol limits from these whenever a
   * deployment is configured, so the UI cannot offer a creator something the
   * chain will refuse. Null for a manifest written before params were
   * recorded.
   */
  params: GeneratedParams | null
  /**
   * How often the protocol opens its own Global Defense draw, in epochs.
   *
   * Beside \`params\` rather than inside them because the contract keeps it
   * that way: \`GameParams\` is snapshotted onto every lobby and has no room
   * for a cadence that belongs to the protocol, so this has its own storage
   * slot and its own setter. Null on a manifest written before it was
   * recorded, which leaves the ENV value standing.
   */
  globalDefenseEpochInterval?: number | null
}

export interface GeneratedParams {
  gridColumns: string
  gridRows: string
  sectorSpanKm: string
  interceptRadiusMilliSectors: string
  epochBlocks: string
  defenseSpeedKmPerBlock: string
  probeConeMicroRad: string
  revealGraceBlocks: string
  minPlayers: string
  maxPlayers: string
  /** Recon Probes one player may send per attack — protocol-owned. */
  maxProbesPerPlayer: string
  /** Recon Probes every player starts an attack with. */
  freeProbes: string
  maxCreatorFeeBps: string
  minRegistrationSeconds: string
  maxRegistrationSeconds: string
  /** wei */
  minEntryFee: string
  /** wei */
  maxEntryFee: string
  /** wei */
  minStartPrizePool: string
  /** wei — the price of one Recon Probe, set by the protocol, not the creator. */
  probePrice: string
  /** wei */
  protocolJoinFee: string
}

/** Every network this repository has a deployment manifest for, by chain id. */
export const AEGYLAX_DEPLOYMENTS = deployments as unknown as Record<string, GeneratedDeployment>

/** The merged game + lens ABI. One address answers all of it. */
export const AEGYLAX_ABI = abi

export function getGeneratedDeployment(chainId: number | null): GeneratedDeployment | null {
  if (chainId === null) return null
  return AEGYLAX_DEPLOYMENTS[String(chainId)] ?? null
}
`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const explicit = process.argv[2] ? Number(process.argv[2]) : null
  const chains = explicit ? [explicit] : listDeployedChains()
  if (chains.length === 0) {
    console.error('No deployment manifests in deployments/. Run "npm run chain:deploy" first.')
    process.exit(1)
  }
  log('sync', `${chains.length} network(s)`)
  syncFrontend(explicit)
}
