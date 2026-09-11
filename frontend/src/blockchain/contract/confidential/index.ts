import type { PublicClient, WalletClient } from 'viem'
import type { Address } from '../../../game/types'
import type { ConfidentialGateway } from './gateway'
import { cofheServiceDefaults, FhenixGateway, type CofheServiceUrls } from './providers/fhenix'
import { defaultSessionVerifier } from './providers/inco'
import { MockGateway } from './providers/mock'

export * from './gateway'
export {
  clearPersistedIncoSession,
  covalidatorUrlsOf,
  defaultSessionVerifier,
  hostChainRpcUrlsForLightning,
  incoSessionStorageKey,
  incoSessionStore,
  IncoGateway,
  INCO_SESSION_STORAGE_PREFIX,
  loadPersistedIncoSession,
  pingCovalidatorIsReady,
  probeCovalidatorQuorum,
  savePersistedIncoSession,
  SESSION_RENEWAL_MARGIN_MS,
  SESSION_TTL_MS,
  type CovalidatorPing,
  type PersistedIncoSession,
} from './providers/inco'
export {
  cofheServiceDefaults,
  COFHE_ENVIRONMENTS,
  describeInitFailure,
  FhenixGateway,
  isCofheEnvironment,
  isVersionSkew,
  normaliseRecoveryId,
  type CofheServiceUrls,
} from './providers/fhenix'
export { MockGateway } from './providers/mock'

/**
 * Every confidential stack this build can talk to, by the `kind` its
 * deployment manifest records.
 *
 * This table and `contracts/src/confidential/` are the two halves of one
 * choice, and they meet in the manifest and nowhere else. Adding a provider
 * is an `IConfidentialEngine` implementation on that side, a
 * `ConfidentialGateway` in `providers/` on this one, and an entry here —
 * which is what keeps the decision out of the game, the hooks and the UI.
 *
 * `fhenix-cofhe` is what every deployment gets. `inco-lightning` used to be
 * a second live entry and is now in `DISABLED_KINDS` below — the gateway
 * class is still exported and still tested, it is simply never built.
 */
const GATEWAYS: Record<string, (params: GatewayParams) => ConfidentialGateway> = {
  'fhenix-cofhe': (params) => {
    if (!params.release) {
      throw new Error(
        'The deployment manifest has no CoFHE environment recorded (confidentialEngine.release). ' +
          'Re-run "npm run chain:sync" for this chain, or redeploy — the client cannot guess which ' +
          'CoFHE deployment the engine was wired to.',
      )
    }
    return new FhenixGateway(
      params.chainId,
      params.engineAddress,
      params.getWalletClient,
      params.publicClient,
      params.release,
      params.executor ?? null,
      params.services ?? cofheServiceDefaults(params.release),
      params.hostChainRpcUrls ?? [],
    )
  },
  mock: (params) => new MockGateway(params.publicClient, params.engineAddress),
}

export interface GatewayParams {
  kind: string | null
  /**
   * Which deployment of the provider's network this engine was wired to —
   * Inco's `pepper`, CoFHE's `environment`.
   *
   * Named for what it does rather than for either provider's word, because
   * it is the same fact in both cases and the same failure when it is wrong:
   * a client talking to the network that cannot open the handles this
   * deployment's engine minted.
   */
  release?: string | null
  /**
   * The provider's *own* contract on this chain — Inco's executor, CoFHE's
   * TaskManager — as recorded at deploy time.
   *
   * `engineAddress` is this protocol's adapter; this one is theirs.
   */
  executor?: Address | null
  /**
   * Inco's session-verifier contract for this chain.
   *
   * Optional. When unset, `createGateway` fills in Inco's published verifier
   * for Base / Base Sepolia so a probe is one transaction. On any other chain
   * the per-call signature path remains. See `IncoGateway.decryptForOwner`.
   */
  sessionVerifier?: Address | null
  /**
   * CoFHE service endpoints, when an operator runs their own coprocessor
   * rather than Fhenix's hosted one. Empty means the environment's defaults.
   */
  services?: CofheServiceUrls
  /**
   * HTTPS RPCs for Inco's own viem client. Without them it uses viem's
   * public Base Sepolia endpoint, which 403s independently of the app's
   * fallback transport. WebSocket URLs are ignored — see
   * `hostChainRpcUrlsForLightning`.
   */
  hostChainRpcUrls?: readonly string[]
  chainId: number
  engineAddress: Address
  publicClient: PublicClient
  getWalletClient: () => WalletClient | null
}

/**
 * Confidential stacks this build refuses to talk to, and why.
 *
 * Separate from `GATEWAYS` rather than an entry in it that throws, because
 * the two answers are different: a kind nobody recognises is a manifest to
 * fix, and a kind that is *switched off* is a decision somebody made. A
 * player who opens a lobby on an old Inco deployment should be told the
 * second thing, and the message has to survive being read by whoever
 * inherits this.
 *
 * `IncoGateway` itself is untouched and still exported above: the boundary
 * this table guards is which provider a *deployment* may use, not whether
 * the code for it exists.
 */
const DISABLED_KINDS: Record<string, string> = {
  'inco-lightning':
    'This deployment is wired to Inco Lightning, which is switched off in this build — ' +
    'AEGYLAX runs on Fhenix CoFHE. Deploy a Fhenix engine for this chain, or point the app ' +
    'at a deployment that has one.',
}

/**
 * Picks the gateway for the engine this deployment actually has.
 *
 * An unrecognised `kind` is a hard failure rather than a fallback to a
 * default. Silently picking one meant a manifest naming some *other*
 * confidential stack produced a client that encrypted against the wrong
 * network and failed later, somewhere unrelated, with an error about a
 * handle.
 */
export function createGateway(params: GatewayParams): ConfidentialGateway {
  const disabled = params.kind ? DISABLED_KINDS[params.kind] : undefined
  if (disabled) throw new Error(disabled)

  const build = params.kind ? GATEWAYS[params.kind] : undefined
  if (!build) {
    throw new Error(
      `Unknown confidential engine "${params.kind ?? '(unset)'}". Known kinds: ${Object.keys(GATEWAYS).join(', ')}.`,
    )
  }
  return build({
    ...params,
    // A stock Inco deployment gets Inco's published verifier when none was
    // recorded — otherwise every confidential read costs a wallet signature
    // on top of the probe's own transaction. An explicit null-and-unknown
    // chain still falls through to the per-call path. Ignored by every other
    // provider.
    sessionVerifier: params.sessionVerifier ?? defaultSessionVerifier(params.chainId),
  })
}

/** Kinds this build can construct a gateway for — disabled ones are not among them. */
export function knownEngineKinds(): string[] {
  return Object.keys(GATEWAYS)
}
