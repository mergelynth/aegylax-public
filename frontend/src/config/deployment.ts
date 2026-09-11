import {
  AEGYLAX_ABI,
  AEGYLAX_DEPLOYMENTS,
  getGeneratedDeployment,
  type GeneratedParams,
} from '../contracts/generated'
import type { Address } from '../game/types'

/**
 * Which deployment this build talks to (ТЗ §8, §9).
 *
 * There are two sources and a strict order between them. The generated
 * manifest is the *record of what was actually deployed* — written by
 * `npm run chain:deploy`, never by hand — and it is the default for every
 * network it knows about. ENV can override any field on top of it, which is
 * what makes a local node, a fork or a one-off contract address possible
 * without regenerating anything.
 *
 * What there is no third source for is a hardcoded address. Nothing in
 * `frontend/src/` outside `contracts/generated/` contains one, so switching network
 * is `VITE_CHAIN_ID` plus a deploy, and upgrading the implementation is
 * neither — the proxy address does not move.
 */

export interface DeploymentInfo {
  /** Where the frontend sends every call: the proxy, never an implementation. */
  address: Address | null
  chainId: number | null
  network: string
  /** Implementation behind the proxy at generation time — display only. */
  implementation: Address | null
  lens: Address | null
  confidentialEngine: Address | null
  confidentialEngineKind: string | null
  /**
   * The confidential network's *own* contract on this chain — Inco's
   * executor, not ours.
   *
   * `confidentialEngine` above is this protocol's adapter: a contract in
   * this repository that holds the handles. The executor is the thing the
   * privacy claim actually rests on, deployed and operated by the
   * confidential network, and it is the address worth publishing to a player
   * who wants to check who can decrypt an attack.
   */
  confidentialExecutor: Address | null
  /**
   * Which deployment of the confidential network this engine was wired to —
   * Inco's `pepper`, Fhenix CoFHE's `environment`.
   *
   * One field for both because it is one fact and one failure. The client
   * SDK resolves a set of services from it — a covalidator quorum, or a
   * coprocessor plus a ZK verifier plus a threshold network — and a value
   * that disagrees with what the engine was deployed against produces
   * handles nothing can open, silently, until the first Recon Probe.
   */
  confidentialRelease: string | null
  /**
   * Provider service endpoints an operator has overridden.
   *
   * Empty is the normal case: `confidentialRelease` already names the
   * provider's hosted services. It is here for a deployment running its own
   * confidential infrastructure, which is a per-deployment fact and so
   * belongs in the manifest rather than in a table in the client.
   */
  confidentialServices: Record<string, string> | null
  /**
   * The confidential network's session-verifier contract on this chain.
   *
   * What it buys is one wallet prompt instead of one per confidential read:
   * with it, a player signs a single session voucher and every Recon Probe
   * after that costs exactly one transaction. Null is a supported state —
   * the app falls back to signing each read — because this address is Inco's
   * to publish, not ours to guess, and guessing it wrong would mean a player
   * signing a voucher no covalidator will honour. See
   * `IncoGateway.decryptForOwner`.
   */
  confidentialSessionVerifier: Address | null
  /** First block worth scanning for this deployment's logs. */
  deploymentBlock: number
  /**
   * The block the protocol's epoch grid is measured from — the contract's
   * `genesisBlock()`, which is pinned at initialize and does not move when
   * the proxy is upgraded. Distinct from `deploymentBlock`: on a chain that
   * has been upgraded, those two numbers differ, and using the deploy block
   * for countdowns puts the header on a different grid than the chain.
   */
  genesisBlock: number
  version: string | null
  explorerUrl: string | null
  rpcUrl: string | null
  /**
   * The protocol parameters this deployment's contract storage holds, as the
   * chain states them. `config/env.ts` turns them into the app's protocol
   * limits, which is what makes the deployment — rather than the frontend's
   * `.env` — the authority on what a creator may pick.
   */
  params: GeneratedParams | null
  /**
   * How often the protocol opens its own Global Defense draw, in epochs.
   *
   * Beside `params` because the contract keeps it beside them: it has its
   * own storage slot and its own setter, not a field in the struct every
   * lobby snapshots. Null on a manifest generated before it was recorded —
   * which leaves the ENV value standing, the same as any other limit the
   * manifest does not carry.
   */
  globalDefenseEpochInterval: number | null
  /** True when a manifest for this chain exists — i.e. the app can actually run against it. */
  configured: boolean
}

export const AEGYLAX_CONTRACT_ABI = AEGYLAX_ABI

export function listGeneratedDeployments(): number[] {
  return Object.keys(AEGYLAX_DEPLOYMENTS).map(Number)
}

function asAddress(value: string | null | undefined): Address | null {
  return value && /^0x[0-9a-fA-F]{40}$/.test(value) ? (value as Address) : null
}

/**
 * Resolves the deployment for `chainId`, with ENV taking precedence.
 *
 * `overrides` are the raw ENV values so that a deployment can be pointed
 * somewhere else without a rebuild of the manifest — the case that matters
 * is a developer running against a local node, where the address changes
 * every time the node restarts.
 */
export function resolveDeployment(
  chainId: number | null,
  overrides: {
    address?: string | null
    explorerUrl?: string | null
    rpcUrl?: string | null
    deploymentBlock?: number | null
    genesisBlock?: number | null
    sessionVerifier?: string | null
  } = {},
): DeploymentInfo {
  const generated = getGeneratedDeployment(chainId)

  const address = asAddress(overrides.address) ?? asAddress(generated?.proxy)
  return {
    address,
    chainId: chainId ?? generated?.chainId ?? null,
    network: generated?.network ?? (chainId ? `chain-${chainId}` : 'unconfigured'),
    implementation: asAddress(generated?.implementation),
    lens: asAddress(generated?.lens),
    confidentialEngine: asAddress(generated?.confidentialEngine?.address),
    confidentialEngineKind: generated?.confidentialEngine?.kind ?? null,
    confidentialExecutor: asAddress(generated?.confidentialEngine?.executor),
    // `pepper` is what Inco deployments recorded before the field was named
    // for the thing rather than for one provider's word for it; manifests
    // written then still resolve.
    confidentialRelease:
      generated?.confidentialEngine?.release ?? generated?.confidentialEngine?.pepper ?? null,
    confidentialServices: generated?.confidentialEngine?.services ?? null,
    confidentialSessionVerifier:
      asAddress(overrides.sessionVerifier) ?? asAddress(generated?.confidentialEngine?.sessionVerifier),
    deploymentBlock: overrides.deploymentBlock ?? generated?.deploymentBlock ?? 0,
    genesisBlock: overrides.genesisBlock ?? generated?.genesisBlock ?? overrides.deploymentBlock ?? generated?.deploymentBlock ?? 0,
    version: generated?.version ?? null,
    explorerUrl: overrides.explorerUrl || generated?.explorerUrl || null,
    rpcUrl: overrides.rpcUrl || generated?.rpcUrl || null,
    params: generated?.params ?? null,
    globalDefenseEpochInterval: generated?.globalDefenseEpochInterval ?? null,
    configured: address !== null,
  }
}
