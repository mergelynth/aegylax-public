import { useEffect, useMemo, useState } from 'react'
import { appConfig, protocolGenesisBlock } from '../config/env'
import { getGlobalDefenseDraw, getLobby } from '../game/gameService'
import { getEpochFromBlock } from '../game/epochs'
import { globalDefenseSchedule, isInGlobalDefenseJoinWindow, resolveJackpot } from '../game/globalDefense'
import { canJoinLobby } from '../game/lobby'
import type { GlobalDefenseDraw, Hash, Lobby } from '../game/types'
import { useBlockchainClient } from './useBlockchainClient'
import { useEpochClock } from './useEpochClock'

export interface GlobalDefenseHudState {
  /** Idle pool waiting for the next draw. */
  pool: number
  /**
   * Idle pool plus any bounty already escrowed in a live or leftover draw.
   * 0 only when both are empty — the trophy hides then, rather than paint 0.
   */
  jackpot: number
  lobbyId: Hash | null
  /** True only while the join window is open and applications are accepted. */
  joinable: boolean
  /** Draw exists but applications have closed — waiting for the attack or settling. */
  inPlay: boolean
  nextEpoch: number
  interval: number
  openFromBlock: number | null
  deadlineBlock: number | null
  /**
   * False until the first draw (+ lobby, if one exists) has landed.
   * The trophy must not paint 0 in that gap — that is a load, not an
   * empty pool.
   */
  ready: boolean
  /**
   * The protocol lobby currently holding (or leftover with) the bounty,
   * even outside the join window. The header keeper uses this to close an
   * under-filled draw; `lobbyId` stays null then so the trophy does not
   * look like a joinable room.
   */
  drawLobbyId: Hash | null
  drawLobby: Lobby | null
}

/**
 * The Global Defense jackpot, as the header should see it.
 *
 * The protocol opens the lobby itself once the join window starts — on
 * chain as a side effect of ordinary play, in the emulator on the block
 * tick. This hook never sends `openGlobalDefense`. A trophy click that
 * minted the lobby at epoch 462 for a draw at 1000 is how the jackpot
 * vanished from the header and a closed-looking room appeared too early.
 *
 * The link is offered only inside the join window, even if a leftover
 * lobby already exists on chain: until then the tooltip counts down to
 * when it *opens*, not to when that premature room closes.
 */
export function useGlobalDefenseDraw(): GlobalDefenseHudState {
  const client = useBlockchainClient()
  const { blockNumber } = useEpochClock()
  const [draw, setDraw] = useState<GlobalDefenseDraw | null>(null)
  const [lobby, setLobby] = useState<Lobby | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const next = await getGlobalDefenseDraw(client)
        if (cancelled) return
        if (!next.lobbyId) {
          setDraw(next)
          setLobby(null)
          setReady(true)
          return
        }
        const nextLobby = await getLobby(client, next.lobbyId).catch(() => null)
        if (cancelled) return
        setDraw(next)
        setLobby(nextLobby)
        setReady(true)
      } catch {
        if (!cancelled) {
          setDraw(null)
          setLobby(null)
          setReady(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, blockNumber])

  const schedule = useMemo(() => {
    if (!draw || draw.interval <= 0 || blockNumber === null) return null
    const { epochBlocks } = appConfig.protocol
    const currentEpoch = getEpochFromBlock(blockNumber, epochBlocks, protocolGenesisBlock())
    return globalDefenseSchedule({
      currentEpoch,
      intervalEpochs: draw.interval,
      epochBlocks,
      genesisBlock: protocolGenesisBlock(),
      blockTimeMs: appConfig.blockTimeMs,
      joinWindowMs: appConfig.protocol.globalDefenseJoinWindowMs,
    })
  }, [draw, blockNumber])

  const inWindow = schedule !== null && blockNumber !== null && isInGlobalDefenseJoinWindow(schedule, blockNumber)
  const applicationsOpen = lobby !== null && canJoinLobby(lobby, Date.now(), blockNumber)
  const joinable = applicationsOpen && inWindow

  const pool = draw?.pool ?? 0
  const launched = lobby !== null && (lobby.status === 'ACTIVE' || lobby.status === 'READY')
  const phase: 'idle' | 'open' | 'play' = joinable ? 'open' : launched ? 'play' : 'idle'
  const { jackpot } = resolveJackpot({ pool, lobbyId: draw?.lobbyId, lobby, phase })

  return {
    pool,
    jackpot,
    lobbyId: joinable ? (draw?.lobbyId ?? null) : null,
    joinable,
    inPlay: launched && !applicationsOpen,
    nextEpoch: schedule?.nextEpoch ?? draw?.nextEpoch ?? 0,
    interval: draw?.interval ?? 0,
    openFromBlock: schedule?.openFromBlock ?? null,
    deadlineBlock: joinable
      ? (lobby?.config.participation.deadlineBlock ?? schedule?.deadlineBlock ?? null)
      : (schedule?.openFromBlock ?? null),
    ready,
    drawLobbyId: draw?.lobbyId ?? null,
    drawLobby: lobby,
  }
}
