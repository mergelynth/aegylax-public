import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { BlockchainClientContext } from '../../app/providers/BlockchainClientProvider'
import { AuthProvider } from '../../auth'
import { EmulatorBlockchainClient } from '../../blockchain/EmulatorBlockchainClient'
import type { BlockchainClient } from '../../blockchain/types'
import { appConfig } from '../../config/env'
import { buildDefaultLobbyConfig } from '../../config/gameConfig'
import { joinCostOf } from '../../game/economics'
import { createLobby, getAttack, getLobby, joinLobby } from '../../game/gameService'
import type { Address } from '../../game/types'
import { LobbyPage } from '../../pages/LobbyPage'
import { setStorageItem } from '../../utils/storage'
import { asContractMode } from '../helpers/contractModeClient'
import { waitOutProbeFlight, probeIsOnChain } from '../helpers/recon'

const GRID = { columns: 10, rows: 5 }
const EPOCH_BLOCKS = 20
const PLAYER = '0x00000000000000000000000000000000000000aa' as Address
const OTHER = '0x00000000000000000000000000000000000000bb' as Address

let inner: EmulatorBlockchainClient
const realGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect

afterEach(() => {
  inner?.dispose()
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

function cloud(container: HTMLElement): SVGPolygonElement | null {
  return container.querySelector('polygon[class*="cloud"]')
}

function lockedPoint(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[title="Defense Point — locked"]')
}

function reconReading() {
  return screen.getByText('Recon').closest('div')
}

/**
 * Drives a real operation to ATTACK ACTIVE and mounts the Operation screen
 * against contract-mode semantics: checksummed addresses, no sealed
 * envelopes, Defense Points remembered locally, a confidential warmup.
 */
async function renderContractOperation(wallet: Address = PLAYER) {
  stubSceneSize()
  setStorageItem('emulator-wallet-address', wallet)
  setStorageItem('emulator-wallet-connected', true)

  inner = new EmulatorBlockchainClient({
    initialBlock: 1,
    blockTimeMs: 10_000_000,
    mapGrid: GRID,
    epochBlocks: EPOCH_BLOCKS,
  })

  const defaults = buildDefaultLobbyConfig(appConfig, Date.now())
  const config = {
    ...defaults,
    name: 'Contract UI',
    participation: { ...defaults.participation, minPlayers: 2, maxPlayers: 4, deadline: Date.now() + 1200 },
  }
  const { lobby } = await createLobby(inner, OTHER, config)
  const cost = joinCostOf(config)
  await joinLobby(inner, PLAYER, lobby.id, cost)
  await joinLobby(inner, OTHER, lobby.id, cost)

  await new Promise((resolve) => setTimeout(resolve, Math.max(0, config.participation.deadline - Date.now()) + 50))
  const active = await getLobby(inner, lobby.id)
  const attack = await getAttack(inner, active!.id, active!.activeAttackId!)
  inner.advanceBlocks(attack!.launchBlock + 1 - (await inner.getBlockNumber()))

  const { client, warmUps } = asContractMode(inner)

  const view = renderScreen(client, lobby.id)
  await waitFor(() => expect(screen.getByRole('button', { name: /get recon/i })).toBeEnabled())

  return {
    ...view,
    client,
    warmUps,
    lobbyId: lobby.id,
    attackId: active!.activeAttackId!,
    attack,
    remount: () => {
      view.unmount()
      return renderScreen(client, lobby.id)
    },
  }
}

function renderScreen(client: BlockchainClient, lobbyId: string) {
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

describe('contract-mode Operation screen (ТЗ §3, §5, §11)', () => {
  it('restores a confidential session for a player already in the operation, without a new signature', async () => {
    const { warmUps } = await renderContractOperation()
    await waitFor(() => expect(warmUps.some((address) => address.toLowerCase() === PLAYER)).toBe(true))
  })

  it('sends one probe and delivers the scan wave — not a spinner with an empty map', async () => {
    const user = userEvent.setup()
    const { container, lobbyId, attackId } = await renderContractOperation()

    expect(reconReading()).toHaveTextContent(/3\s*\/\s*6/)
    await user.click(screen.getByRole('button', { name: /get recon/i }))

    await waitFor(() => expect(reconReading()).toHaveTextContent(/2\s*\/\s*6/))
    await waitFor(async () => expect(await probeIsOnChain(inner, lobbyId, attackId, PLAYER)).toBe(true))
    waitOutProbeFlight(inner)
    await waitFor(() => expect(cloud(container)).not.toBeNull(), { timeout: 4000 })
    expect(screen.queryByRole('button', { name: /confirm recon probe/i })).not.toBeInTheDocument()
  })

  it('keeps the scan and the locked Defense Point across a reload, and restores them after a wallet switch', async () => {
    const user = userEvent.setup()
    const running = await renderContractOperation()

    await user.click(screen.getByRole('button', { name: /get recon/i }))
    await waitFor(() => expect(reconReading()).toHaveTextContent(/2\s*\/\s*6/))
    await waitFor(async () => expect(await probeIsOnChain(inner, running.lobbyId, running.attackId, PLAYER)).toBe(true))
    waitOutProbeFlight(inner)
    await waitFor(() => expect(cloud(running.container)).not.toBeNull(), { timeout: 4000 })

    fireEvent.click(screen.getByLabelText('Sector A1'), { clientX: 40, clientY: 40 })
    await waitFor(() => expect(screen.getByRole('button', { name: /^(intercept)$/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /^(intercept)$/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /fired/i })).toBeDisabled())
    expect(lockedPoint(running.container)).not.toBeNull()

    const reloaded = running.remount()
    await waitFor(() => expect(cloud(reloaded.container)).not.toBeNull())
    await waitFor(() => expect(screen.getByRole('button', { name: /fired/i })).toBeDisabled())
    expect(lockedPoint(reloaded.container)).not.toBeNull()
    expect(reconReading()).toHaveTextContent(/2\s*\/\s*6/)

    reloaded.unmount()
    setStorageItem('emulator-wallet-address', OTHER)
    const switched = renderScreen(running.client, running.lobbyId)
    await waitFor(() => expect(screen.getByText('Recon')).toBeInTheDocument())
    expect(cloud(switched.container)).toBeNull()
    expect(lockedPoint(switched.container)).toBeNull()

    switched.unmount()
    setStorageItem('emulator-wallet-address', PLAYER)
    const restored = renderScreen(running.client, running.lobbyId)
    await waitFor(() => expect(cloud(restored.container)).not.toBeNull())
    await waitFor(() => expect(screen.getByRole('button', { name: /fired/i })).toBeDisabled())
    expect(lockedPoint(restored.container)).not.toBeNull()
  }, 20_000)

  it('reveals the attack and keeps the trajectory after a reload', async () => {
    const user = userEvent.setup()
    const running = await renderContractOperation()

    fireEvent.click(screen.getByLabelText('Sector A1'), { clientX: 40, clientY: 40 })
    await waitFor(() => expect(screen.getByRole('button', { name: /^(intercept)$/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /^(intercept)$/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /fired/i })).toBeDisabled())

    inner.advanceBlocks(running.attack!.impactBlock + 1 - (await inner.getBlockNumber()))

    await waitFor(() => expect(screen.getByRole('button', { name: /reveal/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /reveal/i }))
    await waitFor(() => expect(running.container.querySelector('svg[aria-label*="Attack"]')).not.toBeNull())

    const reloaded = running.remount()
    await waitFor(() => expect(reloaded.container.querySelector('svg[aria-label*="Attack"]')).not.toBeNull())
    expect(screen.queryByRole('button', { name: /reveal/i })).not.toBeInTheDocument()
  }, 20_000)
})
