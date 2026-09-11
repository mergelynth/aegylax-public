#!/usr/bin/env node
/**
 * `npm run chain:reveal <lobbyId>` — finish a landed attack from outside.
 *
 * The reveal is permissionless by design, and this is what that is *for*:
 * an operation whose players have all closed their tabs is still finishable
 * by anybody, and that is the difference between "the winner is decided"
 * and "the winner is decided if the loser cooperates".
 *
 * It also carries the one piece of patience the flow needs. Unlocking
 * decryption is an on-chain transaction, but the covalidators learn about
 * it by watching the chain, so for a short while afterwards they correctly
 * answer "not processed yet". Retrying is not a workaround for that — it is
 * the protocol working as designed, and the same loop belongs in any client
 * that reveals.
 *
 * It is the manual lever, not the mechanism: the app and the backend keeper
 * both finish rounds on their own, and this is for the one that got stuck.
 * That is exactly why it rotted. It had drifted three renames behind the
 * contract — `completeAttack` for `unlockRound`, `revealAttack` for
 * `revealAndResolve`, and an attackId where `getDefenseAttempts` wants a
 * lobbyId — and nothing failed, because nothing runs this until something
 * else has already gone wrong.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, createWalletClient, getContract, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { GENERATED_DIR, loadEnv, log, num, ok, readManifest, required } from './lib.mjs'
import { connectConfidential } from './confidential-client.mjs'

/**
 * Nothing at module scope reads argv or opens a connection: `e2e.mjs`
 * imports the waiting logic below, and a module that acted on import would
 * make that impossible.
 */
function context() {
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
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) })
  const game = getContract({ address: manifest.proxy, abi, client: walletClient })

  return { env, chainId, rpcUrl, manifest, abi, publicClient, walletClient, game }
}

/**
 * Kept as named re-exports because `e2e.mjs` used to import them from here.
 *
 * They are now one method each on the provider-neutral client, which is
 * where the waiting lives; these forward so a caller that already has a
 * client does not need to know which provider answered.
 */
export async function fetchAttestedWithPatience(client, handles, options) {
  return client.fetchAttested(handles, options)
}

export async function decryptWithPatience(client, walletClient, handle, options) {
  return client.decryptForOwner(walletClient, handle, options)
}

async function main(lobbyId) {
  const { chainId, rpcUrl, manifest, abi, publicClient, game } = context()
  const read = (functionName, args = []) =>
    publicClient.readContract({ address: manifest.proxy, abi, functionName, args })

  const [lobby] = await read('getLobby', [lobbyId])
  if (lobby.status === 0) throw new Error(`No lobby ${lobbyId} on ${manifest.network}`)

  const [attack] = await read('getAttack', [lobby.attackId])
  const [alreadyRevealed] = await read('getTrajectory', [lobby.attackId])

  /*
   * The trajectory belongs to the epoch; the scoring belongs to each
   * operation. So a revealed attack can still have an operation nobody has
   * settled, and "already revealed" on its own is not a reason to stop.
   */
  const attempts = await read('getDefenseAttempts', [lobbyId])
  if (alreadyRevealed && attempts.every((attempt) => attempt.revealed)) {
    ok('already revealed and scored — nothing to do, and nobody needs to do it again')
    return
  }

  const currentBlock = await publicClient.getBlockNumber()
  if (currentBlock < attack.impactBlock) {
    throw new Error(`Attack has not landed yet: block ${currentBlock} of ${attack.impactBlock}`)
  }

  if (!attack.decryptionUnlocked) {
    log('reveal', 'unlocking the round first')
    const hash = await game.write.unlockRound([lobbyId])
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`unlockRound reverted (${hash})`)
    ok('unlockRound confirmed')
  }

  const handles = [
    attack.bearingHandle,
    attack.deltaHandle,
    attack.maskKeyHandle,
    ...attempts.map((entry) => entry.maskedHandle),
  ]

  const confidential = await connectConfidential({ manifest, chainId, rpcUrl, publicClient })
  log('reveal', `asking ${confidential.label} for ${handles.length} plaintexts`)

  const [bearing, delta, mask, ...defenses] = await confidential.fetchAttested(handles)

  const hash = await game.write.revealAndResolve([lobbyId, bearing, delta, mask, defenses])
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`revealAndResolve reverted (${hash})`)
  ok(`revealed — ${manifest.explorer?.url}/tx/${hash}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const lobbyId = process.argv[2]
  if (!lobbyId) {
    console.error('usage: node tools/chain/reveal.mjs <lobbyId>')
    process.exit(1)
  }
  main(lobbyId).catch((error) => {
    console.error(`\x1b[31m[reveal failed]\x1b[0m ${error.message}`)
    process.exit(1)
  })
}
