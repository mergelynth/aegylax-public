import type { ProtocolLimits } from '../config/env'
import type { LobbyConfig, MapGridConfig } from '../game/types'

/**
 * Shared test fixtures.
 *
 * `LobbyConfig` and `ProtocolLimits` are validated against each other by
 * `validateLobbyConfig`, so a test that hand-rolls one of them has to keep
 * every protocol-owned field in step with the other. Defining both here
 * once means a new protocol field breaks one place instead of eight.
 */

export const TEST_PROTOCOL_LIMITS: ProtocolLimits = {
  minPlayers: 2,
  maxPlayers: 20,
  minEntryPrice: 0,
  maxEntryPrice: 10,
  minStartPrizePool: 0,
  minRegistrationDurationMs: 0,
  maxRegistrationDurationMs: 30 * 24 * 60 * 60 * 1000,
  maxCreatorFeePercent: 5,
  maxReconProbes: 6,
  freeReconProbes: 3,
  reconProbePrice: 0.002,
  joinFee: 0,
  epochBlocks: 150,
  sectorSpanKm: 1000,
  interceptionRadiusSectors: 0.14,
  defenseSpeedKmPerBlock: 250,
  globalDefenseEpochInterval: 1000,
  globalDefenseJoinWindowMs: 24 * 60 * 60 * 1000,
}

export const TEST_MAP_GRID: MapGridConfig = { columns: 10, rows: 5 }

export function buildTestLobbyConfig(overrides: Partial<LobbyConfig> = {}): LobbyConfig {
  return {
    name: 'Test Operation',
    participation: { minPlayers: 2, maxPlayers: 4, entryPrice: 0.01, deadline: Date.now() + 10_000, deadlineBlock: 0 },
    economics: { prizePool: 0, creatorFeePercent: 5, protocolJoinFee: 0 },
    // Protocol-set now, not creator-set: these have to equal the limits or
    // `validateLobbyConfig` rejects the config (ТЗ §3).
    drones: {
      freeCount: TEST_PROTOCOL_LIMITS.freeReconProbes,
      price: TEST_PROTOCOL_LIMITS.reconProbePrice,
      maxCount: TEST_PROTOCOL_LIMITS.maxReconProbes,
    },
    attack: {
      epochBlocks: TEST_PROTOCOL_LIMITS.epochBlocks,
      sectorSpanKm: TEST_PROTOCOL_LIMITS.sectorSpanKm,
      interceptionRadiusSectors: TEST_PROTOCOL_LIMITS.interceptionRadiusSectors,
      defenseSpeedKmPerBlock: TEST_PROTOCOL_LIMITS.defenseSpeedKmPerBlock,
    },
    payout: { rewardAsset: { kind: 'ETH' } },
    ...overrides,
  }
}
