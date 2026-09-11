#!/usr/bin/env node
/**
 * `npm run chain:audit` — does the deployment hold anything nobody can take?
 *
 * The contract's balance should be exactly three things: the protocol's own
 * fees, money still escrowed for operations in progress, and debts it has
 * recorded but not yet been asked to pay. Anything left over after those is
 * stranded — ETH that belongs to somebody with no transaction that moves it
 * — and stranded funds are invisible until you add them up, because every
 * individual operation looks fine.
 *
 * It reads only. Nothing here sends a transaction or needs a key.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, formatEther, http } from 'viem'
import { GENERATED_DIR, loadEnv, log, num, ok, readManifest, required } from './lib.mjs'

const env = loadEnv()
const chainId = num(env, 'CHAIN_ID')
const manifest = readManifest(chainId)
if (!manifest) throw new Error(`No deployment on chain ${chainId}.`)

const abi = JSON.parse(readFileSync(join(GENERATED_DIR, 'abi.json'), 'utf8'))
const publicClient = createPublicClient({ transport: http(required(env, 'RPC_URL')) })
const read = (functionName, args = []) =>
  publicClient.readContract({ address: manifest.proxy, abi, functionName, args })

const STATUS = ['NONE', 'OPEN', 'READY', 'ACTIVE', 'RESOLVED', 'CANCELLED']

async function main() {
  log('audit', `${manifest.network} — proxy ${manifest.proxy}`)

  const [ids, total] = await read('getLobbyIds', [0n, 500n])
  log('audit', `${ids.length} of ${total} operations`)

  let escrowed = 0n // still in play: an operation that has not ended
  let owed = 0n // ended, recorded, and waiting for somebody to claim it
  const debts = []

  for (const id of ids) {
    const [lobby, config] = await read('getLobby', [id])
    const status = STATUS[lobby.status]
    const players = await read('getParticipants', [id])

    let lobbyOwed = 0n
    const notes = []

    if (status === 'CANCELLED') {
      for (const player of players) {
        const participant = await read('getParticipant', [id, player])
        if (!participant.refunded && participant.paidIn > 0n) {
          lobbyOwed += participant.paidIn
          notes.push(`refund ${player.slice(0, 10)} ${formatEther(participant.paidIn)}`)
        }
      }
    }

    if (!lobby.creatorSettled) {
      let creatorDue = 0n
      if (status === 'CANCELLED') {
        creatorDue = config.startPrizePool
      } else if (status === 'RESOLVED') {
        const [, outcome] = await read('getOutcome', [lobby.attackId])
        const paidToWinners = outcome.intercepted ? outcome.rewardPerWinner * BigInt(outcome.winners.length) : 0n
        creatorDue = lobby.creatorFeeAccrued + (lobby.rewardPool > paidToWinners ? lobby.rewardPool - paidToWinners : 0n)
      }
      if (creatorDue > 0n) {
        lobbyOwed += creatorDue
        notes.push(`settleCreator ${formatEther(creatorDue)}`)
      }
    }

    if (status === 'RESOLVED') {
      const [, outcome] = await read('getOutcome', [lobby.attackId])
      if (outcome.intercepted) {
        for (const player of players) {
          const participant = await read('getParticipant', [id, player])
          if (participant.claimed || participant.defenseIndex === 0) continue
          const attempts = await read('getDefenseAttempts', [lobby.attackId])
          if (attempts[participant.defenseIndex - 1]?.isWinner) {
            lobbyOwed += outcome.rewardPerWinner
            notes.push(`reward ${player.slice(0, 10)} ${formatEther(outcome.rewardPerWinner)}`)
          }
        }
      }
    }

    // An operation still running holds everything paid into it, and none of
    // it is claimable yet — that is escrow, not a debt.
    if (status === 'OPEN' || status === 'READY' || status === 'ACTIVE') {
      let held = config.startPrizePool
      for (const player of players) {
        held += (await read('getParticipant', [id, player])).paidIn
      }
      /*
       * Once an operation has started, its join fees are no longer part of
       * what it holds: `startOperation` sweeps them into `protocolTreasury`,
       * which this audit counts separately. Leaving them in both columns
       * makes the contract look 0.00001 ETH short per defender — a phantom
       * insolvency that grows with every operation ever played.
       */
      if (status === 'ACTIVE') held -= lobby.protocolFeeAccrued
      escrowed += held
      console.log(`    ${status.padEnd(9)} ${id.slice(0, 12)}  escrowed ${formatEther(held)} ETH`)
    }

    if (lobbyOwed > 0n) {
      owed += lobbyOwed
      debts.push({ id, status, lobbyOwed, notes })
      console.log(`    ${status.padEnd(9)} ${id.slice(0, 12)}  owed ${formatEther(lobbyOwed)} ETH — ${notes.join(', ')}`)
    }
  }

  const balance = await publicClient.getBalance({ address: manifest.proxy })
  const stats = await read('getStats')
  const treasury = stats[6]
  const stranded = balance - treasury - owed - escrowed

  console.log('')
  console.log(`    contract balance    ${formatEther(balance)} ETH`)
  console.log(`    protocol treasury   ${formatEther(treasury)} ETH`)
  console.log(`    escrowed (in play)  ${formatEther(escrowed)} ETH`)
  console.log(`    owed, unclaimed     ${formatEther(owed)} ETH  across ${debts.length} operations`)
  console.log(`    unaccounted         ${formatEther(stranded)} ETH`)

  if (stranded > 0n) {
    console.log('')
    log('audit', 'unaccounted ETH is money with no transaction that can move it — investigate.')
    process.exitCode = 1
  } else {
    ok('every wei in the contract is either protocol fees, escrow, or a debt somebody can still claim')
  }
}

main().catch((error) => {
  console.error(`\n  ✗ ${error.message}\n`)
  process.exit(1)
})
