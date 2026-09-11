import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { BlockchainClientContext } from '../../app/providers/BlockchainClientProvider'
import { AuthProvider } from '../../auth'
import { EmulatorBlockchainClient } from '../../blockchain/EmulatorBlockchainClient'
import { parseEnv } from '../../config/env'
import { buildDefaultLobbyConfig } from '../../config/gameConfig'
import { joinCostOf } from '../../game/economics'
import {
  createLobby,
  getAttack,
  getLobby,
  getParticipant,
  joinLobby,
  revealAttack,
  submitDefenseAttempt,
} from '../../game/gameService'
import { submitTimedDefenseAttempt, timedDefensePlacement } from '../helpers/defense'
import { seal, unseal } from '../../game/sealing'
import type { Address, AttackTrajectory, DefensePoint, Hash, Lobby, LobbyConfig } from '../../game/types'
import { LobbyPage } from '../../pages/LobbyPage'
import { setStorageItem } from '../../utils/storage'
import { buildWorld, closestApproach, defensePointToWorld, worldToDefensePoint } from '../../game/world'

/**
 * Two wallets, three operations, the way a player meets them: claim, refund,
 * leave, and the writes the UI refuses because the contract refuses them.
 */

const GRID = { columns: 10, rows: 5 }
const EPOCH_BLOCKS = 20
const WALLET_A = '0x00000000000000000000000000000000000000aa' as Address
const WALLET_B = '0x00000000000000000000000000000000000000bb' as Address
const CREATOR = '0x00000000000000000000000000000000000000cc' as Address

let client: EmulatorBlockchainClient
const realGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect

afterEach(() => {
  client?.dispose()
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: realGetBoundingClientRect,
  })
})

function stubSceneSize(width = 1200, height = 600) {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => {},
    }),
  })
}

function connect(wallet: Address) {
  setStorageItem('emulator-wallet-address', wallet)
  setStorageItem('emulator-wallet-connected', true)
}

function renderLobby(lobbyId: Hash, wallet: Address) {
  connect(wallet)
  return render(
    <AuthProvider>
      <BlockchainClientContext.Provider value={client}>
        <MemoryRouter initialEntries={[`/lobby/${lobbyId}`]}>
          <Routes>
            <Route path="/lobby/:id" element={<LobbyPage />} />
          </Routes>
        </MemoryRouter>
      </BlockchainClientContext.Provider>
    </AuthProvider>,
  )
}

function buildClient() {
  const appConfig = parseEnv({
    VITE_BLOCKCHAIN_MODE: 'emulator',
    VITE_ATTACK_EPOCH_BLOCKS: String(EPOCH_BLOCKS),
    VITE_SECTOR_SPAN_KM: '1000',
    VITE_DEFENSE_INTERCEPTION_RADIUS: '0.14',
    VITE_EMULATOR_INITIAL_BLOCK: '1',
    VITE_EMULATOR_BLOCK_TIME_MS: '2000',
    VITE_MAP_GRID_COLUMNS: String(GRID.columns),
    VITE_MAP_GRID_ROWS: String(GRID.rows),
    VITE_RECON_PROBE_FREE_COUNT: '3',
    VITE_MIN_START_PRIZE_POOL: '1',
    VITE_PROTOCOL_JOIN_FEE: '0',
  } as unknown as ImportMetaEnv)
  return {
    appConfig,
    client: new EmulatorBlockchainClient({
      initialBlock: 1,
      blockTimeMs: 10_000_000,
      mapGrid: GRID,
      epochBlocks: appConfig.protocol.epochBlocks,
      protocolLimits: appConfig.protocol,
    }),
    config: { ...buildDefaultLobbyConfig(appConfig, Date.now()), name: 'Playthrough' },
  }
}

async function fill(config: LobbyConfig, name: string, minPlayers = 2) {
  const next = {
    ...config,
    name,
    participation: { ...config.participation, minPlayers, maxPlayers: 4, deadline: Date.now() + 900 },
  }
  const { lobby } = await createLobby(client, CREATOR, next)
  const cost = joinCostOf(next)
  await joinLobby(client, WALLET_A, lobby.id, cost)
  await joinLobby(client, WALLET_B, lobby.id, cost)
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, next.participation.deadline - Date.now()) + 40))
  return { lobby: (await getLobby(client, lobby.id))!, cost, config: next }
}

async function launch(lobby: Lobby) {
  const attack = await getAttack(client, lobby.id, lobby.activeAttackId!)
  client.advanceBlocks(attack!.launchBlock + 1 - (await client.getBlockNumber()))
  return attack!
}

function sealedTrajectory(lobbyId: Hash, attackId: string): AttackTrajectory {
  const internals = client as unknown as {
    state: { sealedTrajectories: Map<string, Parameters<typeof unseal>[0]> }
    sealingKey: Parameters<typeof unseal>[1]
  }
  return unseal<AttackTrajectory>(internals.state.sealedTrajectories.get(`${lobbyId}:${attackId}`)!, internals.sealingKey)
}

function onPath(lobby: Lobby, config: LobbyConfig, progress: number): DefensePoint {
  const { pointA, pointB } = sealedTrajectory(lobby.id, lobby.activeAttackId!)
  return worldToDefensePoint(
    { x: pointA.x + (pointB.x - pointA.x) * progress, y: pointA.y + (pointB.y - pointA.y) * progress },
    buildWorld(GRID, config.attack.sectorSpanKm),
  )
}

async function defendOnTime(lobby: Lobby, config: LobbyConfig, from: Address, progress: number) {
  const attack = await getAttack(client, lobby.id, lobby.activeAttackId!)
  await submitTimedDefenseAttempt(client, from, {
    lobbyId: lobby.id,
    attackId: lobby.activeAttackId!,
    defensePoint: onPath(lobby, config, progress),
    trajectory: sealedTrajectory(lobby.id, lobby.activeAttackId!),
    world: buildWorld(GRID, config.attack.sectorSpanKm),
    launchBlock: attack!.launchBlock,
    flightBlocks: attack!.flightDurationBlocks,
    defenseSpeedKmPerBlock: config.attack.defenseSpeedKmPerBlock,
  })
}

function offPath(lobby: Lobby, config: LobbyConfig): DefensePoint {
  const { pointA, pointB } = sealedTrajectory(lobby.id, lobby.activeAttackId!)
  const world = buildWorld(GRID, config.attack.sectorSpanKm)
  let best: DefensePoint | null = null
  let bestDistance = -1
  for (let row = 0; row < GRID.rows; row++) {
    for (let column = 0; column < GRID.columns; column++) {
      const point: DefensePoint = { sector: { column, row }, offsetX: 0.5, offsetY: 0.5 }
      const { distanceKm } = closestApproach(defensePointToWorld(point, world), pointA, pointB)
      if (distanceKm > bestDistance) {
        bestDistance = distanceKm
        best = point
      }
    }
  }
  return best!
}

async function resolveAfterDefense(lobby: Lobby, attackImpact: number) {
  client.advanceBlocks(attackImpact + 1 - (await client.getBlockNumber()))
  return (await getLobby(client, lobby.id))!
}

describe('two wallets, three operations (ТЗ §5, §15, §17, §18)', () => {
  it('lets a defender leave while applications are open and refunds them from the button', async () => {
    stubSceneSize()
    const built = buildClient()
    client = built.client
    const config = {
      ...built.config,
      name: 'Leave me',
      participation: { ...built.config.participation, minPlayers: 2, maxPlayers: 4, deadline: Date.now() + 15_000 },
    }
    const { lobby } = await createLobby(client, CREATOR, config)
    const cost = joinCostOf(config)
    await joinLobby(client, WALLET_A, lobby.id, cost)
    await joinLobby(client, WALLET_B, lobby.id, cost)

    const before = await client.getBalance(WALLET_A)
    const view = renderLobby(lobby.id, WALLET_A)
    const user = userEvent.setup()
    const leave = await screen.findByRole('button', { name: /^leave/i })
    await user.click(leave)
    await waitFor(async () => {
      expect(await getParticipant(client, lobby.id, WALLET_A, WALLET_A)).toBeNull()
    })
    expect(await client.getBalance(WALLET_A)).toBeCloseTo(before + cost)
    await waitFor(() => expect(screen.queryByRole('button', { name: /^leave/i })).not.toBeInTheDocument())
    view.unmount()
  }, 20_000)

  it('hides Leave once the operation has started, and the contract refuses the write', async () => {
    stubSceneSize()
    const built = buildClient()
    client = built.client
    const started = await fill(built.config, 'Already started')
    expect(started.lobby.status).toBe('ACTIVE')

    const view = renderLobby(started.lobby.id, WALLET_A)
    await waitFor(() => expect(screen.getByRole('button', { name: /get recon/i })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /^leave/i })).not.toBeInTheDocument()
    view.unmount()

    const blocked = await client.writeContract('leaveLobby', { lobbyId: started.lobby.id }, WALLET_A)
    expect(blocked.status).toBe('failed')
    expect(await getParticipant(client, started.lobby.id, WALLET_A, WALLET_A)).not.toBeNull()
  }, 20_000)

  it('refunds an undersubscribed operation from the UI, and refuses a refund on a round that ran', async () => {
    stubSceneSize()
    const built = buildClient()
    client = built.client
    const config = {
      ...built.config,
      name: 'Too few',
      participation: { ...built.config.participation, minPlayers: 3, maxPlayers: 4, deadline: Date.now() + 800 },
    }
    const { lobby } = await createLobby(client, CREATOR, config)
    const cost = joinCostOf(config)
    await joinLobby(client, WALLET_A, lobby.id, cost)
    const afterJoin = await client.getBalance(WALLET_A)
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, config.participation.deadline - Date.now()) + 40))

    const cancelled = await getLobby(client, lobby.id)
    expect(cancelled!.status).toBe('CANCELLED')
    expect(await client.getBalance(WALLET_A)).toBeCloseTo(afterJoin + cost)

    const view = renderLobby(lobby.id, WALLET_A)
    await waitFor(() => expect(screen.getByRole('button', { name: /^claimed$/i })).toBeDisabled())
    view.unmount()

    const played = await fill(built.config, 'Played miss')
    const attack = await launch(played.lobby)
    await submitDefenseAttempt(client, WALLET_A, {
      lobbyId: played.lobby.id,
      attackId: played.lobby.activeAttackId!,
      defensePoint: offPath(played.lobby, played.config),
    })
    await resolveAfterDefense(played.lobby, attack.impactBlock)
    const refund = await client.writeContract('claimRefund', { lobbyId: played.lobby.id }, WALLET_A)
    expect(refund.status).toBe('failed')
  }, 25_000)

  it('plays three rooms in parallel: nobody wins, one wins, two win — and each wallet can only claim what it is owed', async () => {
    stubSceneSize()
    const built = buildClient()
    client = built.client

    const missRoom = await fill(built.config, 'Nobody wins')
    const oneRoom = await fill(built.config, 'One winner')
    const twoRoom = await fill(built.config, 'Two winners')

    const missAttack = await launch(missRoom.lobby)
    const oneAttack = await launch(oneRoom.lobby)
    const twoAttack = await launch(twoRoom.lobby)

    // Decoded once, the way a player who opened the trajectory would aim.
    await submitDefenseAttempt(client, WALLET_A, {
      lobbyId: missRoom.lobby.id,
      attackId: missRoom.lobby.activeAttackId!,
      defensePoint: offPath(missRoom.lobby, missRoom.config),
    })
    await submitDefenseAttempt(client, WALLET_B, {
      lobbyId: missRoom.lobby.id,
      attackId: missRoom.lobby.activeAttackId!,
      defensePoint: offPath(missRoom.lobby, missRoom.config),
    })

    await defendOnTime(oneRoom.lobby, oneRoom.config, WALLET_A, 0.9)
    await submitDefenseAttempt(client, WALLET_B, {
      lobbyId: oneRoom.lobby.id,
      attackId: oneRoom.lobby.activeAttackId!,
      defensePoint: offPath(oneRoom.lobby, oneRoom.config),
    })

    const twoAttackLive = await getAttack(client, twoRoom.lobby.id, twoRoom.lobby.activeAttackId!)
    const traj = sealedTrajectory(twoRoom.lobby.id, twoRoom.lobby.activeAttackId!)
    const world = buildWorld(GRID, twoRoom.config.attack.sectorSpanKm)
    const { point: tiePoint, submitBlock } = timedDefensePlacement({
      point: onPath(twoRoom.lobby, twoRoom.config, 0.9),
      world,
      launchBlock: twoAttackLive!.launchBlock,
      flightBlocks: twoAttackLive!.flightDurationBlocks,
      trajectory: traj,
      defenseSpeedKmPerBlock: twoRoom.config.attack.defenseSpeedKmPerBlock,
    })
    const now = await client.getBlockNumber()
    if (submitBlock > now) client.advanceBlocks(submitBlock - now)
    await submitDefenseAttempt(client, WALLET_A, {
      lobbyId: twoRoom.lobby.id,
      attackId: twoRoom.lobby.activeAttackId!,
      defensePoint: tiePoint,
    })
    await submitDefenseAttempt(client, WALLET_B, {
      lobbyId: twoRoom.lobby.id,
      attackId: twoRoom.lobby.activeAttackId!,
      defensePoint: tiePoint,
    })

    await resolveAfterDefense(missRoom.lobby, missAttack.impactBlock)
    await resolveAfterDefense(oneRoom.lobby, oneAttack.impactBlock)
    await resolveAfterDefense(twoRoom.lobby, twoAttack.impactBlock)

    expect((await getLobby(client, missRoom.lobby.id))!.outcome?.winners).toEqual([])
    expect((await getLobby(client, oneRoom.lobby.id))!.outcome?.winners).toEqual([WALLET_A])
    expect((await getLobby(client, twoRoom.lobby.id))!.outcome?.winners).toEqual(
      expect.arrayContaining([WALLET_A, WALLET_B]),
    )

    const user = userEvent.setup()

    // Nobody wins: both wallets see a miss, neither is offered a reward, and
    // a direct claim reverts the same way the hidden button would have.
    const missView = renderLobby(missRoom.lobby.id, WALLET_A)
    await waitFor(() => expect(screen.getByRole('button', { name: /reveal/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /reveal/i }))
    await waitFor(() => expect(screen.getByLabelText('Result summary')).toHaveTextContent(/you missed/i))
    expect(screen.queryByRole('button', { name: /^claim$/i })).not.toBeInTheDocument()
    missView.unmount()

    const missClaim = await client.writeContract(
      'claimReward',
      { lobbyId: missRoom.lobby.id, attackId: missRoom.lobby.activeAttackId! },
      WALLET_A,
    )
    expect(missClaim.status).toBe('failed')

    // One winner: A claims from the UI; B's claim is refused on chain.
    await revealAttack(client, WALLET_B, { lobbyId: oneRoom.lobby.id, attackId: oneRoom.lobby.activeAttackId! })
    const oneView = renderLobby(oneRoom.lobby.id, WALLET_A)
    await waitFor(() => expect(screen.getByRole('button', { name: /^claim$/i })).toBeEnabled())
    const aBefore = await client.getBalance(WALLET_A)
    await user.click(screen.getByRole('button', { name: /^claim$/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^claimed$/i })).toBeDisabled())
    expect(await client.getBalance(WALLET_A)).toBeGreaterThan(aBefore)
    oneView.unmount()

    const loserClaim = await client.writeContract(
      'claimReward',
      { lobbyId: oneRoom.lobby.id, attackId: oneRoom.lobby.activeAttackId! },
      WALLET_B,
    )
    expect(loserClaim.status).toBe('failed')
    const double = await client.writeContract(
      'claimReward',
      { lobbyId: oneRoom.lobby.id, attackId: oneRoom.lobby.activeAttackId! },
      WALLET_A,
    )
    expect(double.status).toBe('failed')

    const loserView = renderLobby(oneRoom.lobby.id, WALLET_B)
    await waitFor(() => expect(screen.getByLabelText('Result summary')).toHaveTextContent(/you missed/i))
    expect(screen.queryByRole('button', { name: /^claim$/i })).not.toBeInTheDocument()
    loserView.unmount()

    // Two winners: each wallet claims its half from the screen.
    await revealAttack(client, WALLET_A, { lobbyId: twoRoom.lobby.id, attackId: twoRoom.lobby.activeAttackId! })
    const twoA = renderLobby(twoRoom.lobby.id, WALLET_A)
    await waitFor(() => expect(screen.getByRole('button', { name: /^claim$/i })).toBeEnabled())
    const aSplitBefore = await client.getBalance(WALLET_A)
    await user.click(screen.getByRole('button', { name: /^claim$/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^claimed$/i })).toBeDisabled())
    const aShare = (await client.getBalance(WALLET_A)) - aSplitBefore
    expect(aShare).toBeGreaterThan(0)
    twoA.unmount()

    const twoB = renderLobby(twoRoom.lobby.id, WALLET_B)
    await waitFor(() => expect(screen.getByRole('button', { name: /^claim$/i })).toBeEnabled())
    const bSplitBefore = await client.getBalance(WALLET_B)
    await user.click(screen.getByRole('button', { name: /^claim$/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^claimed$/i })).toBeDisabled())
    expect(await client.getBalance(WALLET_B)).toBeCloseTo(bSplitBefore + aShare)
    twoB.unmount()
  }, 40_000)

  it('blocks on chain every write the UI already refuses', async () => {
    stubSceneSize()
    const built = buildClient()
    client = built.client
    const room = await fill(built.config, 'Gating')
    const attack = await launch(room.lobby)
    const attackId = room.lobby.activeAttackId!

    // Defense is closed until the attack is in the sky — already launched
    // here, so the live refusals are: a second Defense, a probe after
    // Defense, a buy after Defense, a leave, a refund, a stranger's claim.
    await submitDefenseAttempt(client, WALLET_A, {
      lobbyId: room.lobby.id,
      attackId,
      defensePoint: onPath(room.lobby, room.config, 0.9),
    })

    const key = await client.readContract('getSealingKey', {})
    const secondDefense = await client.writeContract(
      'submitPrivateAction',
      {
        lobbyId: room.lobby.id,
        envelope: seal(
          { op: 'DEFENSE_SUBMIT', attackId, defensePoint: onPath(room.lobby, room.config, 0.5) },
          key,
        ),
      },
      WALLET_A,
    )
    expect(secondDefense.status).toBe('failed')

    const probeAfter = await client.writeContract(
      'submitPrivateAction',
      {
        lobbyId: room.lobby.id,
        envelope: seal({ op: 'RECON_PROBE', attackId, probeId: 'too-late', aimDegrees: null }, key),
      },
      WALLET_A,
    )
    expect(probeAfter.status).toBe('failed')

    const buy = await client.writeContract('buyDrone', { lobbyId: room.lobby.id, value: room.config.drones.price }, WALLET_A)
    expect(buy.status).toBe('failed')

    const leave = await client.writeContract('leaveLobby', { lobbyId: room.lobby.id }, WALLET_A)
    expect(leave.status).toBe('failed')

    await resolveAfterDefense(room.lobby, attack.impactBlock)
    const refund = await client.writeContract('claimRefund', { lobbyId: room.lobby.id }, WALLET_A)
    expect(refund.status).toBe('failed')

    const stranger = await client.writeContract(
      'claimReward',
      { lobbyId: room.lobby.id, attackId },
      WALLET_B,
    )
    expect(stranger.status).toBe('failed')
  }, 25_000)
})
