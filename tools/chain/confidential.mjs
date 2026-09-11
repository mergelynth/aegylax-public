/**
 * Which confidential network a deployment runs on, as data rather than as
 * branches.
 *
 * The protocol's coupling to a confidential provider is one interface
 * (`IConfidentialEngine`) and one adapter contract behind it, so switching
 * providers ought to be a `.env` change. It stopped being one in the
 * pipeline: the deployer knew Inco by name in five places — which Solidity
 * library to remap before compiling, which contract to deploy, which
 * getter names the provider's own contract, whether the engine has to be
 * funded, and what to write into the manifest — and every one of those was
 * an `if`.
 *
 * This is that knowledge as a table. `CONFIDENTIAL_ENGINE` picks a row;
 * nothing downstream of `resolveProvider` mentions a provider by name.
 * Adding a third one is a row here, an `IConfidentialEngine` implementation
 * in `contracts/src/confidential/`, and a `ConfidentialGateway` in
 * `frontend/src/blockchain/contract/confidential/providers/` — and nothing else.
 */

import { optional } from './lib.mjs'
import { selectIncoLib } from './inco.mjs'

/** CoFHE's TaskManager, linked as a compile-time constant of `FHE.sol`. */
const COFHE_TASK_MANAGER = '0xeA30c4B8b44078Bbf8a6ef5b9f1eC1626C7848D9'

const ADDRESS_GETTER_ABI = (name) => [
  { type: 'function', name, stateMutability: 'pure', inputs: [], outputs: [{ name: '', type: 'address' }] },
]

export const PROVIDERS = {
  /**
   * Fhenix CoFHE — the default for a fresh deployment.
   *
   * Nothing is selected at compile time: CoFHE links one TaskManager address
   * on every chain it supports, so unlike an Inco pepper there is no library
   * remapping to get right and no executor for the artifacts to be out of
   * step with. Which CoFHE *deployment* the client talks to is still a
   * choice, and it is `release` — the environment name the client resolves
   * its coprocessor, ZK verifier and threshold network from.
   */
  fhenix: {
    id: 'fhenix',
    kind: 'fhenix-cofhe',
    contract: 'FhenixConfidentialEngine',
    label: 'Fhenix CoFHE',
    releaseEnv: 'COFHE_ENVIRONMENT',
    defaultRelease: 'TESTNET',
    releases: ['MAINNET', 'TESTNET', 'LOCAL', 'MOCK'],
    /**
     * CoFHE bills confidential work as host-chain gas on the calling
     * transaction, so the engine holds no balance and needs no funding. Inco
     * charges a per-operation fee out of the engine's own ETH, which is why
     * this is a property of the provider rather than a step in the deployer.
     */
    needsFunding: false,
    executorGetter: 'cofheTaskManager',
    prepareBuild() {},
    /**
     * Refuses a deployment to a chain CoFHE is not on.
     *
     * The failure this catches is quiet and total: the TaskManager address
     * is a constant, so an engine deployed to a chain without one compiles,
     * deploys and binds fine, and the first `startAttack` reverts inside a
     * library call for no visible reason. Code at the address is the whole
     * check — if it is there, this is a CoFHE chain.
     */
    async assertConsistent({ publicClient, engineAddress, chainId, readAddress, warn, ok }) {
      const taskManager = await readAddress(publicClient, engineAddress, 'cofheTaskManager')
      if (taskManager.toLowerCase() !== COFHE_TASK_MANAGER.toLowerCase()) {
        warn(`Engine reports TaskManager ${taskManager}, not the ${COFHE_TASK_MANAGER} this build expects.`)
      }
      const code = await publicClient.getCode({ address: taskManager })
      if (!code || code === '0x') {
        throw new Error(
          `No CoFHE TaskManager at ${taskManager} on chain ${chainId}. Fhenix CoFHE is not deployed to this ` +
            'network — pick a chain it supports, or set CONFIDENTIAL_ENGINE to another provider.',
        )
      }
      ok(`CoFHE TaskManager ${taskManager} is live on chain ${chainId}`)
    },
  },

  /**
   * Inco Lightning — the provider AEGYLAX shipped on, kept as a supported
   * alternative rather than removed.
   *
   * Its release *is* a compile-time choice: each pepper links a different
   * executor into the Solidity library, and the client SDK resolves the
   * matching covalidator quorum from the same name. Getting the two out of
   * step produces handles nothing can decrypt, silently, so the remapping is
   * written before anything is compiled and the result is checked back off
   * the chain afterwards.
   */
  inco: {
    id: 'inco',
    kind: 'inco-lightning',
    contract: 'IncoConfidentialEngine',
    label: 'Inco Lightning',
    /*
     * Off by decision, not by rot.
     *
     * AEGYLAX is going to Fhenix CoFHE only, so nothing in the pipeline may
     * select this row: `resolveProvider` refuses it and `providerIds` stops
     * offering it. Everything below still works and is still tested — the
     * adapter contract, the client gateway, the executor check — because the
     * cost of keeping a second implementation compiling is a line in a table
     * and the cost of deleting it is never being able to check the boundary
     * again.
     *
     * Re-enabling is deleting this one field.
     */
    disabled:
      'Inco Lightning is switched off in this build — AEGYLAX runs on Fhenix CoFHE. ' +
      'Remove `disabled` from the inco row in tools/chain/confidential.mjs to bring it back.',
    releaseEnv: 'INCO_PEPPER',
    defaultRelease: 'devnet',
    releases: ['mainnet', 'testnet', 'devnet', 'demonet', 'alphanet'],
    needsFunding: true,
    executorGetter: 'incoExecutor',
    prepareBuild(release) {
      selectIncoLib(release)
    },
    async assertConsistent({ publicClient, engineAddress, chainId, release, readAddress, warn, ok }) {
      const onChain = await readAddress(publicClient, engineAddress, 'incoExecutor')

      let expected
      try {
        // Through `createRequire` rather than `import`: the published ESM
        // build of @inco/js has extensionless internal specifiers, which a
        // bundler resolves and Node does not. The CJS build is the same code.
        const { createRequire } = await import('node:module')
        const { Lightning } = createRequire(import.meta.url)('@inco/js/lite')
        expected = Lightning.latestDeployment(release, chainId)?.executorAddress
      } catch (error) {
        warn(`Could not check the Inco executor against the SDK (${error.message}) — continuing unverified.`)
        return
      }

      if (!expected) {
        warn(`The SDK knows no "${release}" Inco deployment on chain ${chainId} — continuing unverified.`)
        return
      }
      if (onChain.toLowerCase() !== expected.toLowerCase()) {
        throw new Error(
          `Inco mismatch: the engine links executor ${onChain}, but @inco/js resolves ${expected} for pepper ` +
            `"${release}" on chain ${chainId}. Set INCO_PEPPER to the release this network runs.`,
        )
      }
      ok(`Inco executor ${onChain} matches the "${release}" deployment`)
    },
  },

  /**
   * Plain storage. **Not confidential** — every secret is publicly readable,
   * and the deployer refuses to point a public network at it without
   * `ALLOW_MOCK_ENGINE=true`.
   */
  mock: {
    id: 'mock',
    kind: 'mock',
    contract: 'MockConfidentialEngine',
    label: 'Mock engine (no confidentiality)',
    releaseEnv: null,
    defaultRelease: null,
    releases: [],
    needsFunding: false,
    executorGetter: null,
    prepareBuild() {},
    async assertConsistent() {},
  },
}

/** The default when `CONFIDENTIAL_ENGINE` is unset. */
export const DEFAULT_PROVIDER = 'fhenix'

/** Providers a deployment may actually select. Disabled rows are not on offer. */
export function providerIds() {
  return Object.keys(PROVIDERS).filter((id) => !PROVIDERS[id].disabled)
}

export function providerByKind(kind) {
  return Object.values(PROVIDERS).find((provider) => provider.kind === kind) ?? null
}

export function providerByContract(contract) {
  return Object.values(PROVIDERS).find((provider) => provider.contract === contract) ?? null
}

/**
 * Resolves `CONFIDENTIAL_ENGINE` into a provider and the release it runs.
 *
 * `0x…` is not a provider: it is an instruction to reuse an engine that is
 * already deployed, and which provider that engine *is* has to be read off
 * the chain (`engineKind()`), not guessed from configuration. Callers get
 * `reuse` and resolve the rest after they can make a call.
 */
export function resolveProvider(env) {
  const setting = optional(env, 'CONFIDENTIAL_ENGINE', DEFAULT_PROVIDER)
  if (setting.startsWith('0x')) return { reuse: setting, provider: null, release: null }

  const provider = PROVIDERS[setting]
  if (!provider) {
    throw new Error(
      `Unknown CONFIDENTIAL_ENGINE "${setting}". Expected one of: ${providerIds().join(', ')}, or an 0x address to reuse.`,
    )
  }
  /*
   * A disabled provider fails here rather than three steps later inside
   * `assertConsistent`, because the answer is not "this network is wrong"
   * but "this build does not deploy that any more" — and the two want very
   * different next moves from whoever is reading.
   */
  if (provider.disabled) throw new Error(provider.disabled)
  return { reuse: null, provider, release: readRelease(env, provider) }
}

/**
 * Which deployment of the provider's network to use.
 *
 * Each provider names this differently in the environment — `INCO_PEPPER`,
 * `COFHE_ENVIRONMENT` — because an operator setting it is thinking in that
 * provider's vocabulary. `CONFIDENTIAL_RELEASE` overrides either, so a
 * pipeline that does not care which provider it is deploying still has one
 * variable to set.
 */
export function readRelease(env, provider) {
  if (!provider?.releaseEnv) return null
  const release = optional(env, 'CONFIDENTIAL_RELEASE', '') || optional(env, provider.releaseEnv, provider.defaultRelease)
  if (provider.releases.length > 0 && !provider.releases.includes(release)) {
    throw new Error(
      `Unknown ${provider.label} release "${release}". Expected one of: ${provider.releases.join(', ')}.`,
    )
  }
  return release
}

/** Reads an address-returning getter off a deployed engine. */
export async function readEngineAddress(publicClient, engineAddress, getter) {
  return publicClient.readContract({
    address: engineAddress,
    abi: ADDRESS_GETTER_ABI(getter),
    functionName: getter,
  })
}

/**
 * The manifest's record of the confidential layer.
 *
 * `release` is the field the client reads; `pepper` is written alongside it
 * for Inco deployments only, because tooling and manifests predating the
 * rename still look for it.
 */
export function manifestEntry({ provider, release, address, executor, services = null }) {
  const entry = {
    kind: provider?.kind ?? 'unknown',
    address,
    contract: provider?.contract ?? null,
    release,
    executor: executor ?? null,
  }
  if (provider?.id === 'inco') entry.pepper = release
  if (services) entry.services = services
  return entry
}
