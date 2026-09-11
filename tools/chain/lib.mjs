/**
 * Shared plumbing for the chain pipeline.
 *
 * Everything the deployment scripts need that is not a step in itself:
 * reading configuration out of the environment, reading Foundry's build
 * artifacts, linking external libraries into bytecode, and reading/writing
 * the deployment manifest.
 *
 * One rule runs through all of it: **no network value is written down in
 * source**. Chain id, RPC, explorer, keys and every game parameter come out
 * of the environment; addresses come out of the manifest that a deployment
 * produced. Pointing the protocol at a different network is an .env change
 * and a re-run, never an edit (ТЗ §8).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEther, encodeFunctionData } from 'viem'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const CONTRACTS_DIR = join(ROOT, 'contracts')
export const OUT_DIR = join(CONTRACTS_DIR, 'out')
export const DEPLOYMENTS_DIR = join(ROOT, 'deployments')
export const GENERATED_DIR = join(ROOT, 'frontend/src/contracts/generated')

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * Loads `.env` files without adding a dependency, later files winning.
 *
 * `contracts/.env` holds the deployment side (keys, RPC, protocol
 * parameters) and stays out of the frontend's `.env`, which only ever needs
 * to know which network to read. Real process env still wins over both, so
 * CI can inject secrets without a file.
 */
export function loadEnv(files = [join(CONTRACTS_DIR, '.env'), join(ROOT, '.env')]) {
  const env = {}
  for (const file of files) {
    if (!existsSync(file)) continue
    for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq === -1) continue
      const key = line.slice(0, eq).trim()
      let value = line.slice(eq + 1).trim()
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
      if (!(key in env)) env[key] = value
    }
  }
  return { ...env, ...process.env }
}

/**
 * Accepted spellings for the few variables that have a conventional name
 * of their own in Foundry/Hardhat projects.
 *
 * A key pasted into `.env` as `PRIVATE_KEY` should work without being
 * renamed to match this pipeline's vocabulary; the canonical name is still
 * what the scripts ask for, and it wins when both are present.
 */
const ALIASES = {
  DEPLOYER_PRIVATE_KEY: ['PRIVATE_KEY', 'TEST_CREATOR_PK'],
  RPC_URL: ['BASE_SEPOLIA_RPC', 'BASE_RPC', 'ETH_RPC_URL'],
  ETHERSCAN_API_KEY: ['BASESCAN_API_KEY'],
}

function lookup(env, key) {
  if (env[key] !== undefined && env[key] !== '') return env[key]
  for (const alias of ALIASES[key] ?? []) {
    if (env[alias] !== undefined && env[alias] !== '') return env[alias]
  }
  return undefined
}

export function required(env, key) {
  const value = lookup(env, key)
  if (value === undefined || value === '') {
    const alternatives = ALIASES[key]?.length ? ` (or ${ALIASES[key].join(' / ')})` : ''
    throw new Error(
      `Missing required environment variable ${key}${alternatives} — set it in contracts/.env, see contracts/.env.example`,
    )
  }
  return value
}

export function optional(env, key, fallback) {
  const value = lookup(env, key)
  return value === undefined || value === '' ? fallback : value
}

export function num(env, key, fallback) {
  const value = optional(env, key, fallback)
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${key} must be a number, got "${value}"`)
  return parsed
}

export function eth(env, key, fallback) {
  return parseEther(String(optional(env, key, fallback)))
}

/**
 * The protocol's own rules, read from the environment.
 *
 * They are passed to `initialize` and then live *on chain*: the frontend
 * reads them back with `getParams()` rather than keeping its own copy, so a
 * build of the UI cannot disagree with the contract about what the game's
 * rules are (ТЗ §8).
 */
export function readGameParams(env) {
  return {
    gridColumns: num(env, 'GAME_GRID_COLUMNS', 10),
    gridRows: num(env, 'GAME_GRID_ROWS', 5),
    sectorSpanKm: num(env, 'GAME_SECTOR_SPAN_KM', 1000),
    interceptRadiusMilliSectors: num(env, 'GAME_INTERCEPT_RADIUS_MILLI_SECTORS', 140),
    epochBlocks: num(env, 'GAME_EPOCH_BLOCKS', 150),
    defenseSpeedKmPerBlock: num(env, 'GAME_DEFENSE_SPEED_KM_PER_BLOCK', 250),
    probeConeMicroRad: num(env, 'GAME_PROBE_CONE_MICRO_RAD', 174533),
    revealGraceBlocks: num(env, 'GAME_REVEAL_GRACE_BLOCKS', 5000),
    minPlayers: num(env, 'GAME_MIN_PLAYERS', 2),
    maxPlayers: num(env, 'GAME_MAX_PLAYERS', 9999),
    // Recon is protocol-owned now: one price and one allowance for the
    // epoch's one threat, because knowledge of it is worth the same in every
    // operation playing that epoch.
    maxProbesPerPlayer: num(env, 'GAME_MAX_PROBES_PER_PLAYER', 6),
    freeProbes: num(env, 'GAME_FREE_PROBES', 3),
    maxCreatorFeeBps: num(env, 'GAME_MAX_CREATOR_FEE_BPS', 1500),
    minRegistrationSeconds: num(env, 'GAME_MIN_REGISTRATION_SECONDS', 0),
    maxRegistrationSeconds: num(env, 'GAME_MAX_REGISTRATION_SECONDS', 2592000),
    minEntryFee: eth(env, 'GAME_MIN_ENTRY_FEE_ETH', '0.0005'),
    maxEntryFee: eth(env, 'GAME_MAX_ENTRY_FEE_ETH', '0.1'),
    minStartPrizePool: eth(env, 'GAME_MIN_START_PRIZE_POOL_ETH', '0.001'),
    probePrice: eth(env, 'GAME_PROBE_PRICE_ETH', '0.0002'),
    protocolJoinFee: eth(env, 'GAME_PROTOCOL_JOIN_FEE_ETH', '0.0005'),
  }
}

/**
 * A read that tolerates a load-balanced RPC.
 *
 * Public endpoints sit behind several nodes, and a call issued immediately
 * after a receipt can land on one that has not caught up yet — it answers
 * "0x" for a contract that demonstrably exists, or the old value for a slot
 * that was just written. Retrying briefly is the difference between a
 * pipeline that works against a public RPC and one that only works against
 * a private node.
 *
 * It lives here rather than in `deploy.mjs`, where it was written, because
 * every tool that reads back what it just sent needs it: `chain:params`
 * verified a setter against a lagging node, called a successful write a
 * failure, and aborted before it could record what it had done.
 */
export async function readWithRetry(read, { attempts = 8, delayMs = 2000, label = 'read', accept = () => true } = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const value = await read()
      // A lagging node answers *successfully* with stale state, so "did it
      // throw" is the wrong question — the caller says what a good answer
      // looks like, and anything else is another wait.
      if (accept(value)) return value
      lastError = new Error(`unexpected value ${String(value)}`)
    } catch (error) {
      lastError = error
    }
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastError?.message ?? lastError}`)
}

/**
 * How often the Global Defense Pool is played for, in epochs.
 *
 * Read separately from the params struct because it is *not* one of them:
 * `GameParams` is snapshotted onto every lobby and packed inline in contract
 * storage, and the draw cadence is neither a rule an operation is played
 * under nor a field that struct has room for. It has its own storage slot and
 * its own setter — see `AegylaxStorage`.
 */
export function readGlobalDefenseInterval(env) {
  return num(env, 'GAME_GLOBAL_DEFENSE_EPOCH_INTERVAL', 1000)
}

/** The tuple order `GameTypes.GameParams` is encoded in. */
export const GAME_PARAMS_ORDER = [
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
]

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export function artifact(contractName, fileName = `${contractName}.sol`) {
  const path = join(OUT_DIR, fileName, `${contractName}.json`)
  if (!existsSync(path)) {
    throw new Error(`Artifact not found: ${path}. Run "npm run chain:build" first.`)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function latestBuildInfoDir() {
  const dir = join(OUT_DIR, 'build-info')
  if (!existsSync(dir) || readdirSync(dir).length === 0) {
    throw new Error('No build-info found. Foundry must be configured with build_info = true.')
  }
  return dir
}

/**
 * Fills a compiled artifact's library placeholders with real addresses.
 *
 * Three pieces of the protocol are deployed as their own contracts —
 * geometry, the configuration rules and the resolution loop — because the
 * game implementation would otherwise exceed the EVM's code size limit.
 * That makes linking a step of every deployment rather than a detail, so it
 * happens here and is recorded in the manifest.
 */
export function linkBytecode(artifactJson, libraries) {
  let bytecode = artifactJson.bytecode.object
  const references = artifactJson.bytecode.linkReferences ?? {}
  const linked = {}

  for (const [file, entries] of Object.entries(references)) {
    for (const [name, positions] of Object.entries(entries)) {
      const address = libraries[name]
      if (!address) throw new Error(`No address supplied for library ${name} (from ${file})`)
      linked[name] = address
      const clean = address.toLowerCase().replace(/^0x/, '')
      for (const { start, length } of positions) {
        // Positions are byte offsets into the bytecode, hex is two chars per byte.
        const from = 2 + start * 2
        const to = from + length * 2
        bytecode = bytecode.slice(0, from) + clean + bytecode.slice(to)
      }
    }
  }

  if (bytecode.includes('__$')) throw new Error('Bytecode still contains unlinked library placeholders')
  return { bytecode, linked }
}

export function hasLinkReferences(artifactJson) {
  return Object.keys(artifactJson.bytecode.linkReferences ?? {}).length > 0
}

// ---------------------------------------------------------------------------
// ABI
// ---------------------------------------------------------------------------

/**
 * One ABI for one address.
 *
 * A caller talks to the proxy, which answers with the game's functions and
 * — through its lens facet — the read functions too. Merging the two ABIs
 * is what makes that one deployed address usable as one contract, and doing
 * it here means the frontend never has to know the split exists.
 */
export function mergeAbis(...abis) {
  const seen = new Set()
  const merged = []
  for (const abi of abis) {
    for (const entry of abi) {
      const key = `${entry.type}:${entry.name ?? ''}:${(entry.inputs ?? []).map((i) => i.type).join(',')}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(entry)
    }
  }
  return merged
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export function manifestPath(chainId) {
  return join(DEPLOYMENTS_DIR, `${chainId}.json`)
}

export function layoutPath(chainId) {
  return join(DEPLOYMENTS_DIR, `${chainId}.storage-layout.json`)
}

export function readManifest(chainId) {
  const path = manifestPath(chainId)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function writeManifest(chainId, manifest) {
  mkdirSync(DEPLOYMENTS_DIR, { recursive: true })
  writeFileSync(manifestPath(chainId), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifestPath(chainId)
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  return path
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export function initializeCalldata(abi, { owner, engine, params, genesisBlock }) {
  return encodeFunctionData({
    abi,
    functionName: 'initialize',
    args: [owner, engine, GAME_PARAMS_ORDER.reduce((acc, key) => ({ ...acc, [key]: params[key] }), {}), BigInt(genesisBlock)],
  })
}

export function log(step, message) {
  console.log(`\x1b[36m[${step}]\x1b[0m ${message}`)
}

export function ok(message) {
  console.log(`\x1b[32m  ✓\x1b[0m ${message}`)
}

export function warn(message) {
  console.log(`\x1b[33m  !\x1b[0m ${message}`)
}
