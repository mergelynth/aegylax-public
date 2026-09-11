import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EmulatorBlockchainClient } from '../../blockchain'
import { isTooEarly, isTooLate } from '../../game/defense'
import { deriveLobbyPhase } from '../../game/lobbyPhase'
import { getAttack, getAttackReveal, getLobby } from '../../game/gameService'
import { buildGuideChain, DEMO_PLAYER } from '../../guide/demoChain'
import { appConfig } from '../../config/env'
import { buildWorld } from '../../game/world'

const STORAGE_KEY = 'emulator-chain-state-v8'

/**
 * The guided tour's chain.
 *
 * It matters more than most fixtures, because the tour's whole claim is that
 * the screens are reading a chain that genuinely holds what they show. If
 * the seeding quietly stopped producing a won round, the tour would still
 * render — it would just be explaining a reveal that never happened.
 */
describe('guide sandbox', () => {
  /*
   * Built once for the whole file.
   *
   * Seeding four rooms means four creations, a dozen joins and several
   * hundred mined blocks — cheap, but not free, and repeating it per test
   * put enough CPU into the worker to start tripping the wall-clock
   * assertions in the other integration suites running beside it. The
   * chain is read-only to every test here, so once is also the honest
   * number.
   */
  let chain: Awaited<ReturnType<typeof buildGuideChain>>

  beforeAll(async () => {
    window.localStorage.clear()
    chain = await buildGuideChain()
  })

  afterAll(() => {
    chain?.client.dispose()
  })

  it('seeds one room in each state the tour walks', async () => {
    const { client, lobbies } = chain
    const block = await client.getBlockNumber()

    const mine = await getLobby(client, lobbies.mine)
    const open = await getLobby(client, lobbies.open)
    const active = await getLobby(client, lobbies.active)
    const scouted = await getLobby(client, lobbies.scouted)
    const sighted = await getLobby(client, lobbies.sighted)
    const seated = await getLobby(client, lobbies.seated)
    const won = await getLobby(client, lobbies.won)
    const early = await getLobby(client, lobbies.early)

    for (const lobby of [mine, open, seated, active, sighted, scouted, won, early]) expect(lobby).not.toBeNull()

    expect(deriveLobbyPhase(mine!, null, block, Date.now())).toBe('OPEN')
    expect(deriveLobbyPhase(open!, null, block, Date.now())).toBe('OPEN')
    expect(won!.status).toBe('RESOLVED')
    expect(early!.status).toBe('RESOLVED')

    // The CREATE branch's room is the demo player's own; the JOIN branch's
    // is somebody else's, or the story it tells would not be true.
    expect(mine!.creator.toLowerCase()).toBe(DEMO_PLAYER.toLowerCase())
    expect(open!.creator.toLowerCase()).not.toBe(DEMO_PLAYER.toLowerCase())
    expect(deriveLobbyPhase(seated!, null, block, Date.now())).toBe('OPEN')
  })

  it('seats the demo player wherever the tour shows the probe shop', async () => {
    /*
     * The drawer's Recon panel — and with it the Buy control — renders only
     * for a participant. A buy step standing in a room the player has not
     * joined would point at an element that is simply not there.
     */
    const { client, lobbies } = chain

    for (const key of ['mine', 'seated'] as const) {
      const participants = await client.readContract('getLobbyParticipants', {
        lobbyId: lobbies[key],
        viewer: DEMO_PLAYER,
      })
      const seated = participants.some((p) => p.address.toLowerCase() === DEMO_PLAYER.toLowerCase())
      expect(seated, `the demo player has no seat in "${key}"`).toBe(true)
    }

    // ...and is deliberately absent from the room where JOIN is demonstrated.
    const open = await client.readContract('getLobbyParticipants', {
      lobbyId: lobbies.open,
      viewer: DEMO_PLAYER,
    })
    expect(open.some((p) => p.address.toLowerCase() === DEMO_PLAYER.toLowerCase())).toBe(false)
  })

  it('resolves the finished room as a win for the demo player', async () => {
    /*
     * Computed, not asserted. The winning point is placed on the threat's
     * real position at the block it commits on and then scored by the same
     * function the protocol scores every round with — so this checks the
     * game agrees, not that a flag was set.
     */
    const { client, lobbies } = chain
    const lobby = await getLobby(client, lobbies.won)
    const reveal = await getAttackReveal(client, lobbies.won, lobby!.activeAttackId!)

    expect(reveal).not.toBeNull()
    expect(reveal!.outcome.intercepted).toBe(true)
    expect(reveal!.outcome.winners.map((w) => w.toLowerCase())).toContain(DEMO_PLAYER.toLowerCase())
    expect(reveal!.outcome.rewardPerWinner).toBeGreaterThan(0)
  })

  it('keeps both in-flight rooms actually in flight', async () => {
    /*
     * The failure this guards is not obvious and was real: an attack
     * launches on an epoch boundary, so putting a second room in the sky
     * advanced the chain far enough to carry the first past its own impact.
     * The tour then narrated a round as "in flight" over a screen showing
     * TARGET REACHED and a Reveal button.
     */
    const { client, lobbies } = chain
    const block = await client.getBlockNumber()

    for (const key of ['active', 'sighted', 'scouted'] as const) {
      const lobby = await getLobby(client, lobbies[key])
      const attack = await getAttack(client, lobbies[key], lobby!.activeAttackId!)
      expect(deriveLobbyPhase(lobby!, attack, block, Date.now()), `${key} is not in flight`).toBe(
        'ATTACK_ACTIVE',
      )
      expect(block, `${key} has already impacted`).toBeLessThan(attack!.impactBlock)
    }
  })

  it('leaves the in-flight room unscouted, so the sky is genuinely empty', async () => {
    /*
     * The step that says the screen reveals nothing about where the threat
     * is has to stand in a room where that is true. One probe already spent
     * draws the corridor — which is exactly what the step claims not to
     * show — so this is the assertion that keeps the two honest.
     */
    const { client, lobbies } = chain
    const active = await getLobby(client, lobbies.active)
    const scouted = await getLobby(client, lobbies.scouted)

    const probesIn = async (lobbyId: typeof lobbies.active, attackId: string) =>
      (await client.resolvePendingProbes(lobbyId, attackId, DEMO_PLAYER)).length

    expect(await probesIn(lobbies.active, active!.activeAttackId!)).toBe(0)

    /*
     * Exactly one in `sighted`, and that number is the point of the room.
     * The occupancy trail starts at the *second* reading, so one probe
     * paints a bearing and nothing else — which is what lets the tour show
     * "which way" and "where along it" as two separate ideas.
     */
    const sightedLobby = await getLobby(client, lobbies.sighted)
    expect(await probesIn(lobbies.sighted, sightedLobby!.activeAttackId!)).toBe(1)
    expect(await probesIn(lobbies.scouted, scouted!.activeAttackId!)).toBeGreaterThan(1)
  })

  it('stages one outcome per operation, each on a single point', async () => {
    /*
     * The four endings the tour compares. Every one is produced by the
     * protocol's own scoring — the staging only decides the inputs — so if a
     * room ever stopped landing on the ending it was built for, this fails
     * rather than the tour explaining something the screen does not show.
     *
     * One committed point per room is part of the assertion, not an
     * incidental. Four markers on one map is what this replaced: the ring
     * could not be told from its neighbours, and the two timing failures
     * read as scatter rather than as a rule.
     */
    const { client, lobbies } = chain

    const verdictOf = async (key: 'won' | 'early' | 'late' | 'stray') => {
      const lobby = await getLobby(client, lobbies[key])
      const reveal = await getAttackReveal(client, lobbies[key], lobby!.activeAttackId!)
      expect(reveal, `${key} has not been revealed`).not.toBeNull()
      expect(reveal!.results, `${key} carries more than one committed point`).toHaveLength(1)
      return reveal!.results[0]
    }

    const won = await verdictOf('won')
    expect(won.isWinner).toBe(true)

    const early = await verdictOf('early')
    expect(early.status).toBe('missed')
    expect(isTooEarly(early)).toBe(true)

    const late = await verdictOf('late')
    expect(late.status).toBe('missed')
    expect(isTooLate(late)).toBe(true)

    const stray = await verdictOf('stray')
    expect(stray.status).toBe('missed')
    // Never entered the radius, so there is no interception block at all —
    // which is what separates an aim failure from a timing one.
    expect(stray.interceptionBlock).toBeNull()
  })

  it('flies one trajectory across all four outcomes', async () => {
    // The comparison only works if the line does not move between screens.
    const { client, lobbies } = chain
    const paths: string[] = []

    for (const key of ['won', 'early', 'late', 'stray'] as const) {
      const lobby = await getLobby(client, lobbies[key])
      const reveal = await getAttackReveal(client, lobbies[key], lobby!.activeAttackId!)
      const { pointA, pointB } = reveal!.trajectory
      paths.push(`${pointA.x.toFixed(3)},${pointA.y.toFixed(3)}->${pointB.x.toFixed(3)},${pointB.y.toFixed(3)}`)
    }

    expect(new Set(paths).size, `the outcomes fly different paths: ${paths.join(' | ')}`).toBe(1)
  })

  it('stages a trajectory that is legible on screen', async () => {
    /*
     * The generator draws both angles at random inside wide bounds, and a
     * fair share of those draws are useless to look at — a path grazing the
     * far edge, or one so near vertical it is a hairline against the frame.
     * The tour pins its own; this is what keeps that pin honest.
     */
    const { client, lobbies } = chain
    const lobby = await getLobby(client, lobbies.won)
    const reveal = await getAttackReveal(client, lobbies.won, lobby!.activeAttackId!)
    const { pointA, pointB } = reveal!.trajectory

    const world = buildWorld(
      { columns: appConfig.map.columns, rows: appConfig.map.rows },
      appConfig.protocol.sectorSpanKm,
    )

    // Both ends inside the working area, with room to spare at the sides.
    for (const point of [pointA, pointB]) {
      expect(point.x).toBeGreaterThan(world.widthKm * 0.05)
      expect(point.x).toBeLessThan(world.widthKm * 0.95)
    }

    // And a real diagonal rather than a vertical drop: the horizontal run is
    // a meaningful fraction of the vertical one.
    const run = Math.abs(pointB.x - pointA.x)
    const drop = Math.abs(pointB.y - pointA.y)
    expect(run / drop).toBeGreaterThan(0.35)
  })

  it('funds the Global Defense jackpot with a round the threat won', async () => {
    /*
     * The jackpot pill is hidden while the pool is empty, and it is the
     * second thing the tour explains — so a sandbox that forgot to play a
     * losing round would point at an element that is not on screen.
     */
    const stats = await chain.client.readContract('getGameStats', {})
    expect(stats.globalDefensePool).toBeGreaterThan(0)
  })

  it('never writes to the chain the player’s own browser uses', async () => {
    // There is one storage key, so a sandbox that persisted would not sit
    // beside the real chain — it would replace it.
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('holds its clock still', async () => {
    const first = await chain.client.getBlockNumber()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(await chain.client.getBlockNumber()).toBe(first)
  })
})

describe('emulator sandbox options', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  /*
   * Clock off by default. None of these are about mining, and a client that
   * ticks — at any rate, but especially a fast one — is a timer running in
   * the same process as every other integration test in the run.
   */
  function sandbox(overrides: Partial<ConstructorParameters<typeof EmulatorBlockchainClient>[0]> = {}) {
    return new EmulatorBlockchainClient({
      initialBlock: 1,
      blockTimeMs: 10_000,
      mapGrid: { columns: 10, rows: 5 },
      epochBlocks: 150,
      autoMine: false,
      ...overrides,
    })
  }

  it('starts empty rather than adopting whatever is stored', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ currentBlockNumber: 9_999, latestBlock: { number: 9_999 } }))
    const client = sandbox({ persistence: 'none' })
    expect(client.inspect().lobbies).toEqual([])
    client.dispose()
  })

  it('leaves a stored chain untouched', async () => {
    window.localStorage.setItem(STORAGE_KEY, 'sentinel')
    const client = sandbox({ persistence: 'none' })
    client.advanceBlocks(5)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('sentinel')
    client.dispose()
  })

  it('still mines on demand with the timer off', async () => {
    const client = sandbox({ persistence: 'none' })
    const start = await client.getBlockNumber()
    client.advanceBlocks(7)
    expect(await client.getBlockNumber()).toBe(start + 7)
    client.dispose()
  })
})
