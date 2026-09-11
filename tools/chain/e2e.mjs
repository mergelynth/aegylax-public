#!/usr/bin/env node
/**
 * `npm run chain:e2e` — one whole operation, on a real network, with three
 * separate wallets.
 *
 * This is the test the unit suite cannot be: it runs against the deployed
 * protocol, through the real confidential network, with a creator and two
 * defenders who each sign their own transactions from their own keys. Every
 * step a player would take, in the order they would take it:
 *
 *   create -> join x2 -> start -> probe (decrypted only by its owner)
 *   -> two Defense Points, each encrypted in its own "browser"
 *   -> unlockRound -> revealAndResolve -> winner -> claim -> settle
 *
 * What it proves that a local test cannot: that Inco's encrypted input,
 * per-address decryption and attested reveal all line up with what the
 * contract expects, on the network they are actually deployed to.
 *
 * It costs real (testnet) ETH and takes a few minutes of wall clock, most
 * of it waiting for the attack to launch and land.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  formatEther,
  getContract,
  http,
  parseEther,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { GENERATED_DIR, loadEnv, log, num, ok, optional, readManifest, required, warn } from './lib.mjs'
import { connectConfidential } from './confidential-client.mjs'

const WU = 1_000_000n
const MAX_LAUNCH_OFFSET_MICRO_RAD = 1_047_198
const ATTACK_BIAS_MICRO_RAD = 87_266
/** `ReconRules.DELAY_BLOCKS`: probe -> next probe, and probe -> Defense. */
const PROBE_DELAY_BLOCKS = 8n
const HINT_LIMB = 2 ** 32

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

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
  return {
    account,
    address: account.address,
    client: createWalletClient({ account, chain, transport: http(rpcUrl) }),
    game: getContract({
      address: manifest.proxy,
      abi,
      client: createWalletClient({ account, chain, transport: http(rpcUrl) }),
    }),
  }
}

const creator = wallet(required(env, 'TEST_CREATOR_PK'))
const alice = wallet(required(env, 'TEST_RECIPIENT1_PK'))
const bob = wallet(required(env, 'TEST_RECIPIENT2_PK'))

const explorer = (manifest.explorer?.url ?? '').replace(/\/+$/, '')
const txLink = (hash) => (explorer ? `${explorer}/tx/${hash}` : hash)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sends, waits, and refuses to call a reverted transaction a success.
 *
 * The retry is for one specific failure and nothing else: a public RPC is a
 * load balancer over many nodes, and two transactions sent back to back from
 * one wallet can have the second's nonce read off a node that has not seen
 * the first. That is an artefact of the endpoint, not a refusal by the
 * protocol — so it is waited out, while a revert still fails immediately.
 */
/**
 * How much headroom a transaction gets over its estimate.
 *
 * An estimate is made against the chain as it is *now*, and this script
 * plays a game whose cost depends on where the block clock stands: minting
 * an operation costs an extra attack whenever its epoch has not been drawn
 * yet, and whether that is true can change between the estimate and the
 * execution. On a chain with fast blocks it reliably does — `createLobby`
 * ran out of gas mid-mint, having already emitted `AttackStarted`.
 *
 * Padding is the right fix rather than retrying: the estimate is not wrong
 * about the state it saw, it is answering about a different block.
 */
const GAS_HEADROOM_PERCENT = 60n

async function send(who, functionName, args, value = 0n, label = functionName) {
  for (let attempt = 1; ; attempt++) {
    try {
      let gas
      try {
        const estimate = await who.game.estimateGas[functionName](args, { value })
        gas = (estimate * (100n + GAS_HEADROOM_PERCENT)) / 100n
      } catch {
        // Let the write path produce the real error rather than masking it here.
      }
      const hash = await who.game.write[functionName](args, gas ? { value, gas } : { value })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`${label} reverted (${txLink(hash)})`)
      ok(`${label} — ${txLink(hash)}`)
      return receipt
    } catch (error) {
      const message = String(error?.message ?? error)
      const isNonceRace = /nonce/i.test(message) && !/reverted/i.test(message)
      if (!isNonceRace || attempt >= 5) throw error
      log('retry', `${label}: ${message.split('\n')[0]}`)
      await new Promise((resolve) => setTimeout(resolve, 3000))
    }
  }
}

function eventsIn(receipt) {
  return receipt.logs
    .map((entry) => {
      try {
        return decodeEventLog({ abi, data: entry.data, topics: entry.topics })
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function eventArgs(receipt, name) {
  return eventsIn(receipt).find((entry) => entry.eventName === name)?.args ?? null
}

async function waitForBlock(target, what) {
  let current = await publicClient.getBlockNumber()
  if (current >= target) return
  log('wait', `${what}: block ${current} -> ${target} (~${Number(target - current) * 2}s)`)
  while (current < target) {
    await new Promise((resolve) => setTimeout(resolve, 4000))
    current = await publicClient.getBlockNumber()
  }
}

async function read(functionName, args = []) {
  return publicClient.readContract({ address: manifest.proxy, abi, functionName, args })
}

/**
 * Waits until the chain *reads back* what a transaction just wrote.
 *
 * A public RPC endpoint is several nodes behind one address, and a receipt
 * only proves the transaction was mined on the node that answered — the
 * next `eth_call` can land on one that has not caught up and report the
 * lobby as not existing. This is the difference between a script that works
 * against a private node and one that works against the endpoint players
 * actually use.
 */
async function waitForState(check, label, { attempts = 15, delayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      if (await check()) return
    } catch {
      // A lagging node can also throw here; it is the same wait.
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(`Timed out waiting for ${label} to be visible on the RPC`)
}

/**
 * A Defense Point, in the single word the contract stores.
 *
 * The board's origin is its own corner, so both coordinates are
 * non-negative and pack into one uint256 — which is what makes a Defense
 * Point a single confidential value rather than a pair of them.
 */
function packPoint(xKm, yKm) {
  const x = BigInt(Math.round(xKm * 1e6))
  const y = BigInt(Math.round(yKm * 1e6))
  // 64-bit limbs, matching `Geometry.POINT_LIMB_BITS` — the packed word is
  // encrypted, and CoFHE's widest encrypted integer is `euint128`.
  return (x & ((1n << 64n) - 1n)) | (y << 64n)
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  log('e2e', `${manifest.network} — proxy ${manifest.proxy}`)
  log('e2e', `creator ${creator.address}`)
  log('e2e', `alice   ${alice.address}`)
  log('e2e', `bob     ${bob.address}`)

  for (const who of [creator, alice, bob]) {
    const balance = await publicClient.getBalance({ address: who.address })
    if (balance === 0n) throw new Error(`${who.address} has no ETH on ${manifest.network}`)
  }

  const [params] = await read('getParams')
  /*
   * Whichever confidential network this deployment runs. The run does the
   * same three things a browser does — seal a point, open a probe answer,
   * fetch the reveal — and which provider answers is the manifest's, not
   * this script's.
   */
  const confidential = await connectConfidential({ manifest, chainId, rpcUrl, publicClient })
  const isMock = confidential.kind === 'mock'
  ok(`${confidential.label} connected — ${confidential.provider}`)

  /*
   * Warm both defenders before the clock starts.
   *
   * A Defense Point may only be submitted between launch and impact, and
   * the probes ahead of it eat most of that window. Paying for the FHE key
   * and CRS download inside it — which is where the SDK would otherwise put
   * that cost, on the first encryption — is how this run first failed with
   * `DefenseWindowClosed`, having had the time and spent it on a download.
   */
  if (!isMock) {
    const warmed = Date.now()
    await confidential.warmUp(alice.client)
    await confidential.warmUp(bob.client)
    ok(`confidential keys warmed for both defenders (${((Date.now() - warmed) / 1000).toFixed(1)}s)`)
  }

  // --- create -----------------------------------------------------------
  const entryPrice = params.minEntryFee
  const prizePool = params.minStartPrizePool * 4n
  const probePrice = parseEther('0.00001')
  /*
   * The application window, in the unit the protocol enforces.
   *
   * Blocks, not seconds — that is what the contract turns into an epoch, and
   * it has to be measured from the block the *creation* lands in rather than
   * from whenever this script happened to start: confirming a transaction
   * and waiting for the RPC to catch up costs blocks, and a window measured
   * before all that is partly gone before the first defender can join.
   */
  const registrationBlocks = num(env, 'E2E_REGISTRATION_BLOCKS', 60)
  const deadlineBlock = (await publicClient.getBlockNumber()) + BigInt(registrationBlocks)
  // The creator's stated time, kept consistent with the block window so the
  // two halves of the deadline do not tell different stories.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + registrationBlocks * 2)

  /*
   * Recon terms are deliberately absent. `GameTypes.LobbyConfig` stopped
   * carrying `freeProbes` / `maxProbes` / `probePrice` when the threat
   * became the epoch's rather than the operation's; leaving them here
   * described a struct the contract no longer has.
   */
  const config = {
    name: `E2E ${new Date().toISOString().slice(11, 19)}`,
    minPlayers: 2,
    maxPlayers: 10,
    entryPrice,
    registrationDeadline: deadline,
    registrationDeadlineBlock: deadlineBlock,
    startPrizePool: prizePool,
    creatorFeeBps: 500,
  }

  /*
   * The pool *plus* the protocol's creation fee — the contract checks the
   * sum exactly (`IncorrectPayment`). Sending only the pool is what this
   * script did until the fee existed, and it has failed at step 1 ever
   * since: the fee is the treasury's from the moment of creation and is
   * kept even if the room never fills, so it cannot be folded into the pool.
   */
  log('step 1', 'create the operation')
  const created = await send(creator, 'createLobby', [config], prizePool + params.protocolJoinFee, 'createLobby')
  const lobbyId = eventArgs(created, 'LobbyCreated').lobbyId
  ok(`lobbyId ${lobbyId}`)

  await waitForState(async () => {
    const [lobby] = await read('getLobby', [lobbyId])
    return lobby.status !== 0
  }, 'the new lobby')

  // --- join -------------------------------------------------------------
  log('step 2', 'two defenders join, each from their own wallet')
  /*
   * Entry plus the *author's* commission, not the protocol's fee. Those are
   * two different charges going to two different places: the protocol is
   * paid once, by the creator, at creation; joiners pay the author, and get
   * that back if the round never starts. `Settlement.joinPayment` is the
   * contract's own name for this sum.
   */
  const joinCost = entryPrice + (entryPrice * BigInt(config.creatorFeeBps)) / 10_000n
  await send(alice, 'joinLobby', [lobbyId], joinCost, 'alice joins')
  await send(bob, 'joinLobby', [lobbyId], joinCost, 'bob joins')

  // --- the attack, which nobody has to schedule --------------------------
  await waitForState(async () => {
    const [lobby] = await read('getLobby', [lobbyId])
    return lobby.participantCount >= 2
  }, 'both joins')

  /*
   * Nothing is sent here on purpose.
   *
   * The attack was scheduled by `createLobby` — the deadline is a block, so
   * the contract could derive its epoch on the spot — and it launches and
   * lands on its own. The operation is still OPEN as far as the status byte
   * goes; the first probe below is what settles the money, as a side effect.
   */
  const attackStarted = eventArgs(created, 'AttackStarted')
  const attackId = attackStarted.attackId
  ok(`attack ${attackId} launches at ${attackStarted.launchBlock}, impacts at ${attackStarted.impactBlock}`)
  ok('scheduled at creation — no start transaction was sent')

  log('step 3', 'wait out the application window')
  await waitForBlock(deadlineBlock, 'applications close')

  // The geometry exists now and is readable by nobody.
  const [beforeRevealed] = await read('getTrajectory', [attackId])
  if (beforeRevealed) throw new Error('the trajectory is public before the attack has even launched')
  ok('trajectory is sealed — getTrajectory answers nothing')

  await waitForBlock(attackStarted.launchBlock, 'attack launch')

  // --- probe ------------------------------------------------------------
  log('step 4', 'both defenders spend their free probes and fuse what they get')
  await waitForState(async () => {
    const [lobby] = await read('getLobby', [lobbyId])
    return lobby.attackId === attackId
  }, 'the scheduled attack')

  /*
   * The free allowance is the *protocol's*, not the operation's — it left
   * `LobbyConfig` when the threat became the epoch's — so it is read from
   * `getParams`. Reading it off `config` silently yielded `NaN` and skipped
   * reconnaissance altogether, which the run reported as two defenders
   * firing with no intelligence rather than as a failure.
   */
  /**
   * How much of the flight is left, in blocks and seconds.
   *
   * Three runs in a row died on `DefenseWindowClosed` and each time the
   * question was the same: where did the window go? Reasoning about it from
   * a log with no clock in it is guesswork, so the clock goes in the log.
   * Every line that costs real time prints what it cost and what is left.
   */
  const budget = async (what) => {
    const now = await publicClient.getBlockNumber()
    const left = Number(attackStarted.impactBlock) - Number(now)
    log('budget', `${what}: block ${now}, ${left} blocks to impact (~${left * 2}s)`)
    return left
  }

  const probesEach = Math.min(3, Number(params.freeProbes))
  const intel = new Map()
  let firstProbe = null

  // The two defenders play at the same time, as two people would. Doing it
  // one after the other spends the flight window on waiting rather than on
  // the game.
  await budget('reconnaissance starts')
  await Promise.all([alice, bob].map(runReconnaissance))
  await budget('reconnaissance done')

  /**
   * One defender's whole reconnaissance, run as a pipeline rather than as a
   * queue.
   *
   * A probe is one transaction. `sendProbe` computes the hint and grants it
   * to the sender in the same call, so there is nothing to collect and
   * nothing to wait for before the read can start.
   *
   * The protocol's rule about spacing is `ProbeInFlight`, measured from the
   * *send*: eight blocks after this wallet's last `sendProbe`, the next one
   * is allowed — and the same eight blocks gate that wallet's
   * `submitDefense`, which is where the delay went when it stopped
   * withholding the answer.
   *
   * Reading is the slow part, and it is slow for a reason that has nothing
   * to do with the game: CoFHE learns about a handle by watching the chain,
   * so the answer ripens tens of seconds after the transaction is mined.
   * That ripening now overlaps the eight blocks this wallet has to sit out
   * anyway, instead of starting after a second transaction that had to be
   * ingested first.
   */
  async function runReconnaissance(who) {
    const reads = []

    for (let index = 0; index < probesEach; index++) {
      /*
       * Where the sensor stands is the whole of a probe's input (ТЗ §5): the
       * engine draws one noise sample per cell and keeps it, so a second
       * reading from the same place is the same reading. Each probe
       * therefore has to move, and the two defenders start from different
       * rows so neither is reading the other's cells back.
       */
      const sensor = sensorCell(who, index, params)
      const receipt = await send(
        who,
        'sendProbe',
        [lobbyId, sensor.column, sensor.row],
        0n,
        `probe ${index + 1} of ${who.address.slice(0, 8)} from ${sensor.column},${sensor.row}`,
      )
      const probe = eventArgs(receipt, 'ProbeSent')
      firstProbe ??= { handle: probe.hintHandle, owner: who }

      /*
       * The read is detached, and it can start immediately: the grant is on
       * the transaction that was just mined. It is not a transaction itself
       * — it is a request to the threshold network, which cannot answer
       * until CoFHE has noticed that transaction — so it ripens in the
       * background while this wallet sits out its delay. Every read is
       * awaited below before a bearing is used.
       *
       * Only this wallet can open this answer, and it authorises the read —
       * which is what makes each defender's picture theirs and not a shared
       * one.
       */
      const readStarted = Date.now()
      reads.push(
        confidential.decryptForOwner(who.client, probe.hintHandle).then((hint) => {
          log(
            'budget',
            `read probe ${index + 1} of ${who.address.slice(0, 8)} took ${((Date.now() - readStarted) / 1000).toFixed(0)}s`,
          )
          return hint
        }),
      )

      /*
       * Serve the delay — before the next probe, and after the last one.
       *
       * Eight blocks from this send is when this wallet may probe again,
       * and also when it may submit a Defense Point: the rule gates both,
       * which is what lets the answer be handed over immediately.
       */
      await waitForBlock(
        receipt.blockNumber + PROBE_DELAY_BLOCKS,
        `probe ${index + 1} of ${who.address.slice(0, 8)} lands`,
      )
    }

    const bearings = (await Promise.all(reads)).map((hint) => {
      const thetaLimb = Number(hint % BigInt(HINT_LIMB))
      const theta = thetaLimb - params.probeConeMicroRad - ATTACK_BIAS_MICRO_RAD - MAX_LAUNCH_OFFSET_MICRO_RAD
      return -Math.PI / 2 + theta / 1e6
    })

    if (bearings.length === 0) return
    const fused = circularMean(bearings)
    intel.set(who.address, fused)
    ok(
      `${who === alice ? 'alice' : 'bob  '} fuses ${bearings.length} readings -> ${deg(fused)}° ` +
        `(raw ${bearings.map(deg).join('°, ')}°)`,
    )
  }

  // The privacy property, checked against the live network rather than
  // asserted: one wallet's answer must not open for another.
  if (!isMock && firstProbe) {
    const stranger = firstProbe.owner === alice ? bob : alice
    try {
      await confidential.decryptForOwner(stranger.client, firstProbe.handle, { attempts: 1, delayMs: 0 })
      throw new Error('PRIVACY FAILURE: a probe answer opened for a wallet it was never granted to')
    } catch (error) {
      if (String(error.message).includes('PRIVACY FAILURE')) throw error
      ok(`another wallet cannot open that answer — ${String(error.message).split('\n')[0].slice(0, 70)}`)
    }
  }

  await budget('privacy check done')

  // --- defend -----------------------------------------------------------
  log('step 5', 'both defenders submit encrypted Defense Points')
  const world = buildWorld(params)
  /*
   * Both at once, because the window is real.
   *
   * Each defender aims with their *own* intelligence, at their own altitude:
   * different arrival times, which is what the ranking rule turns on. What
   * is *not* part of the game is doing that one after the other — two
   * players in two browsers would seal and send at the same time, and the
   * probes ahead of this leave under a minute of flight to do it in. Run
   * sequentially, the second defender was submitting after impact.
   *
   * Separate wallets, so there is no shared nonce to serialise.
   */
  await Promise.all([
    submitDefense(alice, lobbyId, aimAlongBearing(world, intel.get(alice.address), 0.55), confidential),
    submitDefense(bob, lobbyId, aimAlongBearing(world, intel.get(bob.address), 0.8), confidential),
  ])

  // Attempts are a *team's*, so they are keyed by the lobby — the attack is
  // the epoch's and is faced by every operation running that epoch.
  await waitForState(async () => (await read('getDefenseAttempts', [lobbyId])).length === 2, 'both defenses')

  const attempts = await read('getDefenseAttempts', [lobbyId])
  if (attempts.some((attempt) => attempt.revealed || attempt.x !== 0n)) {
    throw new Error('a Defense Point is readable before the reveal')
  }
  ok(`${attempts.length} attempts on chain, all still sealed`)

  // --- complete + reveal -------------------------------------------------
  const [attack] = await read('getAttack', [attackId])
  await waitForBlock(attack.impactBlock + 1n, 'impact')

  /*
   * The reveal, exactly as the app performs it.
   *
   * The protocol decomposes it into four steps — two about the *epoch*
   * (landing the threat and publishing its geometry, once for the whole
   * world) and two about this *team*, whose Defense Points and pool are its
   * own — and all four are still callable one at a time. Nobody sends four
   * transactions for them: `unlockRound` and `revealAndResolve` fold the
   * pairs together, and this walks the same two calls
   * `ContractBlockchainClient.performReveal` makes from the browser.
   *
   * Two rather than one because of what sits between them. Each pair is
   * unlock-then-prove: the unlock has to be *mined* before the covalidator
   * quorum will sign the plaintext the second call brings back for checking,
   * so the `fetchAttestedWithPatience` below is a round trip no single
   * transaction can contain. Keeping the script on this path is the point of
   * having it — the four-step version is pinned by `Reveal.t.sol` instead.
   */
  /*
   * `--no-reveal` stops here, with a played round nobody has finished.
   *
   * That state is the whole point of having a keeper, and it is the only way
   * to check that the keeper actually works: the round is real, the defenses
   * are sealed, impact is minutes away, and no browser is open. If nothing
   * else happens, the operation stays unresolved until the grace period
   * refunds it — so anything that *does* resolve it was the keeper.
   */
  if (process.argv.includes('--no-reveal')) {
    ok(`left unrevealed for the keeper — lobby ${lobbyId}`)
    log('budget', `impact at block ${attack.impactBlock}`)
    return
  }

  log('step 6', 'unlock the round — lands the attack and opens this team, permissionlessly')
  await send(bob, 'unlockRound', [lobbyId], 0n, 'unlockRound')
  await waitForState(async () => {
    const [current] = await read('getAttack', [attackId])
    return current.decryptionUnlocked
  }, 'decryption unlock')

  log('step 7', 'fetch attested plaintexts, then reveal and score in one call')
  /*
   * One request for everything the second call needs: the threat's bearing
   * and delta, then one proof per attempt in the order `resolveLobby`
   * expects. The confidential network learns about the unlock by watching
   * the chain, so for a short while after `unlockRound` it correctly answers
   * "not yet".
   */
  const maskedHandles = attempts.map((entry) => entry.maskedHandle)
  const allHandles = [attack.bearingHandle, attack.deltaHandle, attack.maskKeyHandle, ...maskedHandles]
  const [bearingProof, deltaProof, maskProof, ...defenseProofs] = await confidential.fetchAttested(allHandles)

  const revealTx = await send(
    creator,
    'revealAndResolve',
    [lobbyId, bearingProof, deltaProof, maskProof, defenseProofs],
    0n,
    'revealAndResolve',
  )

  // Both events come out of the one transaction now.
  const revealArgs = eventArgs(revealTx, 'AttackRevealed')
  const winnerArgs = eventArgs(revealTx, 'WinnerDetermined')
  const traj = revealArgs.trajectory
  ok(
    `trajectory published: (${fmtKm(traj.startX)}, ${fmtKm(traj.startY)}) km -> (${fmtKm(traj.targetX)}, ${fmtKm(traj.targetY)}) km, ${fmtKm(traj.lengthWu)} km long`,
  )

  // --- results -----------------------------------------------------------
  log('step 8', 'results')
  // Read back only once the node answering has the resolved state: a
  // lagging one still reports every attempt as sealed, which would print a
  // resolved round as if nothing had happened.
  await waitForState(
    async () => (await read('getDefenseAttempts', [lobbyId])).every((attempt) => attempt.revealed),
    'resolved defense attempts',
  )
  const resolved = await read('getDefenseAttempts', [lobbyId])
  for (const attempt of resolved) {
    const who = attempt.participant === alice.address ? 'alice' : attempt.participant === bob.address ? 'bob  ' : attempt.participant
    console.log(
      `    ${who}  point (${fmtKm(attempt.x)}, ${fmtKm(attempt.y)}) km  ` +
        `miss ${fmtKm(attempt.missDistanceWu)} km  arrival block ${(Number(attempt.arrivalBlockScaled) / 1e6).toFixed(2)}  ` +
        `${attempt.intercepted ? 'INTERCEPTED' : 'missed'}${attempt.isWinner ? '  <- WINNER' : ''}`,
    )
  }

  if (winnerArgs.intercepted) {
    ok(`winner ${winnerArgs.winners.join(', ')} for ${formatEther(winnerArgs.rewardPerWinner)} ETH`)
    const winner = winnerArgs.winners[0] === alice.address ? alice : bob
    const claimed = await send(winner, 'claimReward', [lobbyId], 0n, 'claimReward')
    const paid = eventArgs(claimed, 'RewardClaimed')
    ok(`${formatEther(paid.amount)} ETH paid to ${paid.player ?? paid.participant}`)

    try {
      await send(winner, 'claimReward', [lobbyId], 0n, 'second claimReward')
      throw new Error('DOUBLE CLAIM: the protocol paid the same reward twice')
    } catch (error) {
      if (String(error.message).includes('DOUBLE CLAIM')) throw error
      ok('a second claim is rejected')
    }
  } else {
    ok('the threat reached Earth — nobody is paid, and the pool goes back to the creator')
  }

  log('step 9', 'creator settles')
  await send(creator, 'settleCreator', [lobbyId], 0n, 'settleCreator')

  const contractBalance = await publicClient.getBalance({ address: manifest.proxy })
  const [, , , , , , treasury] = await read('getStats')
  ok(`contract holds ${formatEther(contractBalance)} ETH, of which ${formatEther(treasury)} is protocol fees`)

  log('done', `operation ${lobbyId} played end to end on ${manifest.network}`)
  if (explorer) log('done', `${explorer}/address/${manifest.proxy}`)
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

async function submitDefense(who, lobbyId, point, confidential) {
  const packed = packPoint(point.x, point.y)
  const sealing = Date.now()
  const ciphertext = await confidential.encrypt(packed, who.client)
  log('budget', `${who.address.slice(0, 8)} sealed in ${((Date.now() - sealing) / 1000).toFixed(1)}s`)
  const receipt = await send(who, 'submitDefense', [lobbyId, ciphertext], 0n, `defense from ${who.address.slice(0, 8)}`)

  /*
   * The control measurement for a probe read, and the reason it is here.
   *
   * A probe hint costs the coprocessor real arithmetic — four encrypted
   * remainders, which are long-division circuits, plus the adds that pack
   * the two angles. A Defense Point costs it none: `newEncryptedPoint`
   * verifies a signature and grants, and the handle it returns is the
   * player's own ciphertext rather than anything computed from it.
   *
   * Both then take the same road home: the threshold network re-encrypts
   * under a key only this wallet holds. So the difference between these two
   * numbers is what the *computation* costs, and their common floor is what
   * the sealing costs — and until they are measured apart, "the probe read
   * takes twenty seconds" does not say which of the two to attack.
   *
   * Never fatal: this is instrumentation, and a round must not fail because
   * a diagnostic did.
   */
  const pointHandle = eventArgs(receipt, 'DefenseSubmitted')?.pointHandle
  if (pointHandle) {
    const started = Date.now()
    try {
      await confidential.decryptForOwner(who.client, pointHandle)
      log(
        'budget',
        `read own Defense Point of ${who.address.slice(0, 8)} took ${((Date.now() - started) / 1000).toFixed(0)}s ` +
          `— sealing only, no FHE arithmetic`,
      )
    } catch (error) {
      warn(`could not time the Defense Point read: ${String(error.message).split('\n')[0]}`)
    }
  }
}

/**
 * Where this defender's `index`-th sensor stands.
 *
 * Two properties are all this needs: every probe a wallet sends is a
 * different cell (or the engine hands back the reading it already paid
 * for), and the two defenders never share one (or the run would be
 * measuring one player's intelligence twice). A row per defender and a
 * column per probe gives both, and stays on any grid the deployment was
 * initialized with.
 */
function sensorCell(who, index, params) {
  const columns = Number(params.gridColumns)
  const rows = Number(params.gridRows)
  const lane = who === alice ? 0 : 1
  return {
    column: index % columns,
    row: (lane + Math.floor(index / columns)) % rows,
  }
}

function buildWorld(params) {
  const sector = params.sectorSpanKm
  const widthKm = params.gridColumns * sector
  const heightKm = params.gridRows * sector
  return {
    widthKm,
    heightKm,
    centerX: widthKm / 2,
    centerY: heightKm + 0.85 * sector,
    radiusKm: 2.3 * sector,
  }
}

/**
 * Where to put an interceptor, given what reconnaissance said.
 *
 * This is the player's decision, made with exactly what a player has: a
 * noisy bearing and nothing else. Without a probe it falls back to straight
 * up, which is a guess — and a guess is allowed to miss. The run asserts
 * that the protocol resolves *consistently*, not that a blind shot lands.
 */
/** Radians as a readable number of degrees. */
function deg(radians) {
  return ((radians * 180) / Math.PI).toFixed(1)
}

function circularMean(bearings) {
  // Angles average as vectors, or 350° and 10° would fuse to 180°.
  const x = bearings.reduce((sum, bearing) => sum + Math.cos(bearing), 0)
  const y = bearings.reduce((sum, bearing) => sum + Math.sin(bearing), 0)
  return Math.atan2(y, x)
}

function aimAlongBearing(world, bearingRadians, fraction) {
  const bearing = bearingRadians ?? -Math.PI / 2
  const reach = world.radiusKm + fraction * (world.centerY - world.radiusKm)
  const x = world.centerX + Math.cos(bearing) * reach
  const y = world.centerY + Math.sin(bearing) * reach
  return {
    x: Math.min(Math.max(x, 0), world.widthKm),
    y: Math.min(Math.max(y, 0), world.heightKm),
  }
}

function fmtKm(wu) {
  return (Number(wu) / Number(WU)).toFixed(0)
}

main().catch((error) => {
  console.error(`\x1b[31m[e2e failed]\x1b[0m ${error.message}`)
  if (optional(env, 'E2E_VERBOSE', 'false') === 'true') console.error(error)
  process.exit(1)
})
