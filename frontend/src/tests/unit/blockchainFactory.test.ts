import { describe, expect, it } from 'vitest'
import { createBlockchainClient } from '../../blockchain'
import { ContractBlockchainClient } from '../../blockchain/contract/ContractBlockchainClient'
import { EmulatorBlockchainClient } from '../../blockchain/EmulatorBlockchainClient'
import { parseEnv } from '../../config/env'

function buildEnv(overrides: Partial<Record<string, string>>): ImportMetaEnv {
  const base: Record<string, string> = {
    VITE_APP_NAME: 'AEGYLAX',
    VITE_APP_SUBTITLE: '',
    VITE_BLOCKCHAIN_MODE: 'emulator',
    VITE_PRIVY_APP_ID: '',
    VITE_CHAIN_ID: '',
    VITE_RPC_URL: '',
    VITE_EXPLORER_URL: '',
    VITE_CONTRACT_ADDRESS: '',
    VITE_PROTOCOL_JOIN_FEE: '',
    VITE_CREATOR_FEE_PERCENT: '',
    VITE_DEFAULT_ENTRY_PRICE: '',
    VITE_EMULATOR_INITIAL_BLOCK: '1',
    VITE_EMULATOR_BLOCK_TIME_MS: '2000',
    VITE_ATTACK_EPOCH_BLOCKS: '',
    VITE_MAP_GRID_COLUMNS: '',
    VITE_MAP_GRID_ROWS: '',
  }
  return { ...base, ...overrides } as unknown as ImportMetaEnv
}

describe('createBlockchainClient', () => {
  it('creates an EmulatorBlockchainClient in emulator mode', () => {
    const config = parseEnv(buildEnv({ VITE_BLOCKCHAIN_MODE: 'emulator' }))
    const client = createBlockchainClient(config)
    expect(client).toBeInstanceOf(EmulatorBlockchainClient)
    expect(client.mode).toBe('emulator')
    ;(client as EmulatorBlockchainClient).dispose()
  })

  it('creates a ContractBlockchainClient in contract mode', () => {
    const config = parseEnv(buildEnv({ VITE_BLOCKCHAIN_MODE: 'contract' }))
    const client = createBlockchainClient(config)
    expect(client).toBeInstanceOf(ContractBlockchainClient)
    expect(client.mode).toBe('contract')
  })

  it('never rewires UI-level code: both implementations satisfy the same BlockchainClient surface', () => {
    const emulator = createBlockchainClient(parseEnv(buildEnv({ VITE_BLOCKCHAIN_MODE: 'emulator' })))
    const contract = createBlockchainClient(parseEnv(buildEnv({ VITE_BLOCKCHAIN_MODE: 'contract' })))
    for (const method of ['getBlockNumber', 'getBlock', 'getBalance', 'readContract', 'writeContract', 'waitForTransaction', 'getLogs', 'subscribeToEvents']) {
      expect(typeof (emulator as unknown as Record<string, unknown>)[method]).toBe('function')
      expect(typeof (contract as unknown as Record<string, unknown>)[method]).toBe('function')
    }
    ;(emulator as EmulatorBlockchainClient).dispose()
  })
})
