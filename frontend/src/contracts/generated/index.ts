/**
 * GENERATED FILE — do not edit.
 *
 * Written by `npm run chain:deploy` / `npm run chain:upgrade` from the
 * manifests in deployments/. Editing it by hand would put the frontend's
 * idea of the contract out of step with the chain's, which is exactly the
 * failure this file exists to make impossible.
 */

import abi from './abi.json'
import deployments from './deployments.json'

export interface GeneratedDeployment {
  name: string
  network: string
  chainId: number
  version: string
  proxy: `0x${string}`
  implementation: `0x${string}`
  lens: `0x${string}`
  confidentialEngine: {
    /**
     * Which confidential stack this deployment runs — `fhenix-cofhe`,
     * `inco-lightning`, `mock`. The client's gateway registry is keyed by
     * it and refuses a kind it has no implementation for.
     */
    kind: string
    address: `0x${string}`
    contract: string | null
    /**
     * Which deployment of that stack — Inco's pepper, CoFHE's environment.
     * The client SDK resolves its services from this, so a value that
     * disagrees with what the engine was wired to produces handles nothing
     * can open.
     */
    release?: string | null
    /** What Inco deployments recorded before the field was named for the thing. */
    pepper?: string | null
    /**
     * The confidential network's own contract on this chain, recorded at
     * deploy time. `address` above is this protocol's adapter; this one is
     * theirs, and it is what the privacy claim actually rests on.
     */
    executor?: `0x${string}` | null
    /**
     * Service endpoints an operator running their own confidential
     * infrastructure has overridden. Absent means the release's hosted
     * defaults.
     */
    services?: Record<string, string> | null
    /**
     * The confidential network's session-verifier contract, when the operator
     * has recorded one.
     *
     * With it, a player signs one session voucher and every Recon Probe after
     * that is a single transaction; without it each confidential read costs
     * its own wallet signature. Absent by default because the address belongs
     * to the confidential network's own deployment, not to ours — set
     * VITE_CONFIDENTIAL_SESSION_VERIFIER to supply it without a redeploy.
     */
    sessionVerifier?: `0x${string}` | null
  }
  deploymentBlock: number
  /**
   * The contract's epoch-grid origin (`genesisBlock()`), pinned at
   * initialize. Distinct from `deploymentBlock` after an upgrade.
   */
  genesisBlock: number
  explorerUrl: string
  rpcUrl: string
  deployedAt: string
  /**
   * The protocol parameters this deployment's `initialize()` wrote into
   * contract storage — decimal strings, in the contract's own units (wei for
   * money, seconds for windows, basis points for the creator fee,
   * thousandths of a sector for the interception radius).
   *
   * `config/env.ts` derives the app's protocol limits from these whenever a
   * deployment is configured, so the UI cannot offer a creator something the
   * chain will refuse. Null for a manifest written before params were
   * recorded.
   */
  params: GeneratedParams | null
  /**
   * How often the protocol opens its own Global Defense draw, in epochs.
   *
   * Beside `params` rather than inside them because the contract keeps it
   * that way: `GameParams` is snapshotted onto every lobby and has no room
   * for a cadence that belongs to the protocol, so this has its own storage
   * slot and its own setter. Null on a manifest written before it was
   * recorded, which leaves the ENV value standing.
   */
  globalDefenseEpochInterval?: number | null
}

export interface GeneratedParams {
  gridColumns: string
  gridRows: string
  sectorSpanKm: string
  interceptRadiusMilliSectors: string
  epochBlocks: string
  defenseSpeedKmPerBlock: string
  probeConeMicroRad: string
  revealGraceBlocks: string
  minPlayers: string
  maxPlayers: string
  /** Recon Probes one player may send per attack — protocol-owned. */
  maxProbesPerPlayer: string
  /** Recon Probes every player starts an attack with. */
  freeProbes: string
  maxCreatorFeeBps: string
  minRegistrationSeconds: string
  maxRegistrationSeconds: string
  /** wei */
  minEntryFee: string
  /** wei */
  maxEntryFee: string
  /** wei */
  minStartPrizePool: string
  /** wei — the price of one Recon Probe, set by the protocol, not the creator. */
  probePrice: string
  /** wei */
  protocolJoinFee: string
}

/** Every network this repository has a deployment manifest for, by chain id. */
export const AEGYLAX_DEPLOYMENTS = deployments as unknown as Record<string, GeneratedDeployment>

/** The merged game + lens ABI. One address answers all of it. */
export const AEGYLAX_ABI = abi

export function getGeneratedDeployment(chainId: number | null): GeneratedDeployment | null {
  if (chainId === null) return null
  return AEGYLAX_DEPLOYMENTS[String(chainId)] ?? null
}
