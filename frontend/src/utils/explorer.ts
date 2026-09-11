import { appConfig, type AppConfig } from '../config/env'
import type { Address, Hash } from '../game/types'

/**
 * Block explorer links (ТЗ §12).
 *
 * Three helpers, one source of truth for the base URL, and no component
 * that builds an explorer path itself. The base comes from the active
 * deployment — the manifest's explorer, or an ENV override — so the same
 * "view on explorer" affordance follows the app from Base Sepolia to Base
 * to a local node without a single URL being edited.
 *
 * Every helper returns `null` when there is no explorer for the active
 * network rather than a broken link. Emulator mode is exactly that case:
 * its transactions are real objects with real hashes, but there is nowhere
 * to look them up, and a dead link would say otherwise.
 */

export type ExplorerTarget = 'tx' | 'block' | 'address' | 'token'

function baseUrl(config: AppConfig): string | null {
  const url = config.deployment.explorerUrl
  if (!url) return null
  return url.replace(/\/+$/, '')
}

function buildUrl(target: ExplorerTarget, value: string, config: AppConfig): string | null {
  const base = baseUrl(config)
  if (!base || !value) return null
  return `${base}/${target}/${value}`
}

export function getTxUrl(hash: Hash | string | null | undefined, config: AppConfig = appConfig): string | null {
  return hash ? buildUrl('tx', String(hash), config) : null
}

export function getBlockUrl(
  blockNumber: number | bigint | null | undefined,
  config: AppConfig = appConfig,
): string | null {
  return blockNumber === null || blockNumber === undefined ? null : buildUrl('block', String(blockNumber), config)
}

export function getAddressUrl(
  address: Address | string | null | undefined,
  config: AppConfig = appConfig,
): string | null {
  return address ? buildUrl('address', String(address), config) : null
}

/** Whether this build has an explorer at all — what a UI checks before rendering a link. */
export function hasExplorer(config: AppConfig = appConfig): boolean {
  return baseUrl(config) !== null
}

/** `0x1234…cdef` — the form a hash takes when it has to fit in a line of UI. */
export function shortHash(value: string | null | undefined, lead = 6, tail = 4): string {
  if (!value) return ''
  if (value.length <= lead + tail + 1) return value
  return `${value.slice(0, lead)}…${value.slice(-tail)}`
}
