import { describe, expect, it } from 'vitest'
import { ContractBlockchainClient } from '../../blockchain/contract/ContractBlockchainClient'
import { parseEnv } from '../../config/env'

/**
 * The frontend's read path, against the deployed contract (ТЗ §10).
 *
 * Everything else in the suite exercises the emulator, which is a model of
 * the protocol written in the same language by the same hand — so the one
 * class of bug it structurally cannot catch is the two disagreeing. That is
 * not hypothetical: gating the Reveal control on `lobby.outcome` passed
 * every emulator test and dead-ended every real operation, because the
 * emulator resolves at the impact block and the chain resolves at the
 * reveal.
 *
 * So this reads a real, finished operation through the same client the app
 * uses and checks the fields the payout controls are built on. It needs a
 * network and a deployment, so it is opt-in:
 *
 *     CHAIN_LIVE=1 npx vitest run frontend/src/tests/chain
 */

const live = process.env.CHAIN_LIVE === '1'

function buildClient() {
  const config = parseEnv({
    VITE_BLOCKCHAIN_MODE: 'contract',
    VITE_CHAIN_ID: process.env.CHAIN_ID ?? '84532',
    VITE_RPC_URL: process.env.RPC_URL ?? 'https://sepolia.base.org',
  } as unknown as ImportMetaEnv)
  return new ContractBlockchainClient(config)
}

describe.runIf(live)('live: reading the deployed protocol', () => {
  const client = buildClient()

  it('reads the chain at all', async () => {
    expect(await client.getBlockNumber()).toBeGreaterThan(0)
  })

  /**
   * ТЗ §18 — a cancelled operation, and the two fields the Refund control
   * exists to render.
   *
   * `paidIn` is what the button offers to pay back and `refunded` is what
   * disables it; neither was mapped out of the contract at all before, so
   * the control could not have been built on anything.
   */
  it('carries paidIn and refunded through to a participant record', async () => {
    const lobbyId = process.env.CANCELLED_LOBBY_ID as `0x${string}` | undefined
    if (!lobbyId) return

    const lobby = await client.readContract('getLobby', { lobbyId })
    expect(lobby?.status).toBe('CANCELLED')

    const participants = await client.readContract('getLobbyParticipants', { lobbyId, viewer: null })
    expect(participants.length).toBeGreaterThan(0)
    for (const participant of participants) {
      expect(participant.paidIn).toBeGreaterThan(0)
      expect(typeof participant.refunded).toBe('boolean')
    }
  })

  /**
   * ТЗ §14.6 — what `settleCreator` would pay, computed the same way the
   * contract computes it, so the button can name a figure before it is
   * pressed rather than after.
   */
  it('computes the creator settlement a cancelled operation still owes', async () => {
    const lobbyId = process.env.CANCELLED_LOBBY_ID as `0x${string}` | undefined
    if (!lobbyId) return

    const lobby = await client.readContract('getLobby', { lobbyId })
    expect(lobby).not.toBeNull()
    expect(lobby!.creatorSettlement).toBeGreaterThan(0)
  })

  /**
   * The reveal gate, checked against the chain's own answer rather than
   * against the emulator's. A finished, revealed operation must read back as
   * revealed for every visitor — that is what makes the Reveal control
   * disappear once somebody has taken it.
   */
  it('reads a revealed attack back as revealed, with its winner', async () => {
    const lobbyId = process.env.RESOLVED_LOBBY_ID as `0x${string}` | undefined
    if (!lobbyId) return

    const lobby = await client.readContract('getLobby', { lobbyId })
    expect(lobby?.status).toBe('RESOLVED')
    expect(lobby?.activeAttackId).toBeTruthy()

    const reveal = await client.readContract('getAttackReveal', {
      lobbyId,
      attackId: lobby!.activeAttackId!,
    })
    expect(reveal).not.toBeNull()
    expect(reveal!.trajectory.lengthKm).toBeGreaterThan(0)
    expect(reveal!.results.length).toBe(reveal!.attempts.length)

    // ТЗ §17 — the winner reads back as owed a reward until they claim it.
    // This is the field `useSettlement` renders the Claim control from, and
    // it was hard-wired to NONE before a winner could ever be recognised.
    const participants = await client.readContract('getLobbyParticipants', { lobbyId, viewer: null })
    const winners = reveal!.outcome.winners.map((address) => address.toLowerCase())
    for (const participant of participants) {
      const expected = winners.includes(participant.address.toLowerCase())
      if (expected) expect(['PENDING', 'PAID']).toContain(participant.payoutState)
      else expect(participant.payoutState).toBe('NONE')
    }
  })
})
