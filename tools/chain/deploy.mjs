#!/usr/bin/env node
/**
 * `npm run chain:deploy` — one command from Solidity source to a working
 * frontend (ТЗ §6, §14).
 *
 * It runs the whole pipeline and stops at the first thing that is not
 * right:
 *
 *   1. read configuration from the environment;
 *   2. compile;
 *   3. run the test suite — an untested implementation never reaches a
 *      network;
 *   4. check the implementation is upgrade-safe;
 *   5. deploy the libraries, the confidential engine, the implementation,
 *      the read lens and the proxy, and initialize;
 *   6. wire the lens and bind the engine;
 *   7. record the deployment manifest, including the storage layout a later
 *      upgrade will be checked against;
 *   8. regenerate the frontend's contract config and ABI.
 *
 * Nothing in that list is a manual step, and none of it writes an address
 * into source code. The single output a human cares about is the manifest,
 * and the frontend reads it rather than being edited to match.
 */

import { execFileSync } from 'node:child_process'
import { createPublicClient, createWalletClient, encodeFunctionData, http, getContract } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  DEFAULT_PROVIDER,
  manifestEntry,
  providerByKind,
  readEngineAddress,
  readRelease,
  resolveProvider,
} from './confidential.mjs'
import {
  CONTRACTS_DIR,
  GAME_PARAMS_ORDER,
  artifact,
  hasLinkReferences,
  latestBuildInfoDir,
  layoutPath,
  linkBytecode,
  eth,
  loadEnv,
  log,
  num,
  ok,
  optional,
  readGameParams,
  readGlobalDefenseInterval,
  readManifest,
  readWithRetry,
  required,
  warn,
  writeJson,
  writeManifest,
} from './lib.mjs'
import { syncFrontend } from './sync-frontend.mjs'
import { verifyDeployment } from './verify.mjs'

/**
 * Every external library `AegylaxGame` links against, in dependency order.
 *
 * Exported because `chain:upgrade` needs the identical list: libraries are
 * linked into the implementation's bytecode, so a release that redeploys the
 * implementation must redeploy all of them or link the new code against the
 * old library at the old address. Keeping two hand-maintained copies is what
 * went wrong — `upgrade.mjs` had three of these four, so an upgrade that
 * changed `Settlement` (as the three-endings release does) would have linked
 * the new game against the previous `Settlement`, whose selectors no longer
 * match. Every refund and settlement would have reverted.
 */
export const LIBRARIES = [
  ['Geometry', 'Geometry.sol'],
  ['ProtocolRules', 'ProtocolRules.sol'],
  ['Resolution', 'Resolution.sol'],
  ['Settlement', 'Settlement.sol'],
  // Depends on Geometry, so it links after it.
  ['Lobbies', 'Lobbies.sol'],
  ['Scoring', 'Scoring.sol'],
]

export function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: CONTRACTS_DIR, stdio: 'inherit', ...options })
}

export function capture(command, args, options = {}) {
  return execFileSync(command, args, { cwd: CONTRACTS_DIR, encoding: 'utf8', ...options })
}

export function build({ skipTests = false } = {}) {
  // A clean build every time: the upgrade-safety validator reads *all* the
  // build-info in the output directory, and a stale copy of a previous
  // compilation makes it refuse to pick a contract at all.
  log('build', 'forge clean && forge build')
  run('forge', ['clean'])
  run('forge', ['build'])

  if (!skipTests) {
    log('test', 'forge test')
    run('forge', ['test'])
  }
}

/**
 * Upgrade safety, checked before anything is deployed rather than after.
 *
 * `@openzeppelin/upgrades-core` reads Foundry's build-info and rejects the
 * things that silently break a proxy: a constructor with state,
 * `selfdestruct`, missing initializers, an unprotected `_authorizeUpgrade`,
 * and storage-layout mistakes in the namespaced struct.
 */
export function validateUpgradeSafety() {
  log('validate', 'upgrade safety (@openzeppelin/upgrades-core)')
  try {
    run('npx', [
      '--yes',
      '@openzeppelin/upgrades-core',
      'validate',
      latestBuildInfoDir(),
      '--contract',
      'AegylaxGame',
      // The three linked libraries hold no storage of their own: Geometry
      // and ProtocolRules are pure, and Resolution only writes through
      // storage references the game hands it. They are also redeployed and
      // relinked with every implementation, so an upgrade can never leave
      // one behind. That is the manual check this flag stands for — it is
      // not a way of skipping the validation, which still runs on
      // everything else.
      '--unsafeAllowLinkedLibraries',
    ])
    ok('implementation is upgrade-safe')
  } catch (error) {
    throw new Error('Upgrade safety validation failed — refusing to deploy.')
  }
}

export function storageLayoutOf(contractName, fileName) {
  const compiled = artifact(contractName, fileName)
  if (!compiled.storageLayout) {
    throw new Error(`No storageLayout in ${contractName} artifact — set extra_output = ["storageLayout"] in foundry.toml`)
  }
  return compiled.storageLayout
}

/**
 * Reads a provider's own contract address off a deployed engine.
 *
 * Each adapter exposes one — Inco's executor, CoFHE's TaskManager — and the
 * getter's name is a field of the provider row, so nothing here knows which
 * provider it is reading from.
 */
async function readProviderExecutor(publicClient, engineAddress, getter) {
  return readWithRetry(() => readEngineAddress(publicClient, engineAddress, getter), { label: `${getter}()` })
}

/**
 * Sends a transaction and insists it actually succeeded.
 *
 * A mined receipt is not a successful one: a reverted transaction is mined
 * like any other, and a pipeline that only waits for the receipt reports a
 * deployment as complete while the wiring it just performed did not happen.
 * Every write in this file goes through here.
 */
export async function sendAndConfirm(publicClient, hashPromise, label) {
  const hash = await hashPromise
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    throw new Error(`${label} reverted on chain (tx ${hash})`)
  }
  return receipt
}

async function deployContract(wallet, publicClient, { abi, bytecode, args = [], name }) {
  const receipt = await sendAndConfirm(publicClient, wallet.deployContract({ abi, bytecode, args }), `deploy ${name}`)
  if (!receipt.contractAddress) throw new Error(`Deployment of ${name} produced no address`)

  // A receipt proves the deployment was mined; it does not prove the RPC
  // endpoint you are about to call will *see* it. Public endpoints are
  // several nodes behind one address, and the next transaction — a proxy
  // whose constructor calls this implementation, or a wiring call — fails
  // with an unexplained revert if it lands on one that is behind.
  await readWithRetry(
    async () => {
      const code = await publicClient.getCode({ address: receipt.contractAddress })
      if (!code || code === '0x') throw new Error('no code yet')
      return code
    },
    { label: `${name} code visibility` },
  )

  ok(`${name} -> ${receipt.contractAddress}`)
  return { address: receipt.contractAddress, blockNumber: receipt.blockNumber, hash: receipt.transactionHash }
}

/**
 * Identifies a reused engine so it can be bound and checked like a fresh one.
 *
 * `engineKind()` is the adapter naming itself, which is the only honest
 * source: an address supplied by an operator says nothing about which
 * confidential network is behind it, and picking wrong here means funding
 * the wrong thing and writing the wrong provider into the manifest.
 */
async function detectEngineProvider(publicClient, engineAddress) {
  try {
    const kind = await readWithRetry(
      () =>
        publicClient.readContract({
          address: engineAddress,
          abi: [
            {
              type: 'function',
              name: 'engineKind',
              stateMutability: 'pure',
              inputs: [],
              outputs: [{ name: '', type: 'string' }],
            },
          ],
          functionName: 'engineKind',
        }),
      { attempts: 3, label: 'engineKind()' },
    )
    return providerByKind(kind)
  } catch {
    return null
  }
}

async function main() {
  const env = loadEnv()

  const chainId = num(env, 'CHAIN_ID')
  const rpcUrl = required(env, 'RPC_URL')
  const explorerUrl = optional(env, 'EXPLORER_URL', '')
  const networkName = optional(env, 'NETWORK_NAME', `chain-${chainId}`)
  const account = privateKeyToAccount(required(env, 'DEPLOYER_PRIVATE_KEY'))
  const owner = optional(env, 'OWNER_ADDRESS', account.address)
  const params = readGameParams(env)

  // Which confidential network holds this deployment's secrets. Everything
  // that used to be an `if (inco)` in this file is a field of `provider`.
  const selection = resolveProvider(env)
  let provider = selection.provider
  let release = selection.release
  log('config', `${networkName} (chain ${chainId}) as ${account.address}`)
  log('config', `confidential layer: ${provider ? `${provider.label} (${release ?? 'no release'})` : `reusing ${selection.reuse}`}`)

  // Before anything is compiled: a provider whose release is a compile-time
  // choice (Inco links one executor per pepper) has to make it here rather
  // than have it discovered after the artifacts are already on disk.
  provider?.prepareBuild(release)

  build({ skipTests: optional(env, 'SKIP_TESTS', 'false') === 'true' })
  validateUpgradeSafety()

  const chain = { id: chainId, name: networkName, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } }
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })

  const onChainId = await publicClient.getChainId()
  if (onChainId !== chainId) {
    throw new Error(`RPC reports chain ${onChainId} but CHAIN_ID says ${chainId} — refusing to deploy to the wrong network.`)
  }

  // --- libraries ---------------------------------------------------------
  log('deploy', 'libraries')
  // Deployed in dependency order and linked as they go: ProtocolRules and
  // Resolution both call into Geometry, so their own bytecode carries
  // placeholders that have to be filled with a real address first.
  const libraries = {}
  for (const [name, file] of LIBRARIES) {
    const compiled = artifact(name, file)
    const bytecode = hasLinkReferences(compiled) ? linkBytecode(compiled, libraries).bytecode : compiled.bytecode.object
    const deployed = await deployContract(wallet, publicClient, { abi: compiled.abi, bytecode, name })
    libraries[name] = deployed.address
  }

  // --- confidential engine ----------------------------------------------
  log('deploy', `confidential engine (${provider?.label ?? selection.reuse})`)
  let engineAddress = selection.reuse

  if (engineAddress) {
    // An address says nothing about what is behind it; the adapter does.
    provider = (await detectEngineProvider(publicClient, engineAddress)) ?? provider
    release = readRelease(env, provider)
    ok(`reusing ${provider?.contract ?? 'engine'} at ${engineAddress}`)
  } else {
    if (provider.id === 'mock' && optional(env, 'ALLOW_MOCK_ENGINE', 'false') !== 'true') {
      throw new Error(
        'CONFIDENTIAL_ENGINE=mock stores every secret in plain storage and is for local development only. ' +
          'Set ALLOW_MOCK_ENGINE=true if that is genuinely what you want.',
      )
    }
    const compiled = artifact(provider.contract, `${provider.contract}.sol`)
    const deployed = await deployContract(wallet, publicClient, {
      abi: compiled.abi,
      bytecode: compiled.bytecode.object,
      args: [owner],
      name: provider.contract,
    })
    engineAddress = deployed.address
  }

  const engineContractName = provider?.contract ?? null

  /*
   * The confidential network the engine was built against is part of that
   * network's identity, and a mismatch is invisible until the first probe
   * fails. Each provider says what "consistent" means for it — Inco compares
   * the linked executor against the pepper's quorum, CoFHE checks the
   * TaskManager is actually on this chain — so the check happens here rather
   * than at some player's first Recon Probe.
   */
  if (provider) {
    await provider.assertConsistent({
      publicClient,
      engineAddress,
      chainId,
      release,
      readAddress: (client, address, getter) => readProviderExecutor(client, address, getter),
      warn,
      ok,
    })
  }

  // --- implementation, lens, proxy --------------------------------------
  log('deploy', 'implementation')
  const gameArtifact = artifact('AegylaxGame')
  if (!hasLinkReferences(gameArtifact)) warn('AegylaxGame reports no library references — check the build')
  const { bytecode: gameBytecode, linked } = linkBytecode(gameArtifact, libraries)
  const implementation = await deployContract(wallet, publicClient, {
    abi: gameArtifact.abi,
    bytecode: gameBytecode,
    name: 'AegylaxGame (implementation)',
  })

  const lensArtifact = artifact('AegylaxLens')
  const lens = await deployContract(wallet, publicClient, {
    abi: lensArtifact.abi,
    bytecode: lensArtifact.bytecode.object,
    name: 'AegylaxLens',
  })

  log('deploy', 'proxy + initialize')
  const genesisBlock = num(env, 'GENESIS_BLOCK', 0)
  const initCalldata = encodeFunctionData({
    abi: gameArtifact.abi,
    functionName: 'initialize',
    args: [owner, engineAddress, params, BigInt(genesisBlock)],
  })
  const proxyArtifact = artifact('ERC1967Proxy', 'ERC1967Proxy.sol')
  const proxy = await deployContract(wallet, publicClient, {
    abi: proxyArtifact.abi,
    bytecode: proxyArtifact.bytecode.object,
    args: [implementation.address, initCalldata],
    name: 'ERC1967Proxy',
  })

  // --- wiring ------------------------------------------------------------
  log('wire', 'lens + engine binding')
  const game = getContract({ address: proxy.address, abi: gameArtifact.abi, client: wallet })
  await sendAndConfirm(publicClient, game.write.setLens([lens.address]), 'setLens')
  // Read it back: the whole read surface hangs off this pointer, and a
  // deployment that silently lost it answers nothing.
  await readWithRetry(() => game.read.getLens(), {
    label: 'lens registration',
    accept: (value) => String(value).toLowerCase() === lens.address.toLowerCase(),
  })
  ok('lens registered on the proxy')

  /*
   * The draw cadence, which `initialize()` does not take.
   *
   * It is not one of the `GameParams`: those are snapshotted onto every
   * lobby and packed inline, and how often the protocol plays for its own
   * pool is neither a rule an operation runs under nor a field that struct
   * has room for. It has its own slot and its own setter — which meant that
   * for four deployments nobody called it, the slot stayed zero, and
   * `openGlobalDefense` did nothing on a keeper that sent it every thirty
   * seconds. Nothing reverted and nothing logged; the pool just filled with
   * ETH there was no draw to play for.
   *
   * So it is set here, next to the lens, and read back for the same reason
   * the lens is: a wiring step that can fail silently has to be checked out
   * loud.
   */
  const drawInterval = readGlobalDefenseInterval(env)
  if (drawInterval > 0) {
    log('wire', `global defense every ${drawInterval} epochs`)
    await sendAndConfirm(publicClient, game.write.setGlobalDefenseInterval([drawInterval]), 'setGlobalDefenseInterval')
    const lensReader = getContract({ address: proxy.address, abi: lensArtifact.abi, client: publicClient })
    await readWithRetry(() => lensReader.read.getGlobalDefenseDraw(), {
      label: 'global defense interval',
      accept: (draw) => Number(draw[1]) === drawInterval,
    })
    ok(`global defense draw opens every ${drawInterval} epochs`)
  } else {
    // A deliberate zero is allowed — it is how the draw is turned off — but
    // it is indistinguishable on chain from the bug above, so say it.
    warn('GAME_GLOBAL_DEFENSE_EPOCH_INTERVAL is 0: the Global Defense draw is disabled on this deployment')
  }

  if (engineContractName) {
    const engineArtifact = artifact(engineContractName, `${engineContractName}.sol`)
    const engine = getContract({ address: engineAddress, abi: engineArtifact.abi, client: wallet })
    const boundTo = await readWithRetry(() => engine.read.game(), { label: 'engine.game()' })

    if (boundTo === '0x0000000000000000000000000000000000000000') {
      await sendAndConfirm(publicClient, engine.write.setGame([proxy.address]), 'engine.setGame')
      ok('engine bound to the proxy — permanently')
    } else if (boundTo.toLowerCase() === proxy.address.toLowerCase()) {
      ok('engine was already bound to this proxy')
    } else {
      // The binding is deliberately one-way: an engine that could be
      // re-pointed could be made to hand a player's private reading to a
      // different contract.
      throw new Error(
        `Engine ${engineAddress} is already bound to ${boundTo} and cannot be re-bound. ` +
          `Deploy a fresh engine (CONFIDENTIAL_ENGINE=${DEFAULT_PROVIDER}) for this proxy.`,
      )
    }
  } else {
    warn('engine was supplied by address and is of an unknown kind; bind it with setGame() yourself')
  }

  // --- engine funding ----------------------------------------------------
  // Some providers charge per confidential operation out of the engine's own
  // balance, and there an unfunded engine is a protocol that cannot start an
  // attack — so funding it is part of bringing a deployment up rather than
  // an afterthought a first player discovers. Others (CoFHE) bill it as gas
  // on the calling transaction and need nothing here; `needsFunding` is the
  // provider saying which it is.
  const engineFunding = eth(env, 'ENGINE_FUNDING_ETH', '0')
  if (engineFunding > 0n && provider?.needsFunding) {
    log('fund', `confidential engine with ${Number(engineFunding) / 1e18} ETH`)
    await sendAndConfirm(publicClient, wallet.sendTransaction({ to: engineAddress, value: engineFunding }), 'fund engine')
    const balance = await readWithRetry(() => publicClient.getBalance({ address: engineAddress }), {
      label: 'engine balance',
      accept: (value) => value > 0n,
    })
    ok(`engine balance ${Number(balance) / 1e18} ETH`)
  }

  // --- manifest ----------------------------------------------------------
  const version = await publicClient.readContract({
    address: proxy.address,
    abi: gameArtifact.abi,
    functionName: 'version',
  })

  const manifest = {
    name: 'aegylax',
    network: networkName,
    chainId,
    version,
    proxy: proxy.address,
    implementation: implementation.address,
    lens: lens.address,
    confidentialEngine: manifestEntry({
      provider,
      release,
      address: engineAddress,
      executor: provider?.executorGetter
        ? await readProviderExecutor(publicClient, engineAddress, provider.executorGetter)
        : null,
    }),
    libraries,
    owner,
    deploymentBlock: Number(proxy.blockNumber),
    genesisBlock: Number(
      await publicClient.readContract({
        address: proxy.address,
        abi: lensArtifact.abi,
        functionName: 'genesisBlock',
      }),
    ),
    deploymentTx: proxy.hash,
    // Recorded so `chain:verify` can reproduce the proxy's constructor
    // arguments exactly rather than guessing at them later.
    initCalldata,
    deployedAt: new Date().toISOString(),
    explorer: { url: explorerUrl },
    rpcUrl: optional(env, 'PUBLIC_RPC_URL', ''),
    params: GAME_PARAMS_ORDER.reduce((acc, key) => ({ ...acc, [key]: String(params[key]) }), {}),
    // Beside `params`, not inside them: on chain it is its own slot with its
    // own setter, and the frontend reads it from here so a countdown cannot
    // point at an epoch the contract has no draw for.
    globalDefenseEpochInterval: drawInterval,
    history: [
      {
        version,
        implementation: implementation.address,
        block: Number(implementation.blockNumber),
        at: new Date().toISOString(),
        kind: 'deploy',
      },
    ],
  }

  log('manifest', writeManifest(chainId, manifest))
  writeJson(layoutPath(chainId), storageLayoutOf('AegylaxGame'))
  ok('storage layout recorded for future upgrade checks')

  syncFrontend(chainId)
  await verifyDeployment({ env, waitMs: 25_000 })
  log('done', `proxy ${proxy.address} — run "npm run build" to ship a frontend against it`)
}

// `upgrade.mjs` imports the build/validate steps from here, so the
// deployment itself only runs when this file is the entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`\x1b[31m[failed]\x1b[0m ${error.message}`)
    process.exit(1)
  })
}
