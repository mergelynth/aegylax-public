#!/usr/bin/env node
/**
 * `npm run chain:params` — push the protocol's rules from `.env` on chain.
 *
 * That means the `GameParams` struct and the Global Defense draw cadence,
 * which is not in it: the struct is snapshotted onto every lobby and has no
 * room for a protocol-wide setting, so the interval has its own slot and its
 * own setter. Both are pushed here because both are the same kind of change.
 *
 * Game-critical parameters live in contract storage, not in a frontend
 * build, so changing one is a transaction rather than a redeploy: the
 * proxy, the implementation and every running operation stay exactly as
 * they are. New operations pick the new rules up, and operations already
 * being played keep the snapshot they were created under — which is what
 * makes this safe to run at any time.
 *
 * With `--dry-run` it only reports the difference.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, createWalletClient, getContract, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  GAME_PARAMS_ORDER,
  GENERATED_DIR,
  loadEnv,
  log,
  num,
  ok,
  readGameParams,
  readGlobalDefenseInterval,
  readManifest,
  readWithRetry,
  required,
  warn,
  writeManifest,
} from './lib.mjs'
import { syncFrontend } from './sync-frontend.mjs'

async function main() {
  const env = loadEnv()
  const chainId = num(env, 'CHAIN_ID')
  const rpcUrl = required(env, 'RPC_URL')
  const manifest = readManifest(chainId)
  if (!manifest) throw new Error(`No deployment on chain ${chainId}`)

  const abi = JSON.parse(readFileSync(join(GENERATED_DIR, 'abi.json'), 'utf8'))
  const chain = {
    id: chainId,
    name: manifest.network,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  }
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const account = privateKeyToAccount(required(env, 'DEPLOYER_PRIVATE_KEY'))
  const game = getContract({
    address: manifest.proxy,
    abi,
    client: createWalletClient({ account, chain, transport: http(rpcUrl) }),
  })

  const [current, version] = await publicClient.readContract({
    address: manifest.proxy,
    abi,
    functionName: 'getParams',
  })
  const next = readGameParams(env)

  const changes = GAME_PARAMS_ORDER.filter((key) => String(current[key]) !== String(next[key])).map(
    (key) => `${key}: ${current[key]} -> ${next[key]}`,
  )

  /*
   * The draw cadence is reconciled here too, and it is not one of the
   * params.
   *
   * `GameParams` is snapshotted onto every lobby and packed inline, so the
   * interval — which belongs to the protocol, not to an operation — has its
   * own storage slot and its own setter. Nothing was pushing it. It stayed
   * zero through four deployments, which is the value that disables the
   * draw, so `openGlobalDefense` did nothing on a keeper sending it every
   * thirty seconds while the pool went on filling with ETH there was no
   * draw to play for. It reverted nothing and logged nothing.
   *
   * It rides along with the params because it is the same kind of change —
   * a rule pushed from `.env` without a redeploy — and because a lever
   * nobody remembers to pull is how it came to be zero in the first place.
   */
  const [, currentInterval] = await publicClient.readContract({
    address: manifest.proxy,
    abi,
    functionName: 'getGlobalDefenseDraw',
  })
  const nextInterval = readGlobalDefenseInterval(env)
  const intervalChanged = Number(currentInterval) !== nextInterval

  if (changes.length === 0 && !intervalChanged) {
    ok(`chain already matches .env (params version ${version})`)
    // "The chain matches .env" is not the same claim as "the manifest
    // matches the chain", and the frontend reads the manifest. A run that
    // sent its transaction and then failed on a stale read left exactly
    // that gap, so the cheap reconcile happens whether or not anything
    // was sent.
    if (recordDrawInterval(manifest, chainId, Number(currentInterval))) ok('manifest updated')
    return
  }

  if (changes.length > 0) {
    log('params', `version ${version} -> ${Number(version) + 1}`)
    for (const change of changes) console.log(`    ${change}`)
  }
  if (intervalChanged) {
    log('draw', `global defense interval: ${currentInterval} -> ${nextInterval} epochs`)
    if (Number(currentInterval) === 0) {
      console.log('    (0 means the draw was disabled — openGlobalDefense has been doing nothing)')
    }
    if (nextInterval === 0) warn('    setting it to 0 disables the Global Defense draw')
  }

  if (process.argv.includes('--dry-run')) {
    warn('dry run — nothing sent')
    return
  }

  if (changes.length > 0) {
    const hash = await game.write.setParams([next])
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`setParams reverted (${hash})`)
    ok(`params applied — ${manifest.explorer?.url}/tx/${hash}`)
  }

  if (intervalChanged) {
    const hash = await game.write.setGlobalDefenseInterval([nextInterval])
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`setGlobalDefenseInterval reverted (${hash})`)

    /*
     * Read it back before recording it — through the retry, not straight.
     *
     * A setter that takes the transaction and leaves the slot alone is the
     * failure worth catching here. But a public RPC sits behind several
     * nodes, and the read that follows a receipt by milliseconds can land on
     * one that has not caught up: the first run of this check called a
     * successful write a failure and aborted before recording it.
     */
    const [nextEpoch, applied] = await readWithRetry(
      () =>
        publicClient.readContract({ address: manifest.proxy, abi, functionName: 'getGlobalDefenseDraw' }),
      { label: 'global defense interval', accept: (draw) => Number(draw[1]) === nextInterval },
    )
    ok(`global defense every ${applied} epochs — next draw at epoch ${nextEpoch}`)
    ok(`applied — ${manifest.explorer?.url}/tx/${hash}`)
  }

  // The manifest records what the protocol was configured with, so it has
  // to move with it.
  manifest.params = GAME_PARAMS_ORDER.reduce((acc, key) => ({ ...acc, [key]: String(next[key]) }), {})
  manifest.globalDefenseEpochInterval = nextInterval
  writeManifest(chainId, manifest)
  syncFrontend(chainId)
  ok('manifest updated')
}

/**
 * Put the chain's draw interval in the manifest if it is not there already.
 *
 * Returns whether anything was written, so a run with nothing else to do
 * stays quiet. The frontend reads this field to know which epoch to count
 * down to, and a manifest that predates the field leaves the ENV value
 * standing — which is right for an old deployment and wrong for this one.
 */
function recordDrawInterval(manifest, chainId, interval) {
  if (manifest.globalDefenseEpochInterval === interval) return false
  manifest.globalDefenseEpochInterval = interval
  writeManifest(chainId, manifest)
  syncFrontend(chainId)
  return true
}

main().catch((error) => {
  console.error(`\x1b[31m[params failed]\x1b[0m ${error.message}`)
  process.exit(1)
})
