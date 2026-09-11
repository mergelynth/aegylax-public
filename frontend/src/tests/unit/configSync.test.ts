import { describe, expect, it } from 'vitest'
import deployments from '../../contracts/generated/deployments.json'
import { parseEnv } from '../../config/env'
import { buildDefaultLobbyConfig } from '../../config/gameConfig'
import { validateLobbyConfig } from '../../game/lobby'

/**
 * The three copies of the protocol's rules, held to each other.
 *
 * A lobby's terms are judged in three places, and only the last one is
 * security:
 *
 *   1. `buildDefaultLobbyConfig` — what the Create Defense form opens on;
 *   2. `validateLobbyConfig` — what the form and the creation path enforce;
 *   3. `ProtocolRules.validateConfig` on chain — what actually decides.
 *
 * The interesting failure is not (3) rejecting something. It is (1) and (2)
 * disagreeing, because the protocol-owned fields are checked for *equality*
 * rather than for being in range: recon terms and the join fee are not
 * ranges a creator picks inside, they are values the config must match. If
 * the form's defaults come from a different source than the validator's
 * expectations, the form opens on a config that can never be submitted — and
 * the errors land on fields the form does not render, so Launch Defense is
 * refused with nothing on screen to explain why.
 *
 * That is exactly what two sources invited: the defaults used to read
 * `VITE_RECON_PROBE_*` while the validator read the chain's params layered
 * over `VITE_MAX_RECON_PROBES` — two env vars for one number, agreeing only
 * by coincidence.
 */

const CHAIN_ID = Object.keys(deployments)[0]
const MANIFEST = (deployments as Record<string, { params: Record<string, string> }>)[CHAIN_ID]

/**
 * Errors about anything except the name.
 *
 * The name is the one field that deliberately opens empty — naming the
 * operation is the creator's call, and a default would just get accepted
 * unread — so "give the operation a name" is the form working, not a
 * mismatch between config sources.
 */
function errorsIgnoringName(config: Parameters<typeof validateLobbyConfig>[0], now: number, limits: Parameters<typeof validateLobbyConfig>[2]) {
  return validateLobbyConfig(config, now, limits).filter((error) => error.field !== 'name')
}

function envWith(overrides: Record<string, string> = {}): ImportMetaEnv {
  return {
    VITE_BLOCKCHAIN_MODE: 'contract',
    VITE_CHAIN_ID: CHAIN_ID,
    ...overrides,
  } as unknown as ImportMetaEnv
}

describe('protocol config stays in step with the form and the validator', () => {
  it('opens the Create Defense form on a config that validates', () => {
    const config = parseEnv(envWith())
    const now = Date.now()

    const errors = errorsIgnoringName(buildDefaultLobbyConfig(config, now), now, config.protocol)
    expect(errors, `default config rejected: ${errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`).toEqual([])
  })

  /**
   * The regression proper: ENV disagreeing with the deployment must not be
   * able to produce an unsubmittable form.
   *
   * The chain is the authority, so what these ENV values say about recon and
   * the join fee should make no difference at all — the manifest overrides
   * them, and the defaults now read the same layered result the validator
   * does. Before that they read ENV directly, and this test failed on every
   * field below.
   */
  it('ignores ENV recon and fee values that contradict the deployment', () => {
    const config = parseEnv(
      envWith({
        VITE_RECON_PROBE_FREE_COUNT: '99',
        VITE_MAX_RECON_PROBES: '99',
        VITE_RECON_PROBE_PRICE: '9.99',
        VITE_PROTOCOL_JOIN_FEE: '9.99',
      }),
    )
    const now = Date.now()
    const defaults = buildDefaultLobbyConfig(config, now)

    expect(errorsIgnoringName(defaults, now, config.protocol)).toEqual([])

    // And the values really are the chain's, not the 99s above.
    expect(defaults.drones.freeCount).toBe(Number(MANIFEST.params.freeProbes))
    expect(defaults.drones.maxCount).toBe(Number(MANIFEST.params.maxProbesPerPlayer))
    expect(defaults.economics.protocolJoinFee).toBeCloseTo(Number(MANIFEST.params.protocolJoinFee) / 1e18, 12)
  })

  /**
   * Every protocol-owned limit the validator checks by equality comes from
   * the deployment manifest, in the units the UI works in.
   *
   * These are the numbers a creator cannot set, so a mismatch is not a
   * disagreement about preference — it is the frontend enforcing a rule the
   * contract does not have, or failing to enforce one it does.
   */
  it('derives every protocol-owned limit from the deployment manifest', () => {
    const limits = parseEnv(envWith()).protocol
    const p = MANIFEST.params

    expect(limits.freeReconProbes).toBe(Number(p.freeProbes))
    expect(limits.maxReconProbes).toBe(Number(p.maxProbesPerPlayer))
    expect(limits.reconProbePrice).toBeCloseTo(Number(p.probePrice) / 1e18, 12)
    expect(limits.joinFee).toBeCloseTo(Number(p.protocolJoinFee) / 1e18, 12)
    expect(limits.epochBlocks).toBe(Number(p.epochBlocks))
    expect(limits.sectorSpanKm).toBe(Number(p.sectorSpanKm))
    expect(limits.interceptionRadiusSectors).toBeCloseTo(Number(p.interceptRadiusMilliSectors) / 1000, 12)
    expect(limits.defenseSpeedKmPerBlock).toBe(Number(p.defenseSpeedKmPerBlock))

    // The ranges a creator picks inside, same source.
    expect(limits.minPlayers).toBe(Number(p.minPlayers))
    expect(limits.maxPlayers).toBe(Number(p.maxPlayers))
    expect(limits.minEntryPrice).toBeCloseTo(Number(p.minEntryFee) / 1e18, 12)
    expect(limits.maxEntryPrice).toBeCloseTo(Number(p.maxEntryFee) / 1e18, 12)
    expect(limits.minStartPrizePool).toBeCloseTo(Number(p.minStartPrizePool) / 1e18, 12)
    expect(limits.maxCreatorFeePercent).toBeCloseTo(Number(p.maxCreatorFeeBps) / 100, 12)
  })

  /**
   * The playfield the contract was initialized with is the playfield the
   * client draws on.
   *
   * Geometry is not cosmetic here: the grid decides where a sensor may
   * stand (`sendProbe` rejects a cell off the board) and what a Defense
   * Point's coordinates mean once packed. A client drawing a wider board
   * than the contract believes in would offer positions the protocol
   * refuses.
   */
  it('draws the same grid the contract was initialized with', () => {
    const config = parseEnv(envWith())
    expect(config.map.columns).toBe(Number(MANIFEST.params.gridColumns))
    expect(config.map.rows).toBe(Number(MANIFEST.params.gridRows))
  })
})
