import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { OperationArena } from '../components/arena/OperationArena'
import { AttackCountdown } from '../components/command/AttackCountdown'
import { CommandCenter } from '../components/command/CommandCenter'
import { ResultHud } from '../components/command/ResultHud'
import { DetailsPanel } from '../components/common/DetailsPanel'
import { ExplorerLink } from '../components/common/ExplorerLink'
import { StatTile } from '../components/common/StatTile'
import { DronePanel } from '../components/drones/DronePanel'
import { EarthSpaceViewport } from '../components/earth/EarthSpaceViewport'
import { LobbyIntro } from '../components/lobby/LobbyIntro'
import { LobbySidePanel, PanelSection } from '../components/lobby/LobbySidePanel'
import { LobbyStatusPanel } from '../components/lobby/LobbyStatusPanel'
import { OperationTerms, ReconProbeTerms } from '../components/lobby/LobbyTerms'
import { appConfig } from '../config/env'
import { getConfiguredContractAddress } from '../contracts/addresses'
import { calculateParticipantCost, calculatePrizeBalance, leaveRefundPreview } from '../game/economics'
import { drawPrizePool, isProtocolOwnedLobby } from '../game/globalDefense'
import { useDrawBounty } from '../hooks/useDrawBounty'
import { useGlobalDefenseDraw } from '../hooks/useGlobalDefenseDraw'
import {
  canRevealAttack,
  defenseBlockedReason,
  deriveLobbyPhase,
  probePurchaseBlockedReason,
  reconBlockedReason,
  showsReconnaissance,
} from '../game/lobbyPhase'
import type { AttackRevealData, DefensePoint, Hash } from '../game/types'
import { buildWorld } from '../game/world'
import { useBlockchainClient } from '../hooks/useBlockchainClient'
import { useDefense } from '../hooks/useDefense'
import { useEpochClock } from '../hooks/useEpochClock'
import { useLobby } from '../hooks/useLobby'
import { useLobbyActions, useConfidentialWarmup } from '../hooks/useLobbyActions'
import { useOperation } from '../hooks/useOperation'
import { useProtocolAdvance } from '../hooks/useProtocolAdvance'
import { useProtocolKeeper } from '../hooks/useProtocolKeeper'
import { mergeReconProbes } from '../game/recon'
import { useReconFog } from '../hooks/useReconFog'
import { useReconProbes } from '../hooks/useReconProbes'
import { useReveal, usesBackendKeeper } from '../hooks/useReveal'
import { useSettlement } from '../hooks/useSettlement'
import { useCountdownClock, useSmoothCountdown } from '../hooks/useSmoothCountdown'
import { useWallet } from '../hooks/useWallet'
import { selectLobbyPanelOpen, useUiStore } from '../stores/uiStore'
import { includesAddress, sameAddress } from '../utils/address'
import { formatBlockNumber, formatEth, shortenHex } from '../utils/format'
import { formatDefenseTiming, isAlreadyDown, isLateArrival, isTooEarly, isTooLate, previewDefenseTiming } from '../game/defense'
import styles from './LobbyPage.module.css'

const MAP_GRID = { columns: appConfig.map.columns, rows: appConfig.map.rows }

/**
 * How long a Defense Point has to stand still before it is encrypted ahead
 * of the send. Zero: the queue already keeps only the newest point, so
 * waiting here only delayed the proof. A player who places and presses
 * Defend should find the worker already going.
 */
const DEFENSE_ARM_DELAY_MS = 0

/**
 * ТЗ §12-13 — whether the verdict is *arriving* or merely *standing*.
 *
 * The shield, the shockwave and the trajectory drawing itself in are one
 * event: the instant the protocol hands the result over. Reopening an
 * operation that resolved last week is not that instant, and replaying the
 * strike every time somebody visits turns a record into a re-enactment —
 * which is both wrong and, on a page that reloads, relentless.
 *
 * So the announcement is earned rather than assumed: this client has to
 * have *seen the operation unrevealed* before the reveal landed. That is
 * true when a player presses Reveal, and it will stay true when the backend
 * starts pushing the result over a socket to everyone watching — which is
 * exactly the population that should see it happen.
 *
 * `loaded` is what makes it work. `data === null` alone cannot tell "nobody
 * has revealed" from "we have not asked yet", and on a reload the second is
 * momentarily true for every already-revealed operation — which is the bug
 * this replaces.
 */
function useRevealAnnouncement(revealed: AttackRevealData | null, loaded: boolean): boolean {
  const sawUnrevealed = useRef(false)
  const [announce, setAnnounce] = useState(false)

  useEffect(() => {
    if (!loaded) {
      // A different operation, or the answer not back yet. Neither is
      // evidence of anything, and both must clear a previous verdict.
      sawUnrevealed.current = false
      setAnnounce(false)
      return
    }
    if (!revealed) {
      sawUnrevealed.current = true
      return
    }
    if (sawUnrevealed.current) setAnnounce(true)
  }, [revealed, loaded])

  return announce
}

/**
 * How long the automatic reveal gets before the control goes back to the player.
 *
 * The keeper wakes a second after the impact block, unlocks, waits for the
 * confidential quorum and reveals — seconds, not minutes. This is the outer
 * edge of that, not the expected wait: long enough that a healthy reveal is
 * never interrupted by a button appearing beside it, short enough that a
 * keeper which is down does not leave the round looking merely slow.
 */
const REVEAL_PATIENCE_MS = 20_000

/**
 * Whether the automatic reveal has had its turn.
 *
 * The point of the delay is what it removes, not what it adds. A finished
 * round used to show a Reveal button the instant it ended, which asked the
 * player to take an action the backend was already taking — so the honest
 * reading of a press was "the app does not know what it is doing". While the
 * keeper is working the same slot says so instead, and only if it has not
 * finished in `REVEAL_PATIENCE_MS` does the control come back.
 */
function useRevealPatience(waiting: boolean): boolean {
  const [elapsed, setElapsed] = useState(false)
  useEffect(() => {
    setElapsed(false)
    if (!waiting) return
    const timer = window.setTimeout(() => setElapsed(true), REVEAL_PATIENCE_MS)
    return () => window.clearTimeout(timer)
  }, [waiting])
  return elapsed
}

/**
 * The Operation screen: one full-bleed space scene, exactly the shape the
 * Home page has, with Earth on the horizon at the bottom.
 *
 * The screen has two lives, and ТЗ §1.1 draws the line between them:
 *
 *   before the operation runs — the hero owns the screen. What this
 *     operation is, what joining costs, how long is left. The grid is
 *     drawn behind it as orientation and takes no clicks.
 *   once it runs — the hero is gone entirely, and every control the player
 *     has lives in the Command Center docked on Earth (§1.2). The scene is
 *     the playfield and nothing overlays it but the console.
 *
 * Everything else about the operation — full configuration, economics,
 * participants, activity — stays in the details drawer in both.
 */
export function LobbyPage() {
  const { id } = useParams<{ id: string }>()
  const lobbyId = (id ?? null) as Hash | null

  const client = useBlockchainClient()
  const { lobby, participants, refresh, loading, error } = useLobby(lobbyId)
  const { address, connect, status } = useWallet()
  const { blockNumber, timestampMs } = useEpochClock()
  const draw = useGlobalDefenseDraw()
  /*
   * A Global Defense round that ended without ever starting kept none of
   * the jackpot it was playing for, and the chain has nothing left to say
   * about it — see `useDrawBounty`. Null for every other operation, and for
   * a live draw, whose bounty arrives on the lobby itself.
   */
  const endedDrawBounty = useDrawBounty(lobby)
  // The app's one clock, shared with every countdown on the screen so the
  // phase and the timers can never disagree about whether a deadline passed.
  const nowMs = useCountdownClock()
  const blockTimeMs = appConfig.blockTimeMs
  const attackId = lobby?.activeAttackId ?? null
  const operation = useOperation(lobbyId, attackId)
  const blocksToImpact =
    operation.attack && blockNumber !== null && operation.attack.status === 'LAUNCHED'
      ? operation.attack.impactBlock - blockNumber
      : null
  const flightRemainingMs = useSmoothCountdown(blocksToImpact, blockTimeMs, timestampMs)
  // With no backend, the players looking at an operation are what moves it
  // past the transitions the clock owns — closing applications, and marking
  // an attack landed (ТЗ §10). Offered as a button, never taken on anybody's
  // behalf. No-op against the emulator, which settles them on every read.
  const advance = useProtocolAdvance(lobby, refresh)

  const selectedSector = useUiStore((state) => state.selectedSector)
  const stagedPoint = useUiStore((state) => state.stagedDefensePoint)
  const selectSector = useUiStore((state) => state.selectSector)
  const setStagedDefensePoint = useUiStore((state) => state.setStagedDefensePoint)
  const clearSelection = useUiStore((state) => state.clearSelection)
  // Scoped to this operation: the drawer's state is remembered per lobby,
  // so a choice made here never moves it on any other one.
  const isPanelOpen = useUiStore((state) => selectLobbyPanelOpen(state, lobbyId))
  const toggleLobbyPanel = useUiStore((state) => state.toggleLobbyPanel)

  const recon = useReconProbes(lobbyId, attackId, {
    recoverPending: operation.attack?.status !== 'RESOLVED' && lobby?.status !== 'RESOLVED' && lobby?.status !== 'CANCELLED',
  })
  const defense = useDefense(lobbyId)
  const reveal = useReveal(lobbyId, attackId)
  const { buyDrone, leave } = useLobbyActions()

  // Read before the empty-state returns below, because the settlement hook
  // needs it and hooks cannot live behind a branch.
  const participant = participants.find((p) => sameAddress(p.address, address)) ?? null
  /*
   * ТЗ §14.6, §17, §18 — everything the operation still owes this wallet:
   * the winner's reward, the refund a cancelled operation leaves behind, the
   * creator's settlement. Each is a transaction its owner sends, and none of
   * them happens to anybody automatically.
   */
  const claims = useSettlement(lobby, participant, refresh)
  const confidentialReadsDue =
    participant !== null &&
    operation.attack?.status !== 'RESOLVED' &&
    lobby?.status !== 'RESOLVED' &&
    lobby?.status !== 'CANCELLED' &&
    !reveal.scored
  useConfidentialWarmup(confidentialReadsDue)

  /*
   * ТЗ §5 — the Defense Point, encrypted while it is still being aimed.
   *
   * Placing the marker and pressing Defend are two separate acts, seconds
   * apart, and the whole cost of a confidential submit sits between the
   * second one and the wallet: a WASM proof over an FHE key, then a round
   * trip to the network's verifier. Doing it here moves that cost into the
   * gap the player spends deciding, so the button opens the wallet instead
   * of going quiet for several seconds while a threat closes.
   *
   * Only while a defence could actually be sent — a marker dropped before
   * the launch, or after this wallet's attempt is already on chain, is not
   * a submit waiting to happen and does not deserve a proof.
   */
  const pointToArm =
    confidentialReadsDue && operation.attack?.status === 'LAUNCHED' && operation.ownAttempt === null
      ? stagedPoint
      : null
  const armDefense = defense.prepare
  useEffect(() => {
    if (!pointToArm) return
    // Settled on, not passed over: nudging the marker across a sector is a
    // few clicks, and each one would otherwise be a proof and a verifier
    // request for a point that is about to be abandoned.
    const timer = window.setTimeout(() => armDefense(pointToArm), DEFENSE_ARM_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [pointToArm, armDefense])

  // ТЗ §12-13 — is the result arriving, or is it a week old? See above.
  const announceReveal = useRevealAnnouncement(reveal.scored ? reveal.data : null, reveal.loaded)

  /*
   * ТЗ §4, §10 — the reveal, asked of the backend keeper rather than signed
   * in this tab. The control stays on screen until the round is scored, and
   * a press (or this hook, for anyone with a stake) only nudges the sweep.
   */
  // Derived here rather than reusing `lobbyPhase` below, because hooks
  // cannot live behind the empty-state returns and that one cannot be
  // computed before them.
  const keeperPhase = lobby ? deriveLobbyPhase(lobby, operation.attack, blockNumber, nowMs) : null
  const keeper = useProtocolKeeper({
    lobby,
    attackId,
    phase: keeperPhase,
    revealLoaded: reveal.loaded,
    // This operation's own scoring, not the epoch's publication — see
    // `canRevealAttack`. Keyed on the publication, the keeper would stand down
    // on every team but the first to reveal, leaving their pools unscored.
    isScored: reveal.scored,
    reveal: reveal.request,
    onRevealed: refresh,
  })

  /*
   * Whether this round's reveal is somebody else's job.
   *
   * With a backend keeper it is: the page posts a nudge, the keeper's own
   * wallet signs, and the result arrives on the block feed. The same two
   * facts have to be read here, before the empty-state returns, because the
   * patience timer below is a hook.
   */
  const revealDue =
    keeperPhase !== null &&
    canRevealAttack({ lobbyPhase: keeperPhase, revealLoaded: reveal.loaded, isScored: reveal.scored })
  const revealPatienceOver = useRevealPatience(revealDue && usesBackendKeeper(client))

  // ТЗ §5 — what the protocol actually paid back on the way out. Held here
  // because leaving removes the participant, so there is nothing left on
  // chain for the confirmation to be read off afterwards.
  const [refunded, setRefunded] = useState<number | null>(null)

  // Leaving an operation — or switching the wallet looking at it — must not
  // carry the previous pick into the next identity.
  useEffect(() => clearSelection, [lobbyId, address, clearSelection])

  const world = useMemo(
    () => buildWorld(MAP_GRID, lobby?.config.attack.sectorSpanKm ?? appConfig.protocol.sectorSpanKm),
    [lobby?.config.attack.sectorSpanKm],
  )

  // ТЗ §1.2-1.4 — every probe this wallet has sent, fused into one field of
  // fog, and delivered by the wave rather than the transaction.
  const reconPending = recon.status === 'preparing' || recon.status === 'pending'
  const { estimate, waveKey, scanning } = useReconFog(recon.results, world, recon.live)

  // Both empty states stay on the scene rather than dropping to a bare line
  // of text on the page background — the shell never changes shape.
  if (!lobbyId) {
    return (
      <EarthSpaceViewport variant="hero">
        <p className={styles.notice}>Invalid operation link.</p>
      </EarthSpaceViewport>
    )
  }
  if (!lobby) {
    return (
      <EarthSpaceViewport variant="hero">
        <p className={styles.notice}>
          {loading
            ? 'Loading operation…'
            : error
              ? error
              : 'Operation not found. It may have only existed in another browser tab, or was created before persistence was enabled.'}
        </p>
      </EarthSpaceViewport>
    )
  }
  if (lobby.status === 'RESOLVED' && attackId && !reveal.loaded && !reveal.error) {
    return (
      <EarthSpaceViewport variant="hero">
        <p className={styles.notice}>Loading operation…</p>
      </EarthSpaceViewport>
    )
  }

  const hasJoined = participant !== null
  const probesOwned = lobby.config.drones.freeCount + (participant?.purchasedDrones ?? 0)
  /*
   * Spent = whatever the chain already recorded, or whatever this screen
   * has actually sent (readings plus anything still in flight). The chain
   * list lags the press — Inco can sit on the hint for many blocks — and
   * the badge was stuck on the opening allotment until the participant
   * record caught up.
   */
  const probesUsed = Math.max(participant?.probeIds.length ?? 0, recon.results.length + recon.pendingCount)
  const probesAvailable = Math.max(0, probesOwned - probesUsed)

  /*
   * ТЗ §5 — what leaving gives back: everything this wallet actually put
   * into the operation. On a player lobby that is entry, the author's
   * commission and every Recon Probe. On the protocol's own draw the seat
   * itself is free, so the control only names probe spend.
   *
   * It is `paidIn` (or probe spend on a protocol draw), the protocol's own
   * record, rather than the same sum recomputed from the current config.
   */
  const protocolOwned = isProtocolOwnedLobby(lobby.creator, getConfiguredContractAddress())
  const refundable = participant
    ? leaveRefundPreview({
        protocolOwned,
        paidIn: participant.paidIn,
        probesPaid: participant.probesPaid,
      })
    : calculateParticipantCost(
        lobby.config.participation.entryPrice,
        lobby.config.economics.creatorFeePercent,
        protocolOwned,
      )

  /*
   * What this operation is playing for, in the one place the rest of the
   * screen reads it from. A Global Defense draw does not hold its bounty
   * until the round starts (`commitDrawBounty`), so the lobby's own figures
   * are 0 for the whole application window and stay 0 on a room that never
   * filled — see `drawPrizePool`.
   */
  const prizePool = drawPrizePool({
    lobbyPool: calculatePrizeBalance(lobby.config, lobby.participantCount).distributable,
    startPrizePool: lobby.config.economics.prizePool,
    protocolOwned,
    drawBounty: lobby.drawBounty ?? endedDrawBounty,
  })

  const { attack, ownAttempt, ownDefensePoint } = operation
  /*
   * `nowMs` is what lets the phase notice a deadline that passed with too
   * few defenders (ТЗ §18) — nothing on chain changes at that moment, so
   * without a clock the operation reads OPEN until somebody cancels it.
   */
  const lobbyPhase = deriveLobbyPhase(lobby, attack, blockNumber, nowMs)
  /*
   * The probe is "in flight" from the press until the wave has delivered
   * its fog — one gesture, not a transaction plus an animation. Nothing on
   * the map moves during it, so this is the *only* thing on screen saying
   * a probe is out: the Send control has to stay visibly busy for the
   * whole wait or the button reads as broken.
   */
  const isScanning = reconPending || scanning

  /*
   * When this wallet last probed, from both things that know.
   *
   * `participant.lastProbeBlock` is the protocol's own answer and the one
   * that matters, but it arrives on the next read of the chain — which
   * leaves a gap right after a send where the control looks live and the
   * transaction would revert. The readings in hand close it: a probe's
   * record carries the block it was sent in, and it is here the moment the
   * send returns.
   */
  const lastProbeBlock = recon.results.reduce(
    (latest, probe) => Math.max(latest, probe.generatedAtBlock),
    participant?.lastProbeBlock ?? 0,
  )

  const reconBlocked = reconBlockedReason({
    hasJoined,
    lobbyPhase,
    probesRemaining: probesAvailable,
    submittedAttempt: ownAttempt,
    lastProbeBlock,
    currentBlock: blockNumber,
  })
  // ТЗ §3 — probes are equipment, bought before the launch. See the rule.
  const purchaseBlocked = probePurchaseBlockedReason({
    hasJoined,
    lobbyPhase,
    probesOwned,
    maxProbes: lobby.config.drones.maxCount,
  })
  const defenseBlocked = defenseBlockedReason({
    hasJoined,
    lobbyPhase,
    submittedAttempt: ownAttempt,
    selectedSectorId: selectedSector ? `${selectedSector.column}:${selectedSector.row}` : null,
    stagedPoint,
    lastProbeBlock,
    currentBlock: blockNumber,
  })

  // What the countdown is counting towards: the launch while the attack is
  // pending, the impact once it is in flight (ТЗ §2.1, §4.1).
  const blocksToEvent =
    attack === null || blockNumber === null
      ? null
      : attack.status === 'PENDING'
        ? attack.launchBlock - blockNumber
        : attack.impactBlock - blockNumber

  const outcome = lobby.outcome
  /*
   * ТЗ §12-§13, §16 — the planet's verdict belongs to the *reveal*, not to
   * resolution.
   *
   * Impact ends the epoch and settles the result on chain, but ТЗ §4 makes
   * somebody ask before any of the geometry is shown. Flashing the globe
   * red the instant the block lands would answer the question the Reveal
   * button exists to ask — there would be nothing left to reveal. So the
   * scene stays neutral, the Reveal control pulses for attention, and the
   * shield or the shockwave fires when the protocol hands the result over.
   */
  /*
   * Two different things, and only one of them is drawable.
   *
   * `reveal.data` is the epoch's geometry: one transaction publishes it for
   * the whole world, so an operation sharing an epoch usually finds it
   * already there. `verdict` is *this team's* scoring — a separate
   * transaction, and the only thing that can say where the threat was
   * stopped, who won and what the planet's fate was.
   *
   * The screen used to draw the trajectory the instant the epoch published
   * it, without waiting for the scoring, and that was wrong on the one frame
   * it mattered. An unscored round has a zeroed outcome: no interception
   * point, `intercepted` false. `AttackReveal` reads exactly those fields to
   * decide where the trail *stops* — so the geometry-only pass drew the beam
   * carried all the way through everybody's radius into Earth, with an impact
   * marker on the planet, for an attack that had in fact been shot down. The
   * scoring landed a few seconds later and redrew it correctly, which is what
   * a player sees as the beam being drawn twice with the first one wrong.
   *
   * So nothing is drawn until the round is scored. The trajectory is not
   * withheld to make the reveal feel earned — it is withheld because before
   * the scoring the app does not yet know where it ends, and a trajectory
   * drawn to the wrong endpoint is not a partial answer, it is a false one.
   * The wait is short and shrinking: `useProtocolKeeper` sends the reveal
   * without being asked, and it is now two transactions rather than four.
   */
  const verdict = reveal.scored ? reveal.data : null
  const earthState = verdict ? (verdict.outcome.intercepted ? 'intercepted' : 'impacted') : 'idle'
  /*
   * ТЗ §6 — once the attack has landed, the planet holds the exact face it
   * wore at the moment of impact, forever, for this operation.
   *
   * The pin is the impact's own *block timestamp*, read back off the
   * outcome, and the angle is recomputed from it on every render. That is
   * what makes it survive a reload, agree across browsers and still be
   * right in a month: a finished operation is a record, and the
   * trajectory, the impact point and every Defense Point are pinned to
   * specific places on that globe. A planet that kept turning underneath
   * them — or that froze at whatever angle one tab happened to render last
   * — would quietly turn the picture into a lie.
   *
   * A cancelled operation is not frozen: no attack ever happened, so there
   * is no moment for the globe to be a record of.
   */
  const earthFrozenAtMs = outcome?.resolvedAtTimestamp ?? null
  const ownResult =
    verdict && address ? verdict.results.find((result) => sameAddress(result.participant, address)) : undefined
  const ownInterception =
    verdict && ownAttempt ? includesAddress(verdict.outcome.winners, ownAttempt.participant) : null
  const settledNote = ownResult
    ? isAlreadyDown(ownResult)
      ? 'ALREADY DOWN — prize went to the station that hit first'
      : isTooLate(ownResult) || isLateArrival(ownResult)
        ? 'TOO LATE — threat already passed'
        : isTooEarly(ownResult)
          ? 'TOO EARLY — threat was not there yet'
          : ownResult.isWinner
            ? null
            : 'No prize for this station'
    : outcome && !outcome.intercepted
      ? 'Miss — prize went to Global Defense'
      : outcome?.intercepted
        ? 'No prize for this station'
        : 'Round complete'

  /**
   * ТЗ §1.1, §4 — one press sends one probe. The button is still the whole
   * transaction: there is nothing to confirm, because where the probe looks
   * follows from what the player already knows.
   *
   * The first probe sweeps, because there is nothing yet to point at, and
   * what it hands back is a direction. Every probe after it is aimed into
   * the area the fix has found — which is what a player would do by hand,
   * and is honestly fallible: the fix is an estimate, so aiming at a poor
   * one is aiming wrong, and the reading comes back as vague as the guess
   * deserved.
   */
  const handleSendRecon = () => {
    if (!attack || reconBlocked !== null) return
    const aim = mergeReconProbes(recon.results)?.bearingDegrees ?? null
    recon.send(attack.id, `probe-${probesUsed + 1}`, aim).then(refresh)
  }

  const handleSendDefense = () => {
    if (!attack || !stagedPoint || defenseBlocked !== null) return
    defense.submit(attack.id, stagedPoint).then(() => {
      refresh()
      operation.refresh()
    })
  }


  /**
   * ТЗ §1.1-1.2: the hero exists only while the operation has not started.
   * Once it is running, every gameplay control is in the Command Center and
   * the hero would be a block of text sitting on top of sectors the player
   * needs to click.
   *
   * The console is a player's controls — recon, intercept, claim. A wallet
   * that never took a seat has none of those. An unsigned visitor still
   * gets the rail, with Sign in, once applications have closed: hiding it
   * left the planet empty and the header as the only way in.
   */
  const isUnderWay =
    lobbyPhase !== 'OPEN' && lobbyPhase !== 'CANCELLED' && lobbyPhase !== 'UNDERSUBSCRIBED'
  const showCommandRail =
    claims.length > 0 || (isUnderWay && hasJoined) || (!address && lobbyPhase !== 'OPEN')
  // ТЗ §4.5 — grid selection unlocks when the attack launches, not when the
  // operation does. Before that there is nothing in the sky to defend
  // against, and a pick made against it would mean nothing.
  const isGridInteractive = lobbyPhase === 'ATTACK_ACTIVE' && hasJoined && ownAttempt === null

  /*
   * ТЗ §4 — Reveal is offered on a round that has finished, to anybody at
   * all, and stops being offered the moment the first person takes it. From
   * then on `reveal.data` simply arrives from the chain for every client
   * that opens the operation. See `canRevealAttack` for why the operation's
   * outcome is deliberately not part of the condition.
   */
  const canRequestReveal = canRevealAttack({
    lobbyPhase,
    revealLoaded: reveal.loaded,
    isScored: reveal.scored,
  })

  /*
   * The reveal is under way without anybody pressing anything.
   *
   * Held until the keeper has either finished, failed out loud, or run past
   * `REVEAL_PATIENCE_MS` — after which the manual control is the honest
   * offer again, because something is not going to plan and asking is
   * better than a spinner that never ends.
   */
  const revealAuto =
    canRequestReveal && usesBackendKeeper(client) && keeper.error === null && !revealPatienceOver

  const defensePoint = ownDefensePoint ?? stagedPoint
  const defenseTiming =
    defensePoint && attack && blockNumber !== null
      ? previewDefenseTiming({
          point: defensePoint,
          world,
          nowBlock: blockNumber,
          submittedAtBlock: ownAttempt?.submittedAtBlock,
          launchBlock: attack.launchBlock,
          flightBlocks: attack.flightDurationBlocks,
          defenseSpeedKmPerBlock: lobby.config.attack.defenseSpeedKmPerBlock,
          axis: estimate?.axis ?? null,
        })
      : null
  const reconProgress =
    attack &&
    flightRemainingMs !== null &&
    lobbyPhase === 'ATTACK_ACTIVE' &&
    estimate
      ? Math.min(1, Math.max(0, 1 - flightRemainingMs / Math.max(1, attack.flightDurationBlocks * blockTimeMs)))
      : null
  const reconFlightMs =
    attack && lobbyPhase === 'ATTACK_ACTIVE' ? attack.flightDurationBlocks * blockTimeMs : null

  /*
   * ТЗ §7-§8 — the estimate comes off the map when the round is answered,
   * and stays off while the app is still finding out whether it was. See
   * `showsReconnaissance` for why this is not `verdict !== null`.
   */
  const showRecon = showsReconnaissance({
    lobbyPhase,
    revealLoaded: reveal.loaded,
    isScored: reveal.scored,
  })

  return (
    <>
      <EarthSpaceViewport
        variant="hero"
        earthState={earthState}
        earthFrozenAtMs={earthFrozenAtMs}
        earthAnnounce={announceReveal}
      >
        <OperationArena
          grid={MAP_GRID}
          world={world}
          estimate={showRecon ? estimate : null}
          waveKey={showRecon ? waveKey : null}
          interactive={isGridInteractive}
          selectedSector={selectedSector}
          stagedPoint={stagedPoint}
          submittedPoint={ownDefensePoint}
          onSelectSector={selectSector}
          onPlacePoint={(point: DefensePoint) => setStagedDefensePoint(point)}
          interceptionRadiusSectors={lobby.config.attack.interceptionRadiusSectors}
          underAttack={lobbyPhase === 'ATTACK_ACTIVE'}
          // Scored only. Where the trail ends is part of the verdict, so
          // the geometry on its own is not enough to draw — see above.
          reveal={verdict}
          viewer={address}
          showGridLabels={appConfig.map.showGridLabels}
          animateReveal={announceReveal}
          reconProgress={showRecon ? reconProgress : null}
          reconRemainingMs={showRecon && reconProgress !== null ? flightRemainingMs : null}
          reconFlightMs={showRecon ? reconFlightMs : null}
        />

        {isUnderWay ? (
          /*
            ТЗ §1.1 — the countdown takes the hero's place. Once the
            operation is running, "when does it land" is the screen's
            headline, and it stands exactly where the title and the join
            call used to.
          */
          <div className={styles.banner}>
            <AttackCountdown
              phase={lobbyPhase}
              blocksRemaining={blocksToEvent}
              blockTimeMs={blockTimeMs}
              chainTimestampMs={timestampMs}
              // One epoch either way: an attack launches on one boundary and
              // lands on the next, so the wait and the flight are the same
              // length and the bar means the same thing in both.
              totalBlocks={lobby.config.attack.epochBlocks}
              intercepted={verdict?.outcome.intercepted ?? lobby.outcome?.intercepted ?? null}
              /*
               * Null for anybody who did not defend this operation.
               *
               * The fallback used to read the winners list for any signed-in
               * address, which answers `false` for a passer-by exactly as it
               * does for a defender who missed — so a stranger opening a
               * finished round was told DEFENSE FAILED about a defense they
               * never sent. `hasJoined` is the difference between "lost" and
               * "was not playing", and the banner needs it to stay quiet
               * rather than guess.
               */
              ownDefenseSucceeded={
                ownInterception ??
                (lobby.outcome && address && hasJoined
                  ? includesAddress(lobby.outcome.winners, address)
                  : null)
              }
              ownAlreadyDown={ownResult ? isAlreadyDown(ownResult) : false}
              revealLoaded={reveal.loaded}
              revealAuto={revealAuto}
            />
            {/*
              ТЗ §10 — the summary row, under the verdict and only once the
              operation has been revealed. Every figure in it is revealed
              state; before that there is nothing honest to put here.
            */}
            {verdict ? <ResultHud reveal={verdict} participants={participants} viewer={address} /> : null}
          </div>
        ) : (
          /*
            The hero: what this operation is, where it stands, and the one
            action a visitor came to take. It owns the top of the scene
            right up to the moment the operation starts, and then goes.
          */
          <LobbyIntro
            lobby={lobby}
            phase={lobbyPhase}
            hasJoined={hasJoined}
            onJoined={refresh}
            onLeave={() =>
              leave.run(lobby.id).then((amount) => {
                if (amount !== null) setRefunded(amount)
                refresh()
              })
            }
            isLeaving={leave.status === 'preparing' || leave.status === 'pending'}
            refundable={refundable}
            refunded={refunded}
            advance={advance}
            participant={participant}
            onBuyProbe={() => buyDrone.run(lobby.id, lobby.config.drones.price).then(refresh)}
            isBuyingProbe={buyDrone.status === 'preparing' || buyDrone.status === 'pending'}
            probePurchaseBlocked={purchaseBlocked}
            probePurchaseError={buyDrone.error}
          />
        )}

        {showCommandRail ? (
          <CommandCenter
            lobbyPhase={lobbyPhase}
            potEth={prizePool}
            probesAvailable={probesAvailable}
            probesUsed={probesUsed}
            probesMax={lobby.config.drones.maxCount}
            stagedPoint={stagedPoint}
            submittedPoint={ownDefensePoint}
            onSendRecon={handleSendRecon}
            reconBlockedReason={reconBlocked}
            isReconBusy={isScanning}
            isReconSending={recon.sending}
            onSendDefense={handleSendDefense}
            defenseBlockedReason={defenseBlocked}
            isDefenseBusy={defense.status === 'preparing' || defense.status === 'pending'}
            isDefenseArming={defense.arming}
            canRequestReveal={canRequestReveal}
            revealAuto={revealAuto}
            onRequestReveal={() => {
              void reveal.request().catch(() => {
                // Reported through `reveal.error`; do not reject into the click.
              })
            }}
            isRevealBusy={reveal.busy}
            claims={claims}
            /*
             * Whatever the console's own last action failed with, next to
             * the console. The drawer below still lists all of them — it is
             * where a player goes to read the detail — but the one thing a
             * press was answered with has to be visible without opening
             * anything. Ordered by which control the player most recently
             * used: a stale probe error must not sit on top of the defense
             * they just tried to send.
             */
            error={defense.error ?? recon.error ?? reveal.error ?? keeper.error}
            defenseTimingNote={
              defenseTiming && blockNumber !== null ? formatDefenseTiming(defenseTiming, blockNumber) : null
            }
            defenseTimingLate={defenseTiming?.late ?? false}
            defenseTimingEarly={defenseTiming?.early ?? false}
            settledNote={settledNote}
            attackIntercepted={verdict?.outcome.intercepted ?? lobby.outcome?.intercepted ?? null}
            ownHit={ownResult?.isWinner === true || ownInterception === true}
            onSignIn={!address ? () => void connect() : null}
            isSignInBusy={status === 'initializing'}
          />
        ) : null}
      </EarthSpaceViewport>

      {/*
        ТЗ §1.2: every operation parameter lives here and only here — prize
        pool, entry, players, deadline, operation id included. Once the hero
        is gone this drawer is also where the operation's name still is.
      */}
      <LobbySidePanel open={isPanelOpen} onToggle={() => toggleLobbyPanel(lobbyId)}>
        <PanelSection title="Status">
          <LobbyStatusPanel lobby={lobby} phase={lobbyPhase} drawBounty={endedDrawBounty} />
        </PanelSection>

        {outcome ? (
          <PanelSection title="Result">
            <div className={styles.detailsGrid}>
              <StatTile label="Outcome" value={outcome.intercepted ? 'TARGET INTERCEPTED' : 'TARGET REACHED'} />
              <StatTile
                label="Winner"
                value={
                  outcome.winners.length === 0 ? (
                    '—'
                  ) : (
                    <ExplorerLink kind="address" value={outcome.winners[0]}>
                      {shortenHex(outcome.winners[0])}
                    </ExplorerLink>
                  )
                }
              />
              <StatTile label="Reward" value={formatEth(outcome.rewardPerWinner)} />
              <StatTile
                label="Interception block"
                value={
                  outcome.interceptionBlock === null ? (
                    '—'
                  ) : (
                    <ExplorerLink kind="block" value={Math.round(outcome.interceptionBlock)}>
                      {formatBlockNumber(Math.round(outcome.interceptionBlock))}
                    </ExplorerLink>
                  )
                }
              />
            </div>
          </PanelSection>
        ) : null}

        {/*
          ТЗ §14.3-14.5 — after the reveal, everyone's attempt with its
          verdict and, for the successful ones, the snapshot they hit.
          The list is the audit trail behind the winners shown above.
        */}
        {verdict ? (
          <PanelSection title="Defense Points">
            <ul className={styles.results} data-guide="defense-points">
              {verdict.results.map((result) => (
                <li key={result.attemptId} className={styles.result}>
                  <span className={styles.resultWho}>
                    <ExplorerLink kind="address" value={result.participant}>
                      {shortenHex(result.participant)}
                    </ExplorerLink>
                    {sameAddress(result.participant, address) ? ' · you' : ''}
                  </span>
                  <span
                    className={
                      result.isWinner ? styles.hit : isAlreadyDown(result) ? styles.outranked : styles.miss
                    }
                  >
                    {result.isWinner
                      ? 'HIT · WINNER'
                      : isAlreadyDown(result)
                        ? 'HIT · OUTRANKED'
                        : isTooLate(result)
                          ? 'LATE'
                          : isTooEarly(result)
                            ? 'EARLY'
                            : 'MISS'}
                  </span>
                  <span className={styles.resultWhen}>
                    {isLateArrival(result)
                      ? `on path · late by ${Math.max(1, Math.round((result.arrivalBlock ?? 0) - (result.interceptionBlock ?? 0)))} blk`
                      : isTooEarly(result)
                        ? `on path · early by ${Math.max(1, Math.round((result.interceptionBlock ?? 0) - (result.arrivalBlock ?? 0)))} blk`
                        : isAlreadyDown(result)
                        ? 'on path · already intercepted'
                        : result.interceptionBlock === null
                          ? `${Math.round(result.missDistanceKm ?? 0)} km off`
                          : `block ${formatBlockNumber(Math.round(result.interceptionBlock))}`}
                  </span>
                </li>
              ))}
            </ul>
          </PanelSection>
        ) : null}

        <PanelSection title="Operation">
          <OperationTerms
            lobby={lobby}
            advertisedPrizePool={
              protocolOwned
                ? drawPrizePool({
                    lobbyPool: lobby.config.economics.prizePool,
                    startPrizePool: lobby.config.economics.prizePool,
                    protocolOwned,
                    // The header's figure while it is about this room — it
                    // has already folded a leftover draw's escrow in — and
                    // the lobby's own record everywhere else.
                    drawBounty:
                      draw.drawLobbyId === lobby.id && draw.ready
                        ? draw.jackpot
                        : (lobby.drawBounty ?? endedDrawBounty),
                  })
                : undefined
            }
          />
        </PanelSection>

        <PanelSection title="Recon Probes">
          {hasJoined ? (
            /*
              After the round starts the hero — and its Buy probe — is gone.
              Probes are still equipment until the attack launches, so the
              purchase has to live here too or there is a window where the
              only way to buy is a button that is no longer on the screen.
            */
            <DronePanel
              layout="drawer"
              lobby={lobby}
              participant={participant}
              onBuyDrone={() => buyDrone.run(lobby.id, lobby.config.drones.price).then(refresh)}
              isPurchasing={buyDrone.status === 'preparing' || buyDrone.status === 'pending'}
              blockedReason={purchaseBlocked}
              error={buyDrone.error}
            />
          ) : null}
          <ReconProbeTerms lobby={lobby} />
        </PanelSection>

        {/*
          Defenders and Public Activity are deliberately not here.

          Both rendered one row per record with no ceiling on how many there
          are: the roster grows with the operation's size and the heatmap
          grows with everything that has ever been sent against it. That is
          fine at a table of twelve and untenable at the scale this is meant
          to reach — tens of thousands of entries, every one of them fetched
          and laid out to fill a drawer nobody scrolls to the end of.

          They come back when they are paged and summarised rather than
          enumerated, which is a change to how the data is read rather than
          to how it is drawn. Until then the count that matters is in the
          stat tiles below, and the per-defender verdicts are in Defense
          Points above, which is bounded by the attempts in *this* round.
        */}

        {/*
          ТЗ §12 — the four identifiers, every one of them looked up on the
          active network's explorer rather than printed as dead text. The
          base URL comes from the deployment manifest (`utils/explorer`), so
          these follow the app from Base Sepolia to a mainnet deployment
          without an edit here.

          The operation id is its creation transaction — `lobby.id ===
          creationTxHash` by construction — so it links as a tx, which also
          makes the identity claim checkable rather than asserted.
        */}
        <DetailsPanel>
          <div className={styles.detailsGrid}>
            <StatTile
              label="Operation ID"
              value={
                <ExplorerLink kind="tx" value={lobby.id}>
                  {shortenHex(lobby.id, 6)}
                </ExplorerLink>
              }
            />
            <StatTile
              label="Creator"
              value={
                <ExplorerLink kind="address" value={lobby.creator}>
                  {shortenHex(lobby.creator)}
                </ExplorerLink>
              }
            />
            <StatTile
              label="Created at block"
              value={
                <ExplorerLink kind="block" value={lobby.createdAtBlock}>
                  {formatBlockNumber(lobby.createdAtBlock)}
                </ExplorerLink>
              }
            />
            <StatTile
              label="Current block"
              value={
                blockNumber === null ? (
                  formatBlockNumber(blockNumber)
                ) : (
                  <ExplorerLink kind="block" value={blockNumber}>
                    {formatBlockNumber(blockNumber)}
                  </ExplorerLink>
                )
              }
            />
          </div>
        </DetailsPanel>

        {defense.error && !isHudNoise(defense.error) ? <p className={styles.error}>{defense.error}</p> : null}
        {recon.error && !isHudNoise(recon.error) ? <p className={styles.error}>{recon.error}</p> : null}
        {reveal.error && !isHudNoise(reveal.error) ? <p className={styles.error}>{reveal.error}</p> : null}
        {/* The automatic attempt's failure, reported separately: the Reveal
            control is still there to press, and its own error is a different
            fact from this one. */}
        {keeper.error && !reveal.error && !isHudNoise(keeper.error) ? (
          <p className={styles.error}>{keeper.error}</p>
        ) : null}
        {leave.error ? <p className={styles.error}>{leave.error}</p> : null}
      </LobbySidePanel>
    </>
  )
}

function isHudNoise(message: string): boolean {
  const text = message.trim()
  return /^not found$/i.test(text) || /\b404\b/.test(text)
}
