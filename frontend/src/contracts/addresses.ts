import { appConfig } from '../config/env'
import type { Address } from '../game/types'

/**
 * The one address the app talks to: the proxy of the active deployment.
 *
 * It is never written down here. `config/deployment.ts` resolves it from
 * the generated manifest — which `npm run chain:deploy` produces and
 * nothing else edits — with ENV able to override it for a local node. An
 * implementation upgrade does not change it, and switching networks is a
 * change of `VITE_CHAIN_ID`, not of this file.
 */
export function getConfiguredContractAddress(): Address | null {
  return appConfig.deployment.address
}

/** The deployed implementation behind the proxy, for display only. */
export function getImplementationAddress(): Address | null {
  return appConfig.deployment.implementation
}

/** The confidential engine a Defense Point is encrypted against. */
export function getConfidentialEngineAddress(): Address | null {
  return appConfig.deployment.confidentialEngine
}
