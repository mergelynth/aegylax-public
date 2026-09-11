#!/usr/bin/env node
/**
 * `npm run chain:upgrade` — a new implementation behind the same proxy
 * (ТЗ §6, §7).
 *
 * The proxy address never changes, so nothing downstream has to: players
 * keep their operations, the frontend keeps its address, and the manifest
 * gains a history entry. What the command spends its effort on is refusing
 * to perform an upgrade that would break any of that.
 *
 * Two checks stand between a build and the network, and both run before a
 * transaction is sent:
 *
 *   - **upgrade safety** — no constructor state, no `selfdestruct`, an
 *     initializer that cannot be re-run;
 *   - **storage layout compatibility** — checked against the layout recorded
 *     when the *deployed* implementation went out, not against whatever
 *     happens to be in the working tree. A field reordered, retyped or
 *     removed is caught here rather than by a player whose reward pool
 *     turned into a block number.
 */

import { createPublicClient, createWalletClient, getContract, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync, existsSync } from 'node:fs'
import { assertStorageUpgradeSafe } from '@openzeppelin/upgrades-core'
import {
  artifact,
  eth,
  hasLinkReferences,
  layoutPath,
  linkBytecode,
  loadEnv,
  log,
  num,
  ok,
  optional,
  readManifest,
  required,
  warn,
  writeJson,
  writeManifest,
} from './lib.mjs'
import { build, validateUpgradeSafety, storageLayoutOf, LIBRARIES, sendAndConfirm } from './deploy.mjs'
import {
  manifestEntry,
  providerByContract,
  providerByKind,
  readEngineAddress,
  readRelease,
  resolveProvider,
} from './confidential.mjs'
import { syncFrontend } from './sync-frontend.mjs'
import { verifyDeployment } from './verify.mjs'

/**
 * Blocks until `address` reports code on the endpoint being used.
 *
 * See the call site for why an upgrade cannot be sent without it. Bounded,
 * because an implementation that is still absent after this long is not a
 * lagging node — it is a deployment that did not happen, and waiting forever
 * would hide that.
 */
async function waitForCode(publicClient, address, { attempts = 20, delayMs = 3000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const code = await publicClient.getCode({ address })
      if (code && code !== '0x') return
    } catch {
      // A lagging node can throw here too; it is the same wait.
    }
    if (attempt === 1) log('wait', `implementation ${address} to be visible on the RPC`)
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  throw new Error(
    `Implementation ${address} deployed but never became visible on the RPC. ` +
      'Re-run the upgrade, or point RPC_URL at a single node rather than a load-balanced endpoint.',
  )
}

/**
 * The check that actually protects live state.
 *
 * `assertStorageUpgradeSafe` is the same comparison the OpenZeppelin
 * Hardhat/Foundry plugins run; feeding it the layout stored at deploy time
 * is what makes it work across separate builds, machines and months.
 */
function assertLayoutCompatible(chainId, nextLayout) {
  const path = layoutPath(chainId)
  if (!existsSync(path)) {
    throw new Error(
      `No recorded storage layout for chain ${chainId} (${path}). ` +
        'An upgrade cannot be proven safe without the layout of the implementation currently deployed.',
    )
  }
  const previous = JSON.parse(readFileSync(path, 'utf8'))
  assertStorageUpgradeSafe(previous, nextLayout, { unsafeAllowCustomTypes: false })
  ok('storage layout is compatible with the deployed implementation')
}

async function main() {
  const env = loadEnv()

  const chainId = num(env, 'CHAIN_ID')
  const rpcUrl = required(env, 'RPC_URL')
  const account = privateKeyToAccount(required(env, 'DEPLOYER_PRIVATE_KEY'))
  const manifest = readManifest(chainId)
  if (!manifest) throw new Error(`No deployment on chain ${chainId} to upgrade. Run "npm run chain:deploy".`)

  log('config', `upgrading ${manifest.proxy} on ${manifest.network} (chain ${chainId})`)

  /*
   * Which confidential provider this deployment runs.
   *
   * The manifest is the authority, not `CONFIDENTIAL_ENGINE`: an upgrade
   * replaces the engine in place and re-points the proxy at it, so a
   * pipeline whose `.env` has drifted to a different provider would
   * otherwise silently move a live deployment onto a network that cannot
   * open any of its in-flight handles. Setting `CONFIDENTIAL_ENGINE`
   * deliberately still works — it is how a deployment *is* migrated — and
   * then the round in flight is the operator's problem to time.
   */
  const provider =
    resolveProvider(env).provider ?? providerByKind(manifest.confidentialEngine?.kind) ??
    providerByContract(manifest.confidentialEngine?.contract)
  const release =
    readRelease(env, provider) ?? manifest.confidentialEngine?.release ?? manifest.confidentialEngine?.pepper ?? null
  if (provider?.kind !== manifest.confidentialEngine?.kind) {
    warn(
      `Migrating the confidential layer: ${manifest.confidentialEngine?.kind ?? 'unknown'} -> ${provider?.kind}. ` +
        'Handles minted by the old engine can only be revealed through it — finish rounds in flight first.',
    )
  }
  // A provider whose release is a compile-time choice has to make it before
  // anything is built.
  provider?.prepareBuild(release)

  build({ skipTests: optional(env, 'SKIP_TESTS', 'false') === 'true' })
  validateUpgradeSafety()
  assertLayoutCompatible(chainId, storageLayoutOf('AegylaxGame'))

  const chain = {
    id: chainId,
    name: manifest.network,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  }
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) })

  const onChainId = await publicClient.getChainId()
  if (onChainId !== chainId) throw new Error(`RPC reports chain ${onChainId}, manifest says ${chainId}`)

  // Libraries are redeployed with the implementation: they are linked into
  // its bytecode, so an implementation that shares a library with its
  // predecessor would silently keep the old code.
  log('deploy', 'libraries')
  const libraries = {}
  for (const [name, file] of LIBRARIES) {
    const compiled = artifact(name, file)
    // Linked in dependency order, as at deploy time.
    const libBytecode = hasLinkReferences(compiled) ? linkBytecode(compiled, libraries).bytecode : compiled.bytecode.object
    const hash = await wallet.deployContract({ abi: compiled.abi, bytecode: libBytecode })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    libraries[name] = receipt.contractAddress
    ok(`${name} -> ${receipt.contractAddress}`)
  }

  log('deploy', 'implementation')
  const gameArtifact = artifact('AegylaxGame')
  if (!hasLinkReferences(gameArtifact)) warn('AegylaxGame reports no library references — check the build')
  const { bytecode, linked } = linkBytecode(gameArtifact, libraries)
  const implHash = await wallet.deployContract({ abi: gameArtifact.abi, bytecode })
  const implReceipt = await publicClient.waitForTransactionReceipt({ hash: implHash })
  const implementation = implReceipt.contractAddress
  ok(`implementation -> ${implementation}`)

  /*
   * Wait until the *endpoint* can see the implementation, not just the node
   * that mined it.
   *
   * A public RPC URL is a load balancer over many nodes, and a receipt only
   * proves the deployment landed on whichever one answered. UUPS makes that
   * gap fatal rather than merely annoying: `upgradeToAndCall` calls
   * `proxiableUUID()` on the address it is given, and a node that has not yet
   * seen the deployment sees an address with no code, so the call reverts.
   *
   * The failure is maximally confusing, which is why this is worth the wait.
   * Nothing is wrong — the implementation is deployed, upgrade-safe and
   * storage-compatible, all three checks having just passed — and the error
   * is a bare "execution reverted" against a proxy whose owner is
   * demonstrably the sender. Re-running the command a minute later succeeds
   * and teaches nobody anything, at the cost of redeploying five libraries
   * and an implementation.
   */
  await waitForCode(publicClient, implementation)

  log('upgrade', 'upgradeToAndCall')
  const game = getContract({ address: manifest.proxy, abi: gameArtifact.abi, client: wallet })
  const upgradeHash = await game.write.upgradeToAndCall([implementation, '0x'])
  await publicClient.waitForTransactionReceipt({ hash: upgradeHash })
  ok(`proxy ${manifest.proxy} now runs ${implementation}`)

  // The read facet is a separate deployed contract, so a release that
  // changes the read surface has to replace it too.
  if (optional(env, 'UPGRADE_LENS', 'true') === 'true') {
    const lensArtifact = artifact('AegylaxLens')
    const lensHash = await wallet.deployContract({ abi: lensArtifact.abi, bytecode: lensArtifact.bytecode.object })
    const lensReceipt = await publicClient.waitForTransactionReceipt({ hash: lensHash })
    await publicClient.waitForTransactionReceipt({ hash: await game.write.setLens([lensReceipt.contractAddress]) })
    manifest.lens = lensReceipt.contractAddress
    ok(`lens -> ${lensReceipt.contractAddress}`)
  }

  // Probe delay + ε live in the engine. It is not UUPS: replace it, bind
  // it to this proxy, then point the game at the new address. In-flight
  // handles stay on the previous engine — finish those rounds first on a
  // live network, or accept that their reveal goes through the old adapter.
  if (optional(env, 'UPGRADE_ENGINE', 'true') === 'true') {
    const engineName = provider?.contract ?? manifest.confidentialEngine?.contract
    if (!engineName) {
      throw new Error(
        'The manifest names no confidential engine contract and CONFIDENTIAL_ENGINE is unset — ' +
          'cannot tell which adapter to redeploy.',
      )
    }
    const engineArtifact = artifact(engineName, `${engineName}.sol`)
    const owner = manifest.owner
    log('deploy', `confidential engine (${engineName})`)
    const engineHash = await wallet.deployContract({
      abi: engineArtifact.abi,
      bytecode: engineArtifact.bytecode.object,
      args: [owner],
    })
    const engineReceipt = await publicClient.waitForTransactionReceipt({ hash: engineHash })
    const engineAddress = engineReceipt.contractAddress
    await waitForCode(publicClient, engineAddress)
    ok(`engine -> ${engineAddress}`)

    const engine = getContract({ address: engineAddress, abi: engineArtifact.abi, client: wallet })
    await sendAndConfirm(publicClient, engine.write.setGame([manifest.proxy]), 'engine.setGame')
    await sendAndConfirm(publicClient, game.write.setEngine([engineAddress]), 'setEngine')

    const engineFunding = eth(env, 'ENGINE_FUNDING_ETH', '0')
    if (engineFunding > 0n && provider?.needsFunding) {
      log('fund', `new engine with ${Number(engineFunding) / 1e18} ETH`)
      await sendAndConfirm(
        publicClient,
        wallet.sendTransaction({ to: engineAddress, value: engineFunding }),
        'fund engine',
      )
    }

    manifest.confidentialEngine = {
      ...manifest.confidentialEngine,
      ...manifestEntry({
        provider,
        release,
        address: engineAddress,
        executor: provider?.executorGetter
          ? await readEngineAddress(publicClient, engineAddress, provider.executorGetter)
          : null,
      }),
    }
    ok(`game now uses engine ${engineAddress}`)
  }

  const version = await publicClient.readContract({
    address: manifest.proxy,
    abi: gameArtifact.abi,
    functionName: 'version',
  })

  manifest.version = version
  manifest.implementation = implementation
  manifest.libraries = libraries
  manifest.upgradedAt = new Date().toISOString()
  manifest.history = [
    ...(manifest.history ?? []),
    {
      version,
      implementation,
      block: Number(implReceipt.blockNumber),
      at: manifest.upgradedAt,
      kind: 'upgrade',
      tx: upgradeHash,
    },
  ]

  log('manifest', writeManifest(chainId, manifest))
  writeJson(layoutPath(chainId), storageLayoutOf('AegylaxGame'))
  syncFrontend(chainId)
  await verifyDeployment({ env, waitMs: 25_000 })
  log('done', `version ${version} live at the same address — run "npm run build"`)
}

main().catch((error) => {
  console.error(`\x1b[31m[failed]\x1b[0m ${error.message}`)
  process.exit(1)
})
