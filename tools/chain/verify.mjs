#!/usr/bin/env node
/**
 * `npm run chain:verify` — publishes source for everything a deployment put
 * on chain.
 *
 * It verifies every address in the manifest, not just the headline one: the
 * proxy, the implementation behind it, the read lens, the confidential
 * engine and the linked libraries. A player who follows an explorer link
 * should be able to read the code that decided their game.
 *
 * Verification is idempotent: an already-verified address is reported and
 * skipped rather than treated as a failure. `chain:deploy` and
 * `chain:upgrade` call this automatically when ETHERSCAN_API_KEY is set.
 */

import { execFileSync } from 'node:child_process'
import { encodeAbiParameters, parseAbiParameters } from 'viem'
import { CONTRACTS_DIR, loadEnv, log, num, ok, optional, readManifest, warn } from './lib.mjs'

export const LIBRARY_PATHS = {
  Geometry: 'src/libraries/Geometry.sol:Geometry',
  ProtocolRules: 'src/libraries/ProtocolRules.sol:ProtocolRules',
  Resolution: 'src/libraries/Resolution.sol:Resolution',
  Settlement: 'src/libraries/Settlement.sol:Settlement',
  Lobbies: 'src/libraries/Lobbies.sol:Lobbies',
  Scoring: 'src/libraries/Scoring.sol:Scoring',
}

const COMPILER = {
  version: '0.8.30',
  optimizerRuns: '100',
  evmVersion: 'cancun',
}

function explorerApiUrl(chainId, override) {
  if (override && /^https?:\/\//.test(override)) return override
  return `https://api.etherscan.io/v2/api?chainid=${chainId}`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extraLibrariesFor(path, libraries) {
  const take = (...names) => {
    const out = {}
    for (const name of names) {
      const key = LIBRARY_PATHS[name]
      if (key && libraries[key]) out[key] = libraries[key]
    }
    return Object.keys(out).length ? out : undefined
  }
  if (path.includes('Lobbies.sol')) return take('Geometry', 'Settlement')
  if (path.includes('Scoring.sol')) return take('Geometry', 'Resolution', 'Lobbies')
  if (path.includes('Resolution.sol')) return take('Geometry')
  if (path.includes('ProtocolRules.sol')) return take('Geometry')
  return undefined
}

function libraryPathFlags(manifest) {
  const out = {}
  for (const [name, address] of Object.entries(manifest.libraries ?? {})) {
    out[LIBRARY_PATHS[name] ?? name] = address
  }
  return out
}

function alreadyVerified(output) {
  return /already verified|already successfully verified/i.test(output)
}

function verify({ address, contract, chainId, apiKey, verifierUrl, constructorArgs, libraries }) {
  const args = [
    'verify-contract',
    address,
    contract,
    '--chain',
    String(chainId),
    '--verifier',
    'etherscan',
    '--verifier-url',
    explorerApiUrl(chainId, verifierUrl),
    '--watch',
    '--via-ir',
    '--evm-version',
    COMPILER.evmVersion,
    '--compiler-version',
    COMPILER.version,
    '--num-of-optimizations',
    COMPILER.optimizerRuns,
  ]
  if (apiKey) args.push('--etherscan-api-key', apiKey)
  if (constructorArgs) {
    args.push('--constructor-args', constructorArgs.startsWith('0x') ? constructorArgs.slice(2) : constructorArgs)
  }
  for (const [name, libAddress] of Object.entries(libraries ?? {})) {
    args.push('--libraries', `${name}:${libAddress}`)
  }

  try {
    const output = execFileSync('forge', args, {
      cwd: CONTRACTS_DIR,
      encoding: 'utf8',
      env: {
        ...process.env,
        VERIFIER_URL: explorerApiUrl(chainId, verifierUrl),
        ...(apiKey ? { ETHERSCAN_API_KEY: apiKey } : {}),
      },
    })
    if (output) process.stdout.write(output)
    ok(`${contract} @ ${address}`)
    return 'verified'
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`
    if (output) process.stderr.write(output)
    if (alreadyVerified(output) || alreadyVerified(error.message ?? '')) {
      ok(`${contract} @ ${address} — already verified`)
      return 'already'
    }
    warn(`${contract} @ ${address} — verification did not complete`)
    return 'failed'
  }
}

function canVerify(env) {
  const skip = optional(env, 'SKIP_VERIFY', 'false')
  if (['1', 'true', 'yes'].includes(String(skip).toLowerCase())) return false
  return Boolean(optional(env, 'ETHERSCAN_API_KEY', '') || optional(env, 'VERIFIER_URL', ''))
}

/**
 * Publish source for the deployment recorded in `deployments/<chainId>.json`.
 *
 * `waitMs` is for the explorer indexer right after a fresh deploy. Re-running
 * against an existing deployment can leave it at 0.
 */
export async function verifyDeployment({ waitMs = 0, env = loadEnv() } = {}) {
  const chainId = num(env, 'CHAIN_ID')
  const manifest = readManifest(chainId)
  if (!manifest) throw new Error(`No deployment manifest for chain ${chainId}.`)

  if (!canVerify(env)) {
    warn('Skipping verification — set ETHERSCAN_API_KEY (or VERIFIER_URL), or SKIP_VERIFY=true to silence this.')
    return { skipped: true, failed: 0 }
  }

  const apiKey = optional(env, 'ETHERSCAN_API_KEY', '')
  const verifierUrl = optional(env, 'VERIFIER_URL', '')
  const libraries = libraryPathFlags(manifest)

  if (waitMs > 0) {
    log('verify', `waiting ${Math.round(waitMs / 1000)}s for the explorer to index bytecode`)
    await sleep(waitMs)
  }

  log('verify', 'forge build (metadata must match on-chain bytecode)')
  execFileSync('forge', ['build'], { cwd: CONTRACTS_DIR, stdio: 'inherit' })

  const results = []

  log('verify', 'libraries')
  for (const [path, address] of Object.entries(libraries)) {
    const extra = extraLibrariesFor(path, libraries)
    results.push(verify({ address, contract: path, chainId, apiKey, verifierUrl, libraries: extra }))
    await sleep(4000)
  }

  log('verify', 'implementation + lens')
  results.push(
    verify({
      address: manifest.implementation,
      contract: 'src/AegylaxGame.sol:AegylaxGame',
      chainId,
      apiKey,
      verifierUrl,
      libraries,
    }),
  )
  await sleep(4000)
  results.push(
    verify({ address: manifest.lens, contract: 'src/AegylaxLens.sol:AegylaxLens', chainId, apiKey, verifierUrl }),
  )
  await sleep(4000)

  if (manifest.confidentialEngine?.contract) {
    log('verify', 'confidential engine')
    const engineOwner = manifest.owner
    results.push(
      verify({
        address: manifest.confidentialEngine.address,
        contract: `src/confidential/${manifest.confidentialEngine.contract}.sol:${manifest.confidentialEngine.contract}`,
        chainId,
        apiKey,
        verifierUrl,
        constructorArgs: encodeAbiParameters(parseAbiParameters('address'), [engineOwner]),
      }),
    )
    await sleep(4000)
  }

  log('verify', 'proxy')
  const initialImplementation = manifest.history?.[0]?.implementation ?? manifest.implementation
  results.push(
    verify({
      address: manifest.proxy,
      contract: 'node_modules/@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy',
      chainId,
      apiKey,
      verifierUrl,
      constructorArgs: encodeAbiParameters(parseAbiParameters('address, bytes'), [
        initialImplementation,
        manifest.initCalldata ?? '0x',
      ]),
    }),
  )

  const failed = results.filter((status) => status === 'failed').length
  if (failed > 0) {
    warn(`${failed} contract(s) did not verify — re-run npm run chain:verify`)
  } else {
    ok(`explorer: ${manifest.explorer?.url || '(no explorer configured)'}`)
  }
  return { skipped: false, failed }
}

async function main() {
  const env = loadEnv()
  const result = await verifyDeployment({ env, waitMs: 0 })
  if (result.failed > 0) process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\x1b[31m[failed]\x1b[0m ${error.message}`)
    process.exit(1)
  })
}
