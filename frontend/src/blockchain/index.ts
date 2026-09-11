import type { AppConfig } from '../config/env'
import { ContractBlockchainClient } from './contract/ContractBlockchainClient'
import { EmulatorBlockchainClient } from './EmulatorBlockchainClient'
import type { BlockchainClient } from './types'

export * from './types'
export { EmulatorBlockchainClient } from './EmulatorBlockchainClient'
export { ContractBlockchainClient } from './contract/ContractBlockchainClient'

/**
 * The only place in the app that chooses an implementation. Everything
 * else — game domain, hooks, components — depends only on the
 * `BlockchainClient` interface (spec §7).
 */
export function createBlockchainClient(config: AppConfig): BlockchainClient {
  if (config.blockchainMode === 'contract') {
    return new ContractBlockchainClient(config)
  }
  return new EmulatorBlockchainClient({
    initialBlock: config.emulator.initialBlock,
    blockTimeMs: config.emulator.blockTimeMs,
    mapGrid: { columns: config.map.columns, rows: config.map.rows },
    epochBlocks: config.protocol.epochBlocks,
    protocolLimits: config.protocol,
  })
}

let singleton: BlockchainClient | null = null

/** Lazily creates and reuses one client instance for the lifetime of the app. */
export function getBlockchainClient(config: AppConfig): BlockchainClient {
  if (!singleton) singleton = createBlockchainClient(config)
  return singleton
}
