import packageJson from '../../../package.json'
import type { LobbyConfig } from '../game/types'
import { appConfig, type AppConfig } from './env'

/** Base target for the global Apocalypse Timer (spec §15) — ENV-configurable, see `VITE_APOCALYPSE_BASE_DATE`. */
export const APOCALYPSE_BASE_TIMESTAMP = appConfig.apocalypse.baseTimestamp

/**
 * Shown in the Protocol Status popover.
 *
 * `0.MINOR.BUILD` on testnet: major 0 means the protocol is not frozen,
 * MINOR is the line in package.json, BUILD is the commit count so every
 * push to GitHub that Vercel ships is a new number. Pin with
 * `VITE_PROTOCOL_VERSION` when a build must not consult git.
 */
export const PROTOCOL_VERSION = import.meta.env.VITE_PROTOCOL_VERSION || packageJson.version

/**
 * Where the protocol's source lives (ТЗ §12).
 *
 * Linked from the Protocol Status panel, beside the contract addresses,
 * because it answers the same question they do: everything on that panel is
 * a claim about what the protocol does, and this is how a player checks it.
 */
export const SOURCE_REPOSITORY_URL = 'https://github.com/mergelynth/aegylax-public'

/**
 * The project's account on X, linked beside the source.
 *
 * It sits on the same row as the repository rather than somewhere of its own
 * because both answer "where does this come from" — one with the code, one
 * with the people. Neither is a claim the panel makes about the protocol, so
 * neither belongs above the disclosure.
 */
export const SOCIAL_X_URL = 'https://x.com/aegylax'

/**
 * How far Day X moves per outcome, globally (spec §16), and why the two
 * numbers are not the same one.
 *
 * A miss pulls the date closer by `APOCALYPSE_DAYS_PER_MISS`; an interception
 * pushes it away by `APOCALYPSE_DAYS_PER_INTERCEPT`, which is ten times as
 * large. So one successful defense buys back ten failures — the planet is
 * losing ground by default and every interception is visibly worth
 * something, rather than the two simply cancelling out.
 *
 * ENV-configurable: `VITE_APOCALYPSE_DAYS_PER_MISS`,
 * `VITE_APOCALYPSE_DAYS_PER_INTERCEPT`.
 */
export const APOCALYPSE_DAYS_PER_MISS = appConfig.apocalypse.daysPerMiss
export const APOCALYPSE_DAYS_PER_INTERCEPT = appConfig.apocalypse.daysPerIntercept

/** Form pre-fill only — the enforced ceiling is `ProtocolLimits.maxPlayers`. */
const DEFAULT_MAX_PLAYERS = 20

/**
 * Builds the default Defense Operation config template from ENV. The
 * Create Defense Operation form pre-fills these values and lets the
 * creator override only the ones they own — player limits, entry fee,
 * start prize pool, application deadline, creator fee and Recon Probe
 * settings — always within the protocol limits validated by
 * `game/lobby.ts`.
 *
 * The protocol-owned fields (`attack.*`, `economics.protocolJoinFee`) are
 * filled straight from protocol config and are never rendered as inputs:
 * they are game rules, not lobby parameters (spec §3, §17).
 */
export function buildDefaultLobbyConfig(config: AppConfig, nowMs: number): LobbyConfig {
  const oneDayMs = 24 * 60 * 60 * 1000
  const defaultRegistrationMs = Math.min(oneDayMs, config.protocol.maxRegistrationDurationMs)

  return {
    // Required, and deliberately not pre-filled: naming the operation is
    // the creator's call, and a default would just get accepted unread.
    name: '',
    participation: {
      minPlayers: config.protocol.minPlayers,
      // The protocol ceiling is the live GameParams.maxPlayers (25 on
      // Sepolia). Pre-fill a typical room rather than the gas ceiling.
      maxPlayers: Math.max(config.protocol.minPlayers, Math.min(config.protocol.maxPlayers, DEFAULT_MAX_PLAYERS)),
      // Clamped so the form always opens on a config that already passes
      // validation, whatever the protocol ranges are configured to.
      entryPrice: Math.min(
        Math.max(config.economics.defaultEntryPrice, config.protocol.minEntryPrice),
        config.protocol.maxEntryPrice,
      ),
      deadline: nowMs + Math.max(defaultRegistrationMs, config.protocol.minRegistrationDurationMs),
      /*
       * Filled in by the creation screen, which is the only place that knows
       * the chain's current block and how fast blocks are arriving — the two
       * things needed to turn the date above into the block the protocol
       * actually closes applications on. A template has neither, and
       * guessing one here would put a wrong deadline in front of a creator
       * who never touched the field.
       */
      deadlineBlock: 0,
    },
    economics: {
      prizePool: config.protocol.minStartPrizePool,
      creatorFeePercent: Math.min(config.economics.creatorFeePercent, config.protocol.maxCreatorFeePercent),
      protocolJoinFee: config.protocol.joinFee,
    },
    /*
     * Recon terms come from `protocol`, which is the chain's own params
     * layered over ENV (ТЗ §3).
     *
     * These are not defaults a creator adjusts: `validateLobbyConfig`
     * requires each one to *equal* the protocol's value, because recon is
     * protocol-owned. So sourcing them from anywhere other than the same
     * place the validator reads makes the form structurally capable of
     * opening on a config that can never be submitted — with the errors
     * landing on three fields the form does not even render, leaving Launch
     * Defense permanently refused and nothing on screen to explain it.
     *
     * They agree today only because the ENV file happens to match the
     * deployment. Reading one source removes the coincidence: change the
     * params on chain, re-run `chain:sync`, and the form follows.
     */
    drones: {
      freeCount: config.protocol.freeReconProbes,
      price: config.protocol.reconProbePrice,
      maxCount: config.protocol.maxReconProbes,
    },
    attack: {
      epochBlocks: config.protocol.epochBlocks,
      sectorSpanKm: config.protocol.sectorSpanKm,
      interceptionRadiusSectors: config.protocol.interceptionRadiusSectors,
      defenseSpeedKmPerBlock: config.protocol.defenseSpeedKmPerBlock,
    },
    payout: {
      rewardAsset: { kind: 'ETH' },
    },
  }
}
