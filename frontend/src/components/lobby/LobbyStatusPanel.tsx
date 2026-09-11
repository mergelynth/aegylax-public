import { appConfig, protocolGenesisBlock } from '../../config/env'
import { useEpochClock } from '../../hooks/useEpochClock'
import { useCountdownClock, useSmoothCountdown } from '../../hooks/useSmoothCountdown'
import { calculatePrizeBalance } from '../../game/economics'
import { getEpochStartBlock, launchEpochOf, predictAttackEpoch } from '../../game/epochs'
import { drawPrizePool, isProtocolOwnedLobby } from '../../game/globalDefense'
import { getConfiguredContractAddress } from '../../contracts/addresses'
import { lobbyPhaseLabel, operationStatusLabel, type LobbyPhase } from '../../game/lobbyPhase'
import type { Lobby } from '../../game/types'
import { useIncrease } from '../../motion/useIncrease'
import { formatEth, formatLongCountdown, shortenHex } from '../../utils/format'
import { ExplorerLink } from '../common/ExplorerLink'
import { StatTile } from '../common/StatTile'
import { PhaseStrip } from './PhaseStrip'
import styles from './LobbyStatusPanel.module.css'

/**
 * Where the operation stands right now, and — since ТЗ §1.2-1.3 moved
 * every parameter off the playfield — the only place its headline numbers
 * appear at all.
 *
 * It reports the derived lobby phase rather than the raw `LobbyStatus`,
 * because that is what the rest of the screen is showing: the Command
 * Center's countdown and this tile have to name the same state, and the
 * phase is the thing both are reading (ТЗ §15).
 */
export function LobbyStatusPanel({
  lobby,
  phase,
  drawBounty,
}: {
  lobby: Lobby
  phase: LobbyPhase
  /**
   * The Global Defense jackpot behind a protocol draw, when the page has a
   * better answer than the lobby carries — a round that ended without ever
   * escrowing it keeps no record of its own (see `useDrawBounty`).
   */
  drawBounty?: number | null
}) {
  // The app's one clock, so "Closes in" here and the same figure on the
  // hero are never a second apart.
  const nowMs = useCountdownClock()
  const { blockNumber, timestampMs } = useEpochClock()
  const blockTimeMs = appConfig.blockTimeMs

  const prize = calculatePrizeBalance(lobby.config, lobby.participantCount)
  /*
   * A protocol draw's bounty is not in the lobby until the round starts, so
   * `distributable` alone prints 0 through the whole application window —
   * on the tile a defender reads to decide whether to join.
   */
  const prizePool = drawPrizePool({
    lobbyPool: prize.distributable,
    startPrizePool: prize.startPrizePool,
    protocolOwned: isProtocolOwnedLobby(lobby.creator, getConfiguredContractAddress()),
    drawBounty: lobby.drawBounty ?? drawBounty,
  })
  /*
   * Somebody else joining. It is the only number on this panel that moves
   * because of a stranger, and on an operation still taking applications it
   * is the one a player is actually watching — the room filling is what
   * decides whether the round happens at all.
   */
  const joined = useIncrease(lobby.participantCount)
  const blocksUntilDeadline =
    lobby.config.participation.deadlineBlock > 0 && blockNumber !== null
      ? Math.max(0, lobby.config.participation.deadlineBlock - blockNumber)
      : null
  const msFromBlocks = useSmoothCountdown(blocksUntilDeadline, blockTimeMs, timestampMs)
  const msUntilDeadline = msFromBlocks ?? Math.max(0, lobby.config.participation.deadline - nowMs)
  const isAcceptingApplications = phase === 'OPEN' && msUntilDeadline > 0

  /*
   * Which epoch the threat flies in.
   *
   * The chain's own answer once the operation has started, and arithmetic
   * before that — the protocol schedules an attack for the epoch after the
   * one applications close in, so there is nothing to wait for and nobody to
   * ask. This tile used to show a dash for the whole of the application
   * window, on the one screen a defender opens to find out when the attack
   * is, and the dash was never a missing fact: it was a fact nobody had
   * computed.
   */
  const scheduledEpoch = lobby.currentEpochId
  const deadlineBlock = lobby.config.participation.deadlineBlock
  const predictedEpoch =
    scheduledEpoch ??
    (deadlineBlock > 0
      ? launchEpochOf(deadlineBlock, lobby.config.attack.epochBlocks, protocolGenesisBlock())
      : predictAttackEpoch({
          nowMs,
          deadlineMs: lobby.config.participation.deadline,
          blockNumber,
          epochBlocks: lobby.config.attack.epochBlocks,
          genesisBlock: protocolGenesisBlock(),
          blockTimeMs,
        }))
  const epochStartBlock =
    predictedEpoch === null
      ? null
      : getEpochStartBlock(predictedEpoch, lobby.config.attack.epochBlocks, protocolGenesisBlock())

  return (
    <div className={styles.grid}>
      <div className={styles.wide}>
        <StatTile label="Operation" value={lobby.config.name || shortenHex(lobby.id, 6)} />
      </div>
      {/*
        The status is drawn as a position on the operation's own track
        (`PhaseStrip`) — except for the terminals that never reached it. A
        cancelled or unplayed operation gets the word, because there is no
        honest place to put a marker for a round that did not happen.
      */}
      <div className={styles.wide}>
        <StatTile
          label="Status"
          value={
            phase === 'CANCELLED' ? (
              operationStatusLabel(lobby)
            ) : phase === 'UNDERSUBSCRIBED' ? (
              lobbyPhaseLabel(phase)
            ) : (
              <PhaseStrip phase={phase} />
            )
          }
        />
      </div>
      <StatTile
        label="Players"
        value={
          <span key={joined} className={joined > 0 ? styles.arrived : undefined}>
            {lobby.participantCount} / {lobby.config.participation.maxPlayers}
          </span>
        }
      />
      <StatTile label="Entry" value={formatEth(lobby.config.participation.entryPrice)} />
      {/*
        ТЗ §14.8 — what a winner would actually take: the creator's bounty
        plus what the entries leave after the Creator Fee. Showing the
        bounty alone understated the prize by every entry fee in the
        operation, on the exact screen somebody decides to join from.
      */}
      <StatTile label="Prize pool" value={formatEth(prizePool)} />
      <StatTile
        label={isAcceptingApplications ? 'Closes in' : 'Applications'}
        value={
          isAcceptingApplications
            ? formatLongCountdown(msUntilDeadline)
            : // A cancelled operation's applications did not merely close —
              // it never ran, and the tile should not imply one is coming.
              // UNPLAYED is the same terminal, named for the idle room
              // rather than the under-filled one.
              phase === 'CANCELLED'
              ? operationStatusLabel(lobby) === 'UNPLAYED'
                ? 'Unplayed'
                : 'Cancelled'
              : 'Closed'
        }
      />
      {/*
        The epoch, and — through it — the block the protocol will launch
        from, which is the one thing on this tile a player can go and check
        for themselves. `≈` is load-bearing: before the operation starts the
        number is derived from the block rate, and block time is not a
        protocol guarantee (§20).
      */}
      <StatTile
        label="Attack epoch"
        value={
          predictedEpoch === null ? (
            '—'
          ) : (
            <ExplorerLink kind="block" value={epochStartBlock}>
              {scheduledEpoch === null ? `≈ #${predictedEpoch}` : `#${predictedEpoch}`}
            </ExplorerLink>
          )
        }
      />
    </div>
  )
}
