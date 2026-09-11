import { describe, expect, it } from 'vitest'
import {
  canJoinLobby,
  canTransition,
  nextLobbyStatus,
  validateLobbyConfig,
  MAX_LOBBY_NAME_BYTES,
} from '../../game/lobby'
import type { Lobby, LobbyConfig } from '../../game/types'
import { TEST_PROTOCOL_LIMITS as limits, buildTestLobbyConfig } from '../fixtures'

const baseConfig = buildTestLobbyConfig()

function makeLobby(overrides: Partial<Lobby> = {}): Pick<Lobby, 'status' | 'participantCount' | 'config'> {
  return { status: 'OPEN', participantCount: 0, config: baseConfig, ...overrides }
}

describe('lobby state machine (spec §43)', () => {
  it('allows the documented transitions', () => {
    expect(canTransition('CREATED', 'OPEN')).toBe(true)
    expect(canTransition('OPEN', 'READY')).toBe(true)
    expect(canTransition('OPEN', 'CANCELLED')).toBe(true)
    expect(canTransition('READY', 'ACTIVE')).toBe(true)
    expect(canTransition('ACTIVE', 'RESOLVED')).toBe(true)
  })

  it('rejects invalid transitions', () => {
    expect(canTransition('OPEN', 'ACTIVE')).toBe(false)
    expect(canTransition('RESOLVED', 'OPEN')).toBe(false)
    expect(canTransition('CANCELLED', 'ACTIVE')).toBe(false)
  })

  it('moves OPEN -> READY at deadline when minimum participants are met', () => {
    const lobby = makeLobby({ participantCount: 2, config: { ...baseConfig, participation: { ...baseConfig.participation, deadline: Date.now() - 1 } } })
    expect(nextLobbyStatus(lobby, Date.now())).toBe('READY')
  })

  it('moves OPEN -> CANCELLED at deadline when minimum participants are not met', () => {
    const lobby = makeLobby({ participantCount: 1, config: { ...baseConfig, participation: { ...baseConfig.participation, deadline: Date.now() - 1 } } })
    expect(nextLobbyStatus(lobby, Date.now())).toBe('CANCELLED')
  })

  it('stays OPEN before the deadline', () => {
    const lobby = makeLobby({ participantCount: 0 })
    expect(nextLobbyStatus(lobby, Date.now())).toBe('OPEN')
  })
})

describe('canJoinLobby (spec §17-18)', () => {
  it('allows joining an OPEN lobby before the deadline with room left', () => {
    expect(canJoinLobby(makeLobby({ participantCount: 1 }), Date.now())).toBe(true)
  })

  it('blocks joining once the lobby has started', () => {
    expect(canJoinLobby(makeLobby({ status: 'ACTIVE' }), Date.now())).toBe(false)
  })

  it('blocks joining after the deadline', () => {
    const lobby = makeLobby({ config: { ...baseConfig, participation: { ...baseConfig.participation, deadline: Date.now() - 1 } } })
    expect(canJoinLobby(lobby, Date.now())).toBe(false)
  })

  it('blocks joining once max players is reached', () => {
    expect(canJoinLobby(makeLobby({ participantCount: 4 }), Date.now())).toBe(false)
  })
})

describe('validateLobbyConfig', () => {
  const validate = (config: LobbyConfig) => validateLobbyConfig(config, Date.now(), limits)
  const withParticipation = (overrides: Partial<LobbyConfig['participation']>): LobbyConfig => ({
    ...baseConfig,
    participation: { ...baseConfig.participation, ...overrides },
  })

  it('accepts a well-formed config', () => {
    expect(validate(baseConfig)).toHaveLength(0)
  })

  it('requires a name', () => {
    const errors = validate({ ...baseConfig, name: '' })
    expect(errors.some((e) => e.field === 'name')).toBe(true)
  })

  it('does not accept whitespace as a name', () => {
    const errors = validate({ ...baseConfig, name: '   ' })
    expect(errors.some((e) => e.field === 'name')).toBe(true)
  })

  it('flags a name longer than the protocol allows', () => {
    const errors = validate({ ...baseConfig, name: 'x'.repeat(MAX_LOBBY_NAME_BYTES + 1) })
    expect(errors.some((e) => e.field === 'name')).toBe(true)
  })

  it('accepts a name padded with whitespace, since creation trims it', () => {
    expect(validate({ ...baseConfig, name: `  ${'x'.repeat(MAX_LOBBY_NAME_BYTES)}  ` })).toHaveLength(0)
  })

  // The contract counts bytes, so a name well inside the character limit can
  // still be over budget. This is the case that used to pass validation and
  // then revert on chain with InvalidConfig("name").
  it('flags a non-Latin name that fits in characters but not in bytes', () => {
    const name = 'Операція'.repeat(4) // 32 characters, 64 UTF-8 bytes
    expect(name.length).toBeLessThanOrEqual(MAX_LOBBY_NAME_BYTES)
    expect(validate({ ...baseConfig, name }).some((e) => e.field === 'name')).toBe(true)
  })

  it('accepts a non-Latin name that fits the byte budget', () => {
    expect(validate({ ...baseConfig, name: 'Операція' })).toHaveLength(0)
  })

  it('flags maxPlayers below minPlayers', () => {
    const errors = validate(withParticipation({ minPlayers: 5, maxPlayers: 2 }))
    expect(errors.some((e) => e.field === 'participation.maxPlayers')).toBe(true)
  })

  it('flags a deadline in the past', () => {
    const errors = validate(withParticipation({ deadline: Date.now() - 1000 }))
    expect(errors.some((e) => e.field === 'participation.deadline')).toBe(true)
  })

  /*
   * A deadline that is not a number at all, which every range check waves
   * through: `NaN <= now` is false, and so is `NaN - now < min`.
   *
   * It is reachable. Clearing the date picker hands the form an empty
   * string, and `new Date('').getTime()` is `NaN` — so this validator, which
   * also guards the write path, used to declare that config legal and let it
   * through to `createLobby`. The kind has to be rejected before the value
   * can be compared.
   */
  it('rejects a deadline that is not a moment at all', () => {
    for (const deadline of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const errors = validate(withParticipation({ deadline }))
      expect(errors.some((e) => e.field === 'participation.deadline')).toBe(true)
    }
  })

  it('flags a recon allowance that is not the protocol’s', () => {
    const errors = validate({ ...baseConfig, drones: { ...baseConfig.drones, maxCount: 1 } })
    expect(errors.some((e) => e.field === 'drones.maxCount')).toBe(true)
  })
})

/**
 * The protocol boundaries (spec §4-6, §14-15). These are the checks that
 * make the creator form's limits real: they run again inside the
 * blockchain layer's `createLobby`, so a payload that never went through
 * the form is rejected there.
 */
describe('validateLobbyConfig protocol boundaries', () => {
  const validate = (config: LobbyConfig) => validateLobbyConfig(config, Date.now(), limits)
  const withParticipation = (overrides: Partial<LobbyConfig['participation']>): LobbyConfig => ({
    ...baseConfig,
    participation: { ...baseConfig.participation, ...overrides },
  })

  it('rejects a single-player operation however the payload asks for it', () => {
    const errors = validate(withParticipation({ minPlayers: 1 }))
    expect(errors.some((e) => e.field === 'participation.minPlayers')).toBe(true)
  })

  it('rejects more players than the protocol allows', () => {
    const errors = validate(withParticipation({ maxPlayers: limits.maxPlayers + 5 }))
    expect(errors.some((e) => e.field === 'participation.maxPlayers')).toBe(true)
  })

  it('accepts min === max inside the protocol range', () => {
    expect(validate(withParticipation({ minPlayers: 8, maxPlayers: 8 }))).toHaveLength(0)
  })

  it('rejects an entry fee outside the protocol range', () => {
    const errors = validate(withParticipation({ entryPrice: limits.maxEntryPrice + 1 }))
    expect(errors.some((e) => e.field === 'participation.entryPrice')).toBe(true)
  })

  it('rejects an application window longer than the protocol allows', () => {
    const errors = validate(withParticipation({ deadline: Date.now() + limits.maxRegistrationDurationMs + 60_000 }))
    expect(errors.some((e) => e.field === 'participation.deadline')).toBe(true)
  })

  it('rejects an application window shorter than the protocol allows', () => {
    const errors = validateLobbyConfig(withParticipation({ deadline: Date.now() + 30_000 }), Date.now(), {
      ...limits,
      minRegistrationDurationMs: 15 * 60 * 1000,
    })
    expect(errors.some((e) => e.field === 'participation.deadline')).toBe(true)
  })

  it('rejects a creator fee above the protocol maximum', () => {
    const errors = validate({
      ...baseConfig,
      economics: { ...baseConfig.economics, creatorFeePercent: limits.maxCreatorFeePercent + 1 },
    })
    expect(errors.some((e) => e.field === 'economics.creatorFeePercent')).toBe(true)
  })

  /*
   * Recon terms stopped being a range a creator picks inside and became
   * values they must match (ТЗ §3). The epoch's attack is one threat shared
   * by every operation playing it, so a probe's answer is worth the same
   * everywhere — a creator who could price it would be choosing where the
   * whole epoch buys its intelligence, not pricing their own room.
   */
  it('rejects a creator-chosen probe allowance, high or low', () => {
    const raised = validate({ ...baseConfig, drones: { ...baseConfig.drones, maxCount: limits.maxReconProbes + 1 } })
    expect(raised.some((e) => e.field === 'drones.maxCount')).toBe(true)

    const lowered = validate({ ...baseConfig, drones: { ...baseConfig.drones, maxCount: limits.maxReconProbes - 1 } })
    expect(lowered.some((e) => e.field === 'drones.maxCount')).toBe(true)
  })

  it('rejects a creator-chosen free grant', () => {
    const errors = validate({ ...baseConfig, drones: { ...baseConfig.drones, freeCount: 6 } })
    expect(errors.some((e) => e.field === 'drones.freeCount')).toBe(true)
  })

  /// Undercutting the protocol's price is the arbitrage this rule exists to close.
  it('rejects a creator-chosen probe price, cheaper included', () => {
    const errors = validate({ ...baseConfig, drones: { ...baseConfig.drones, price: 0 } })
    expect(errors.some((e) => e.field === 'drones.price')).toBe(true)
  })

  it('accepts the protocol’s own recon terms', () => {
    expect(
      validate({
        ...baseConfig,
        drones: {
          freeCount: limits.freeReconProbes,
          maxCount: limits.maxReconProbes,
          price: limits.reconProbePrice,
        },
      }),
    ).toHaveLength(0)
  })

  it('rejects a tampered protocol join fee', () => {
    const errors = validate({ ...baseConfig, economics: { ...baseConfig.economics, protocolJoinFee: 0.5 } })
    expect(errors.some((e) => e.field === 'economics.protocolJoinFee')).toBe(true)
  })

  it('rejects tampered attack rules — cadence, speed and interception radius are the protocol’s', () => {
    expect(
      validate({ ...baseConfig, attack: { ...baseConfig.attack, epochBlocks: 1 } }).some(
        (e) => e.field === 'attack.epochBlocks',
      ),
    ).toBe(true)
    // ТЗ §9.8 — a creator who could set the speed could set how long the
    // flight lasts, and with it how much reconnaissance is worth.
    expect(
      validate({ ...baseConfig, attack: { ...baseConfig.attack, sectorSpanKm: 1 } }).some(
        (e) => e.field === 'attack.sectorSpanKm',
      ),
    ).toBe(true)
    // ТЗ §10.4 — and a creator who could widen the radius could decide the outcome.
    expect(
      validate({ ...baseConfig, attack: { ...baseConfig.attack, interceptionRadiusSectors: 99 } }).some(
        (e) => e.field === 'attack.interceptionRadiusSectors',
      ),
    ).toBe(true)
    expect(
      validate({ ...baseConfig, attack: { ...baseConfig.attack, defenseSpeedKmPerBlock: 1 } }).some(
        (e) => e.field === 'attack.defenseSpeedKmPerBlock',
      ),
    ).toBe(true)
  })
})
