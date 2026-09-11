import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { BlockchainClientContext } from '../../app/providers/BlockchainClientProvider'
import type { BlockchainClient } from '../../blockchain/types'
import { AuthProvider } from '../../auth'
import { EmulatorBlockchainClient } from '../../blockchain/EmulatorBlockchainClient'
import { appConfig } from '../../config/env'
import { buildDefaultLobbyConfig } from '../../config/gameConfig'
import { joinCostOf } from '../../game/economics'
import {
  createLobby,
  getAttack,
  getLobby,
  joinLobby,
  revealAttack,
  submitDefenseAttempt,
} from '../../game/gameService'
import type { Address, Hash } from '../../game/types'
import { LobbyPage } from '../../pages/LobbyPage'
import { setStorageItem } from '../../utils/storage'
import { waitOutProbeFlight, probeIsOnChain, probesLanded } from '../helpers/recon'

const GRID = { columns: 10, rows: 5 }
const EPOCH_BLOCKS = 20
const PLAYER = '0x00000000000000000000000000000000000000aa' as Address
const OTHER = '0x00000000000000000000000000000000000000bb' as Address

let client: EmulatorBlockchainClient
const realGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect

afterEach(() => {
  client?.dispose()
  // The scene stub below patches a prototype, so it outlives this file's
  // tests unless it is put back — and every other suite would then render
  // against a 1200x600 world it never asked for.
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: realGetBoundingClientRect,
  })
})

/**
 * jsdom gives every element a zero-size bounding box, and the grid is laid
 * out in real pixels — a zero-size scene puts every sector inside Earth's
 * disc, so `buildSpaceGrid` drops all fifty and there is nothing to click.
 * A fixed landscape scene is what makes the playfield exist at all here.
 */
function stubSceneSize(width = 1200, height = 600) {
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => {} }),
  })
}

/**
 * Drives a real operation to the point where the player can actually do
 * something — joined, applications closed, attack in flight — and renders
 * the real Operation screen on top of it.
 *
 * The page is wired to the emulator through the same context the app uses,
 * so nothing here is a stand-in: a break anywhere between the button and
 * the chain shows up as a break in this test.
 */
/**
 * The same chain with one slow read: `getAttackReveal` behind a delay.
 *
 * Locally every read answers in the same tick, which hides the case this
 * file's last test is about. On a real chain the reveal is a round trip,
 * while the probes this wallet sent are already on the machine — so the
 * screen has a fix to draw for a moment before it knows whether the round
 * was ever answered. The delay is what makes those frames exist here.
 */
function withSlowReveal(inner: EmulatorBlockchainClient, delayMs: number): BlockchainClient {
  return new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (prop !== 'readContract') return typeof value === 'function' ? value.bind(target) : value
      return async (method: string, params: unknown) => {
        if (method === 'getAttackReveal') await new Promise((resolve) => setTimeout(resolve, delayMs))
        return target.readContract(method as never, params as never)
      }
    },
  }) as BlockchainClient
}

/** The Operation screen, wired to the emulator exactly as the app wires it. */
function renderPage(lobbyId: Hash, on: BlockchainClient = client) {
  return render(
    <AuthProvider>
      <BlockchainClientContext.Provider value={on}>
        <MemoryRouter initialEntries={[`/lobby/${lobbyId}`]}>
          <Routes>
            <Route path="/lobby/:id" element={<LobbyPage />} />
          </Routes>
        </MemoryRouter>
      </BlockchainClientContext.Provider>
    </AuthProvider>,
  )
}

async function renderRunningOperation() {
  stubSceneSize()

  // `useWallet` mints one emulator address per browser and keeps it in
  // storage; seeding the key is what makes the page believe this wallet is
  // the connected one.
  setStorageItem('emulator-wallet-address', PLAYER)
  setStorageItem('emulator-wallet-connected', true)

  client = new EmulatorBlockchainClient({
    initialBlock: 1,
    // No block ever mines on a timer — the test advances the chain itself.
    blockTimeMs: 10_000_000,
    mapGrid: GRID,
    epochBlocks: EPOCH_BLOCKS,
  })

  const defaults = buildDefaultLobbyConfig(appConfig, Date.now())
  const config = {
    ...defaults,
    name: 'Recon Test',
    // Long enough to cover three simulated confirmations at 250ms each.
    participation: { ...defaults.participation, minPlayers: 2, maxPlayers: 4, deadline: Date.now() + 1200 },
  }
  const { lobby } = await createLobby(client, OTHER, config)
  const cost = joinCostOf(config)
  await joinLobby(client, PLAYER, lobby.id, cost)
  await joinLobby(client, OTHER, lobby.id, cost)

  await new Promise((resolve) => setTimeout(resolve, Math.max(0, config.participation.deadline - Date.now()) + 50))
  const active = await getLobby(client, lobby.id)
  const attack = await getAttack(client, active!.id, active!.activeAttackId!)
  // Past the launch block: ТЗ §4 opens reconnaissance and the grid here.
  client.advanceBlocks(attack!.launchBlock + 1 - (await client.getBlockNumber()))

  const view = renderPage(lobby.id)

  // The console appears as soon as the operation is under way, which is one
  // phase earlier than the attack being in flight — so waiting for it would
  // race the read that loads the attack. ATTACK ACTIVE is the state these
  // tests are actually about.
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /get recon/i })).toBeEnabled(),
  )
  return { ...view, lobbyId: lobby.id, attackId: active!.activeAttackId! }
}

/** The blue uncertainty cloud, if reconnaissance has produced one yet (ТЗ §3). */
function cloud(container: HTMLElement): SVGPolygonElement | null {
  return container.querySelector('polygon[class*="cloud"]')
}

/** The red occupancy blotch a probe snapshot leaves on the map (ТЗ §3). */
function blotch(container: HTMLElement): SVGGElement | null {
  return container.querySelector('g[class*="threatBlotch"]')
}

/** The Command Center's recon line — the glyph, RECON, and the counts. */
const reconReading = () => screen.getByText('Recon').closest('div')

describe('integration: sending a Recon Probe from the Operation screen (ТЗ §3)', () => {
  it('spends a probe on one press, with nothing to aim and nothing to confirm', async () => {
    const user = userEvent.setup()
    const { container, lobbyId, attackId } = await renderRunningOperation()

    // The probe control is live once the attack is in flight, and it is
    // the whole gesture: no mode, no sector pick, no confirmation marker.
    const reconButton = screen.getByRole('button', { name: /get recon/i })
    expect(reconButton).toBeEnabled()
    expect(reconReading()).toHaveTextContent(/3\s*\/\s*6/)

    await user.click(reconButton)

    // Remaining drops on the press — the badge on the button included —
    // not after Inco answers. A probe in flight is already spent.
    await waitFor(() => expect(reconReading()).toHaveTextContent(/2\s*\/\s*6/))
    expect(screen.queryByRole('button', { name: /confirm recon probe/i })).not.toBeInTheDocument()

    // Nothing moves on the map while the probe is out. The sweep marks an
    // arrival, so animating the wait would put a progress bar over the
    // whole board — the Send control is what says a probe is in flight.
    expect(container.querySelector('[class*="wave"]')).toBeNull()
    expect(reconButton).toBeDisabled()

    await waitFor(async () => expect(await probeIsOnChain(client, lobbyId, attackId, PLAYER)).toBe(true))
    waitOutProbeFlight(client)

    // ТЗ §3 — one probe buys a direction: a blue cloud, no heatmap yet.
    await waitFor(() => expect(cloud(container)).not.toBeNull(), { timeout: 4000 })
    expect(blotch(container)).toBeNull()
  })

  it('draws a red occupancy blotch from the second probe, still inside the first cloud', async () => {
    const user = userEvent.setup()
    const { container, lobbyId, attackId } = await renderRunningOperation()

    await user.click(screen.getByRole('button', { name: /get recon/i }))
    await waitFor(() => expect(reconReading()).toHaveTextContent(/2\s*\/\s*6/))
    await waitFor(async () => expect(await probeIsOnChain(client, lobbyId, attackId, PLAYER)).toBe(true))
    waitOutProbeFlight(client)
    await waitFor(() => expect(cloud(container)).not.toBeNull(), { timeout: 4000 })

    await waitFor(() => expect(screen.getByRole('button', { name: /get recon/i })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: /get recon/i }))
    await waitFor(() => expect(reconReading()).toHaveTextContent(/1\s*\/\s*6/))
    await waitFor(async () => expect(await probesLanded(client, lobbyId, attackId, PLAYER)).toBe(2))
    waitOutProbeFlight(client)

    await waitFor(() => expect(blotch(container)).not.toBeNull(), { timeout: 4000 })
    expect(cloud(container)).not.toBeNull()
    // Wider across the corridor than along it, so consecutive marks meet
    // and agreeing readings show up as a darker column.
    const outer = blotch(container)!.querySelector('ellipse')!
    expect(Number(outer.getAttribute('ry'))).toBeGreaterThan(Number(outer.getAttribute('rx')))
  }, 15000)

  it('never puts a coordinate on the board before the reveal (ТЗ §11)', async () => {
    const user = userEvent.setup()
    const { container, lobbyId, attackId } = await renderRunningOperation()

    await user.click(screen.getByRole('button', { name: /get recon/i }))
    await waitFor(() => expect(reconReading()).toHaveTextContent(/2\s*\/\s*6/))
    await waitFor(async () => expect(await probeIsOnChain(client, lobbyId, attackId, PLAYER)).toBe(true))
    waitOutProbeFlight(client)
    await waitFor(() => expect(cloud(container)).not.toBeNull(), { timeout: 4000 })

    // The reveal layer is the only thing that ever draws the real path, and
    // it does not exist yet. Everything on the board is area rather than
    // position, and none of it is opaque enough to read as a mark.
    expect(container.querySelector('svg[aria-label*="Attack"]')).toBeNull()
    expect(container.querySelector('[marker-end]')).toBeNull()
    expect(Number(cloud(container)!.getAttribute('opacity'))).toBeLessThan(1)
  }, 15000)

  /*
   * ТЗ §7-§8 — reopening a finished operation, which is how nearly everyone
   * sees one.
   *
   * The reveal is a separate read, and the frames before it answers used to
   * be drawn as though nobody had revealed: probes are remembered per
   * wallet, so the corridor went straight back up over a map that was about
   * to draw the real trajectory through it. The round being over is known
   * without asking anybody, so the estimate has to stay down for those
   * frames — the assertion is about the whole wait, not about the end of it.
   */
  it('never puts the corridor back on an operation that has already been revealed', async () => {
    const user = userEvent.setup()
    const first = await renderRunningOperation()

    await user.click(screen.getByRole('button', { name: /get recon/i }))
    await waitFor(async () => expect(await probeIsOnChain(client, first.lobbyId, first.attackId, PLAYER)).toBe(true))
    waitOutProbeFlight(client)
    await waitFor(() => expect(cloud(first.container)).not.toBeNull(), { timeout: 4000 })

    // A round nobody defended is refunded as unplayed rather than scored,
    // so there would be no reveal to reopen.
    await submitDefenseAttempt(client, PLAYER, {
      lobbyId: first.lobbyId,
      attackId: first.attackId,
      defensePoint: { sector: { column: 3, row: 2 }, offsetX: 0.5, offsetY: 0.5 },
    })
    const attack = await getAttack(client, first.lobbyId, first.attackId)
    client.advanceBlocks(attack!.impactBlock + 1 - (await client.getBlockNumber()))
    await revealAttack(client, PLAYER, { lobbyId: first.lobbyId, attackId: first.attackId })
    first.unmount()

    const { container } = renderPage(first.lobbyId, withSlowReveal(client, 900))
    expect(cloud(container)).toBeNull()

    let flashed = false
    await waitFor(
      () => {
        if (cloud(container) || blotch(container)) flashed = true
        expect(container.querySelector('svg[aria-label*="Attack"]')).not.toBeNull()
      },
      { timeout: 8000 },
    )
    expect(flashed).toBe(false)
    expect(cloud(container)).toBeNull()
    expect(blotch(container)).toBeNull()
  }, 25000)
})
