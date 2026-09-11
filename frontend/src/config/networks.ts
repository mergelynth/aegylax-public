import { base, baseSepolia, type Chain } from 'viem/chains'
import { AEGYLAX_DEPLOYMENTS, getGeneratedDeployment } from '../contracts/generated'
import { resolveDeployment } from './deployment'
import type { AppConfig } from './env'
import { readOptionalString } from './readEnv'

/**
 * Which chains this build knows about, and what the active one looks like.
 *
 * Nothing here is a list of networks the app "supports" in the sense of
 * having been written for them. A network becomes usable by being deployed
 * to — `npm run chain:deploy` writes `deployments/<chainId>.json`, the
 * manifest carries the chain id, the RPC and the explorer, and `VITE_CHAIN_ID`
 * points the build at it. So the set below is *derived* from the manifests
 * plus ENV rather than declared, and moving to a new L2 is a deploy and one
 * ENV value, not an edit to this file (ТЗ §8).
 *
 * The two viem definitions are enrichment, not gatekeeping: where a chain id
 * happens to be one viem already describes, its canonical name, currency and
 * public RPCs are better than anything a manifest would repeat. Every other
 * chain id is described from the manifest instead, and works identically.
 */

/**
 * Chain metadata worth preferring over a manifest's, keyed by id. Adding an
 * entry improves how a network is *described*; it is never what makes one
 * usable, and a chain absent from here is not a chain the app refuses.
 */
const ENRICHED_CHAINS: readonly Chain[] = [base, baseSepolia]

function enrichedChain(chainId: number): Chain | null {
  return ENRICHED_CHAINS.find((chain) => chain.id === chainId) ?? null
}

/** Human name for a chain id, from viem's registry, then a manifest, then the id itself. */
export function describeChain(chainId: number | null): string {
  if (chainId === null) return 'Unknown network'

  const known = enrichedChain(chainId)
  if (known) return known.name

  const generated = getGeneratedDeployment(chainId)
  return generated?.network ?? `Chain ${chainId}`
}

/**
 * Builds a viem `Chain` for `chainId` out of everything this build knows:
 * viem's own definition where there is one, the deployment manifest's RPC
 * and explorer, and finally the ENV overrides that exist so a local node or
 * a fork can be pointed at without regenerating anything.
 *
 * The RPC layering matters. A manifest records the RPC a deployment was made
 * against, and leaving `VITE_RPC_URL` empty is the documented normal case —
 * so a chain definition that only ever read ENV would come out with no
 * transport at all on exactly the configuration the app ships with.
 */
function buildChain(
  chainId: number,
  overrides: { rpcUrl?: string | null; explorerUrl?: string | null } = {},
): Chain {
  const known = enrichedChain(chainId)
  const deployment = resolveDeployment(chainId, overrides)

  const rpcUrl = overrides.rpcUrl || deployment.rpcUrl
  const explorerUrl = overrides.explorerUrl || deployment.explorerUrl

  const fallback: Chain = known ?? {
    id: chainId,
    name: deployment.network === `chain-${chainId}` ? `Chain ${chainId}` : deployment.network,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [] } },
  }

  return {
    ...fallback,
    rpcUrls: rpcUrl ? { default: { http: [rpcUrl] } } : fallback.rpcUrls,
    blockExplorers: explorerUrl
      ? { default: { name: 'Explorer', url: explorerUrl } }
      : fallback.blockExplorers,
  }
}

/**
 * Every chain a player's wallet may legitimately be on for this build.
 *
 * Deliberately narrow by default — the active chain, plus anything this
 * repository holds a deployment manifest for, so a wallet can move between
 * a testnet and a mainnet deployment without a rebuild. `VITE_SUPPORTED_CHAIN_IDS`
 * widens it for the cases the manifests cannot know about, such as a fork or
 * a local node the player also uses.
 */
export function resolveSupportedChains(config: AppConfig, env: ImportMetaEnv = import.meta.env): Chain[] {
  const ids = new Set<number>()

  if (config.chainId !== null) ids.add(config.chainId)
  for (const id of Object.keys(AEGYLAX_DEPLOYMENTS)) {
    const parsed = Number(id)
    if (Number.isFinite(parsed)) ids.add(parsed)
  }
  for (const entry of readOptionalString(env.VITE_SUPPORTED_CHAIN_IDS)?.split(',') ?? []) {
    const parsed = Number(entry.trim())
    if (Number.isFinite(parsed) && parsed > 0) ids.add(parsed)
  }

  // A build with nothing configured at all still has to hand the wallet
  // provider a non-empty list, and the enriched set is the honest default.
  if (ids.size === 0) return [...ENRICHED_CHAINS]

  return [...ids].map((id) =>
    id === config.chainId
      ? buildChain(id, { rpcUrl: config.rpcUrl, explorerUrl: config.explorerUrl })
      : buildChain(id),
  )
}

/**
 * The chain definition for "contract" mode: the manifest's network, with
 * ENV's RPC and explorer layered on top. `null` when no chain is configured,
 * which is what emulator mode looks like from here.
 */
export function resolveActiveChain(config: AppConfig): Chain | null {
  if (config.chainId === null) return null
  return buildChain(config.chainId, { rpcUrl: config.rpcUrl, explorerUrl: config.explorerUrl })
}
