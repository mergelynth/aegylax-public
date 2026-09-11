#!/usr/bin/env node
/**
 * `npm run chain:e2e:refund` — the other way an operation ends, on a real
 * network.
 *
 * `chain:e2e` plays the operation that *worked*: it fills, launches, lands
 * and pays a winner. This one plays the operation that never ran — the
 * ending nothing in the suite covered and the one where money is easiest to
 * strand, because the protocol has taken entry fees for a game that will
 * not happen:
 *
 *   create -> one defender joins (below minPlayers) -> buy a probe
 *   -> deadline passes -> cancelLobby -> claimRefund -> settleCreator
 *
 * Every step is a transaction somebody signs, which is the point: a
 * cancellation pays nobody by itself, and the refund is a claim its owner
 * makes. What it proves is that after all of it the contract is holding
 * nothing that belongs to anybody — checked against balances before and
 * after, on chain, not against a model of the contract.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, createWalletClient, decodeEventLog, formatEther, getContract, http, parseEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { GENERATED_DIR, loadEnv, log, num, ok, readManifest, required } from './lib.mjs'

const env = loadEnv()
const chainId = num(env, 'CHAIN_ID')
const rpcUrl = required(env, 'RPC_URL')
const manifest = readManifest(chainId)
if (!manifest) throw new Error(`No deployment on chain ${chainId}. Run "npm run chain:deploy" first.`)

const abi = JSON.parse(readFileSync(join(GENERATED_DIR, 'abi.json'), 'utf8'))
const chain = {
  id: chainId,
  name: manifest.network,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
}
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })

function wallet(privateKey) {
  const account = privateKeyToAccount(privateKey)
  const client = createWalletClient({ account, chain, transport: http(rpcUrl) })
  return { account, address: account.address, client, game: getContract({ address: manifest.proxy, abi, client }) }
}

const creator = wallet(required(env, 'TEST_CREATOR_PK'))
const alice = wallet(required(env, 'TEST_RECIPIENT1_PK'))

const explorer = (manifest.explorer?.url ?? '').replace(/\/+$/, '')
const txLink = (hash) => (explorer ? `${explorer}/tx/${hash}` : hash)

/**
 * Gas spent by every transaction this run has mined, successful or not.
 *
 * Gas matters here in a way it does not elsewhere: the whole assertion is
 * "everybody got their money back", and on a real chain a wallet ends a
 * refunded operation *down* by exactly its fees. Tracking it is what lets
 * the check be exact instead of approximate.
 *
 * Reverted transactions are the reason this is a module-level tally rather
 * than a return value: the calls that are *supposed* to fail still burn gas
 * when they reach the chain, and leaving that out of the accounting makes a
 * perfectly whole wallet look short by the cost of proving a double refund
 * is impossible.
 */
const gasSpent = new Map()
/** The highest block any of this run's transactions landed in. */
let lastBlock = 0n

function chargeGas(who, receipt) {
  /*
   * `gasUsed * effectiveGasPrice` is only part of what a transaction costs
   * on an OP-stack chain like Base: the rest is the L1 data fee for posting
   * the calldata, and the receipt reports it separately. Leaving it out left
   * every wallet looking a few tens of gwei short of whole — small enough to
   * dismiss as noise, which is exactly why it is worth counting rather than
   * loosening the assertion to hide it.
   */
  // `BigInt(...)` rather than a bare `??`: this chain object is hand-built
  // without viem's OP-stack formatters, so `l1Fee` arrives as the raw hex
  // string the node sent rather than as a bigint.
  const fee = receipt.gasUsed * receipt.effectiveGasPrice + BigInt(receipt.l1Fee ?? 0)
  gasSpent.set(who.address, (gasSpent.get(who.address) ?? 0n) + fee)
  if (receipt.blockNumber > lastBlock) lastBlock = receipt.blockNumber
}

async function send(who, functionName, args, value = 0n, label = functionName) {
  const hash = await who.game.write[functionName](args, { value })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  chargeGas(who, receipt)
  if (receipt.status !== 'success') throw new Error(`${label} reverted (${txLink(hash)})`)
  ok(`${label} — ${txLink(hash)}`)
  return { receipt }
}

function eventArgs(receipt, name) {
  for (const entry of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi, data: entry.data, topics: entry.topics })
      if (decoded.eventName === name) return decoded.args
    } catch {
      // Not one of ours.
    }
  }
  return null
}

async function read(functionName, args = []) {
  return publicClient.readContract({ address: manifest.proxy, abi, functionName, args })
}

async function waitForState(check, label, { attempts = 15, delayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (await check()) return
    } catch {
      // A lagging node throws the same way it answers stale.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(`Timed out waiting for ${label} to be visible on the RPC`)
}

const balanceOf = (who) => publicClient.getBalance({ address: who.address })

async function expectRevert(promise, label) {
  try {
    await promise
    throw new Error(`ACCEPTED: ${label} was allowed when it should have been refused`)
  } catch (error) {
    if (String(error.message).startsWith('ACCEPTED:')) throw error
    ok(`${label} is refused — ${String(error.message).split('\n')[0].slice(0, 80)}`)
  }
}

async function main() {
  log('refund', `${manifest.network} — proxy ${manifest.proxy}`)
  log('refund', `creator ${creator.address}`)
  log('refund', `alice   ${alice.address}`)

  const [params] = await read('getParams')
  const entryPrice = params.minEntryFee
  const prizePool = params.minStartPrizePool * 2n
  const probePrice = parseEther('0.00001')
  /*
   * Longer than `chain:e2e`'s window, because this run has more to do
   * inside it: create, wait for the lobby to be readable, join, wait for
   * the membership to be readable, buy a probe, and prove an early refund
   * is refused — all before the deadline it is measuring against. At 60s a
   * slow node meant the join itself arrived after registration had closed.
   */
  const registrationSeconds = num(env, 'E2E_REGISTRATION_SECONDS', 150)

  const contractBefore = await publicClient.getBalance({ address: manifest.proxy })
  const creatorBefore = await balanceOf(creator)
  const aliceBefore = await balanceOf(alice)

  // --- create -----------------------------------------------------------
  // minPlayers 3 with one defender available: this operation cannot fill,
  // which is the whole scenario.
  const config = {
    name: `Refund ${new Date().toISOString().slice(11, 19)}`,
    minPlayers: 3,
    maxPlayers: 10,
    entryPrice,
    registrationDeadline: BigInt(Math.floor(Date.now() / 1000) + registrationSeconds),
    registrationDeadlineBlock:
      (await publicClient.getBlockNumber()) + BigInt(Math.ceil(registrationSeconds / 2)),
    startPrizePool: prizePool,
    creatorFeeBps: 500,
    freeProbes: 3,
    maxProbes: params.maxProbes,
    probePrice,
  }

  log('step 1', `create an operation needing ${config.minPlayers} defenders`)
  const created = await send(creator, 'createLobby', [config], prizePool, 'createLobby')
  const lobbyId = eventArgs(created.receipt, 'LobbyCreated').lobbyId
  ok(`lobbyId ${lobbyId}`)

  await waitForState(async () => {
    const [lobby] = await read('getLobby', [lobbyId])
    return lobby.status !== 0
  }, 'the new lobby')

  // --- join + buy a probe ------------------------------------------------
  log('step 2', 'one defender joins and buys a probe — both are refundable')
  const joinCost = entryPrice + params.protocolJoinFee
  await send(alice, 'joinLobby', [lobbyId], joinCost, 'alice joins')

  // The next call is *simulated* before it is sent, and the node that
  // answers the simulation is not necessarily the one that mined the join —
  // so without this the probe purchase reverts with NotParticipant against
  // a participant who very much exists.
  await waitForState(
    async () => (await read('getParticipant', [lobbyId, alice.address])).joined,
    'alice’s membership',
  )

  await send(alice, 'buyProbes', [lobbyId, 1], probePrice, 'alice buys 1 probe')

  // Waited for rather than read once, for the same reason as above: a
  // one-shot read here compares the expected total against whatever the
  // node it lands on has caught up to, which fails on a correct contract.
  const paidIn = joinCost + probePrice
  await waitForState(
    async () => (await read('getParticipant', [lobbyId, alice.address])).paidIn === paidIn,
    `alice’s paidIn reaching ${formatEther(paidIn)} ETH`,
  )
  ok(`contract records alice paidIn ${formatEther(paidIn)} ETH — entry, join fee and the probe`)

  // Nothing is refundable while the operation can still fill.
  await expectRevert(send(alice, 'claimRefund', [lobbyId], 0n, 'early claimRefund'), 'a refund before the deadline')

  // --- the deadline passes ------------------------------------------------
  const secondsLeft = Number(config.registrationDeadline) - Math.floor(Date.now() / 1000) + 2
  if (secondsLeft > 0) {
    log('wait', `applications close in ${secondsLeft}s`)
    await new Promise((resolve) => setTimeout(resolve, secondsLeft * 1000))
  }

  // Under-filled, so starting it must be impossible — the only way out is
  // cancellation.
  await expectRevert(
    send(creator, 'startOperation', [lobbyId], 0n, 'startOperation'),
    'starting an under-filled operation',
  )

  log('step 3', 'cancel the under-filled operation')
  const cancelled = await send(alice, 'cancelLobby', [lobbyId], 0n, 'cancelLobby')
  ok(`reason: "${eventArgs(cancelled.receipt, 'LobbyCancelled').reason}"`)

  // Cancellation is a status change and nothing else: no money moved.
  const afterCancel = await balanceOf(alice)
  if (afterCancel > aliceBefore - (gasSpent.get(alice.address) ?? 0n)) {
    throw new Error('cancelling paid somebody without them asking for it')
  }
  ok('cancelling paid nobody — the refund is still a claim alice has to make')

  // --- refund -------------------------------------------------------------
  log('step 4', 'alice claims her refund')
  await waitForState(async () => {
    const [lobby] = await read('getLobby', [lobbyId])
    return lobby.status === 5
  }, 'the cancelled status')

  const refunded = await send(alice, 'claimRefund', [lobbyId], 0n, 'claimRefund')
  const refundArgs = eventArgs(refunded.receipt, 'RefundClaimed')
  ok(`${formatEther(refundArgs.amount)} ETH refunded to ${refundArgs.player}`)
  if (refundArgs.amount !== paidIn) {
    throw new Error(`refund ${refundArgs.amount} is not what alice paid in (${paidIn})`)
  }

  await expectRevert(send(alice, 'claimRefund', [lobbyId], 0n, 'second claimRefund'), 'a second refund')

  // --- creator settlement --------------------------------------------------
  log('step 5', 'the creator takes the bounty back')
  const settled = await send(creator, 'settleCreator', [lobbyId], 0n, 'settleCreator')
  const settledArgs = eventArgs(settled.receipt, 'CreatorSettled')
  ok(`${formatEther(settledArgs.amount)} ETH returned to ${settledArgs.creator}`)
  if (settledArgs.amount !== prizePool) {
    throw new Error(`creator got ${settledArgs.amount}, but funded a ${prizePool} bounty`)
  }

  await expectRevert(send(creator, 'settleCreator', [lobbyId], 0n, 'second settleCreator'), 'a second settlement')

  // --- the accounting ------------------------------------------------------
  log('step 6', 'what everybody is left with')
  /*
   * Balances, read from a node that has actually seen the last payout.
   *
   * A public RPC is many nodes behind one URL, and the one that answers
   * `eth_getBalance` need not be the one that mined `settleCreator`. Read a
   * moment too early and a contract that paid out correctly reports as
   * having kept the money — which is a false accusation, not a finding.
   */
  await waitForState(async () => (await publicClient.getBlockNumber()) >= lastBlock, 'the last payout to be visible')
  const creatorAfter = await balanceOf(creator)
  const aliceAfter = await balanceOf(alice)
  const contractAfter = await publicClient.getBalance({ address: manifest.proxy })

  // On a real chain "whole" means "whole minus the gas you spent asking" —
  // including the gas burned by the calls that were supposed to be refused.
  const creatorNet = creatorAfter + (gasSpent.get(creator.address) ?? 0n) - creatorBefore
  const aliceNet = aliceAfter + (gasSpent.get(alice.address) ?? 0n) - aliceBefore
  console.log(`    creator  ${formatEther(creatorNet)} ETH net of fees`)
  console.log(`    alice    ${formatEther(aliceNet)} ETH net of fees`)
  console.log(`    contract ${formatEther(contractBefore)} -> ${formatEther(contractAfter)} ETH`)

  /*
   * The exact check is the contract's, and it is exact on purpose: no gas
   * enters it, so a protocol that kept a single wei of somebody's entry fee
   * fails here with nothing to argue about. This — including the protocol's
   * own join fee, which is only earned by an operation that actually ran —
   * is the property the whole script exists to establish.
   */
  if (contractAfter !== contractBefore) {
    throw new Error(`the contract kept ${formatEther(contractAfter - contractBefore)} ETH from a cancelled operation`)
  }

  /*
   * The wallet checks carry a tolerance, because a wallet's balance is only
   * knowable to the wei if the fees are, and on an OP-stack chain they are
   * not: the L1 data fee a receipt reports is not the last word on what was
   * charged. A few gwei of slack is the honest precision available here, and
   * it is orders of magnitude below anything that could hide a lost refund —
   * the amounts in play are 1e-5 ETH, four decimal places above the slack.
   */
  const FEE_SLACK_WEI = 1_000_000_000n
  const short = (net) => net < -FEE_SLACK_WEI
  if (short(creatorNet)) throw new Error(`creator is out ${formatEther(-creatorNet)} ETH on a cancelled operation`)
  if (short(aliceNet)) throw new Error(`alice is out ${formatEther(-aliceNet)} ETH on a cancelled operation`)

  ok('the contract kept nothing — join fee included — and both wallets are whole net of fees')

  log('done', `cancelled operation ${lobbyId} settled end to end on ${manifest.network}`)
}

main().catch((error) => {
  console.error(`\n  ✗ ${error.message}\n`)
  process.exit(1)
})
