import { afterEach, describe, expect, it } from 'vitest'
import { EmulatorBlockchainClient } from '../../blockchain/EmulatorBlockchainClient'
import { buildDefaultLobbyConfig } from '../../config/gameConfig'
import { parseEnv } from '../../config/env'
import { createLobby, getLobby } from '../../game/gameService'
import type { Address } from '../../game/types'

const CREATOR = '0xc0ffee0000000000000000000000000000c0de' as Address

function buildEnv(): ImportMetaEnv {
  return {
    VITE_BLOCKCHAIN_MODE: 'emulator',
    VITE_ATTACK_EPOCH_BLOCKS: '5',
    VITE_EMULATOR_INITIAL_BLOCK: '1',
    VITE_EMULATOR_BLOCK_TIME_MS: '2000',
    VITE_MAP_GRID_COLUMNS: '8',
    VITE_MAP_GRID_ROWS: '8',
    VITE_RECON_PROBE_FREE_COUNT: '3',
  } as unknown as ImportMetaEnv
}

describe('integration: create lobby -> tx -> lobby id === tx hash (spec §14-15)', () => {
  let client: EmulatorBlockchainClient
  afterEach(() => client.dispose())

  it('creates a lobby whose id equals the creation transaction hash and is readable immediately after', async () => {
    const appConfig = parseEnv(buildEnv())
    client = new EmulatorBlockchainClient({
      initialBlock: 1,
      blockTimeMs: 10_000_000,
      mapGrid: { columns: 8, rows: 8 },
      epochBlocks: 150,
      protocolLimits: appConfig.protocol,
    })
    const config = { ...buildDefaultLobbyConfig(appConfig, Date.now()), name: 'Test Operation' }

    const { lobby, tx } = await createLobby(client, CREATOR, config)

    expect(lobby.id).toBe(tx.hash)
    expect(lobby.creationTxHash).toBe(tx.hash)
    expect(lobby.status).toBe('OPEN')

    const reread = await getLobby(client, lobby.id)
    expect(reread?.id).toBe(lobby.id)
  })

  /**
   * A public RPC endpoint is many nodes, and the one that answers the read
   * after a creation can be a block behind the one that confirmed it. The
   * lobby exists — the creation is not allowed to be reported as a failure
   * because the first answer was empty.
   */
  it('survives a read endpoint that has not caught up with the creation yet', async () => {
    const appConfig = parseEnv(buildEnv())
    client = new EmulatorBlockchainClient({
      initialBlock: 1,
      blockTimeMs: 10_000_000,
      mapGrid: { columns: 8, rows: 8 },
      epochBlocks: 150,
      protocolLimits: appConfig.protocol,
    })
    const config = { ...buildDefaultLobbyConfig(appConfig, Date.now()), name: 'Lagging Node' }

    let misses = 2
    const lagging = Object.create(client) as EmulatorBlockchainClient
    lagging.readContract = ((functionName: string, args: unknown) => {
      if (functionName === 'getLobby' && misses > 0) {
        misses -= 1
        return Promise.resolve(null)
      }
      return client.readContract(functionName as never, args as never)
    }) as EmulatorBlockchainClient['readContract']

    const { lobby } = await createLobby(lagging, CREATOR, config)

    expect(misses).toBe(0)
    expect(lobby.config.name).toBe('Lagging Node')
    expect(lobby.status).toBe('OPEN')
  })
})
