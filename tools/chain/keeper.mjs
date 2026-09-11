#!/usr/bin/env node
/**
 * `npm run chain:keeper` — the daemon the protocol does not have.
 *
 * Three transitions in this protocol are permissionless *and* necessary:
 * applications close, an under-filled operation is cancelled, and a landed
 * attack is unlocked and revealed. Permissionless means anybody may send
 * them; necessary means that until somebody does, an operation is finished
 * in every sense except the one that pays — no trajectory, no winner, no
 * claimable reward.
 *
 * In the app they are sent by `useProtocolKeeper`, from the browser of
 * whoever happens to have the page open. That is the right default for a
 * protocol with no server, and it is not enough for a public demo: people
 * click, watch one round, and close the tab. An operation nobody is looking
 * at simply waits, and the first impression it leaves is "nothing happens".
 *
 * So this is the same three calls, run from somewhere that does not close.
 * It computes nothing and decides nothing — every one of these transitions
 * is the contract's own, guarded by the contract's own conditions, and this
 * only pays the gas to trigger them. Losing a race to a player's browser is
 * the ordinary outcome, not a failure: whoever won it did the identical
 * thing.
 *
 *   node tools/chain/keeper.mjs              # one sweep, then exit
 *   node tools/chain/keeper.mjs --watch      # sweep every SWEEP_SECONDS
 *   node tools/chain/keeper.mjs --dry-run    # say what it would send
 *
 * Wants its own funded key in `KEEPER_PRIVATE_KEY`; falls back to the
 * deployer's. Give it a key that holds gas money and nothing else — it is
 * the one process here that runs unattended.
 */

import { createPublicClient, createWalletClient, formatEther, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { GENERATED_DIR, loadEnv, log, num, ok, optional, readManifest, required, warn } from './lib.mjs'
import { join } from 'node:path'

const env = loadEnv()
const chainId = num(env, 'CHAIN_ID')
const rpcUrl = required(env, 'RPC_URL')
const manifest = readManifest(chainId)
if (!manifest) throw new Error(`No deployment manifest for chain ${chainId} — run "npm run chain:deploy" first.`)

const abi = JSON.parse(readFileSync(join(GENERATED_DIR, 'abi.json'), 'utf8'))
const proxy = manifest.proxy

const dryRun = process.argv.includes('--dry-run')
const watch = process.argv.includes('--watch')
const sweepSeconds = Number(optional(env, 'KEEPER_SWEEP_SECONDS', '30'))

const account = privateKeyToAccount(
  optional(env, 'KEEPER_PRIVATE_KEY', '') || required(env, 'DEPLOYER_PRIVATE_KEY'),
)
const chain = {
  id: chainId,
  name: manifest.network,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
}
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })

/**
 * `GameTypes.LobbyStatus`, in its own order.
 *
 * Written out in full and taken from the enum rather than counted from the
 * first case anybody cares about: `NONE` occupies zero, so the two statuses
 * this sweep acts on are 1 and 3, not 0 and 1. Getting that wrong is silent
 * — every branch simply never runs, the sweep reports no work, and a keeper
 * that does nothing looks exactly like a keeper with nothing to do.
 */
const NONE = 0
const OPEN = 1
const READY = 2
const ACTIVE = 3

/**
 * Sends one permissionless call, and treats a revert as an ordinary answer.
 *
 * Every transition here is guarded by the contract, and the guard is the
 * same thing the keeper is guessing at from a read taken a block ago. So
 * "reverted" almost always means somebody else got there first, or the
 * condition stopped holding in between — neither is an error worth stopping
 * a sweep for. It is simulated before it is sent, so the common case costs
 * no gas at all.
 */
async function tryCall(functionName, args, label) {
  try {
    await publicClient.simulateContract({ address: proxy, abi, functionName, args, account })
  } catch {
    return false
  }
  if (dryRun) {
    log('keeper', `would send ${label}`)
    return true
  }
  try {
    const hash = await wallet.writeContract({ address: proxy, abi, functionName, args })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      warn(`${label} reverted on chain`)
      return false
    }
    ok(`${label} — ${manifest.explorerUrl ?? ''}/tx/${hash}`)
    return true
  } catch (error) {
    warn(`${label}: ${String(error?.message ?? error).split('\n')[0]}`)
    return false
  }
}

async function read(functionName, args = []) {
  return publicClient.readContract({ address: proxy, abi, functionName, args })
}

/** Every lobby id the lens knows, oldest first. */
async function allLobbyIds() {
  const ids = []
  const pageSize = 100n
  for (let offset = 0n; ; offset += pageSize) {
    const [page, total] = await read('getLobbyIds', [offset, pageSize])
    ids.push(...page)
    if (BigInt(ids.length) >= total || page.length === 0) break
  }
  return ids
}

async function sweep() {
  const block = await publicClient.getBlockNumber()
  const ids = await allLobbyIds()
  let acted = 0

  for (const lobbyId of ids) {
    const [lobby] = await read('getLobby', [lobbyId])

    /*
     * An open room past its deadline goes one of two ways, and the contract
     * decides which: `startOperation` if it filled, `cancelLobby` if it did
     * not. Both are tried, both are simulated first, and the wrong one
     * simply does not simulate — which is cheaper and more honest than
     * reimplementing the minimum-players rule out here where it could drift.
     */
    if (lobby.status === NONE) continue

    // OPEN takes applications, READY filled and waits to start. Same
    // question for both, and the contract is the one that answers it.
    if (lobby.status === OPEN || lobby.status === READY) {
      if (await tryCall('startOperation', [lobbyId], `start ${short(lobbyId)}`)) acted += 1
      else if (await tryCall('cancelLobby', [lobbyId], `cancel under-filled ${short(lobbyId)}`)) acted += 1
      continue
    }

    /*
     * A round that has flown: unlock it, then score it. Two transactions
     * because the confidential network has to see the first one on chain
     * before it will hand over the plaintexts the second one carries — so
     * the reveal itself is left to the app and to `npm run chain:reveal`,
     * which own the client that can fetch an attestation. What the keeper
     * guarantees is that the *unlock* always happens, which is the half that
     * needs nobody's browser and blocks everything after it.
     */
    if (lobby.status === ACTIVE) {
      /*
       * `unlockRound` does not revert on a round that is already open — it
       * succeeds and charges for it — so simulating is not a filter here the
       * way it is everywhere else. Without the check, `--watch` re-sent it
       * on every pass until somebody revealed.
       */
      const [attack] = await read('getAttack', [lobby.attackId])
      if (!attack.decryptionUnlocked) {
        if (await tryCall('unlockRound', [lobbyId], `unlock ${short(lobbyId)}`)) acted += 1
      } else if (await tryCall('expireAttack', [lobbyId], `expire ${short(lobbyId)}`)) {
        // Past the grace window an unrevealed round refunds instead of scoring.
        acted += 1
      }
    }
  }

  // Opening the next Global Defense draw is permissionless too, and it is
  // the one transition with no operation to hang it off.
  if (await tryCall('openGlobalDefense', [], 'open Global Defense')) acted += 1

  log('keeper', `block ${block}: ${ids.length} lobbies, ${acted} action(s)`)
}

function short(id) {
  return `${id.slice(0, 10)}…`
}

log('keeper', `${account.address} on ${manifest.network} (chain ${chainId})${dryRun ? ' — dry run' : ''}`)
const balance = await publicClient.getBalance({ address: account.address })
log('keeper', `gas balance ${formatEther(balance)} ETH`)
if (balance === 0n && !dryRun) warn('the keeper wallet is empty — every send will fail')

await sweep()

if (watch) {
  log('keeper', `watching, every ${sweepSeconds}s — ctrl-c to stop`)
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, sweepSeconds * 1000))
    try {
      await sweep()
    } catch (error) {
      // A sweep that throws must not end the daemon: an RPC blip is the
      // most likely cause and the next sweep is thirty seconds away.
      warn(`sweep failed: ${String(error?.message ?? error).split('\n')[0]}`)
    }
  }
}
