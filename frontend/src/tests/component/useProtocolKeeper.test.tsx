import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  useProtocolKeeper,
  MAX_ATTEMPTS,
  MAX_NUDGES,
  NUDGE_RETRY_DELAY_MS,
  RETRY_DELAY_MS,
  __resetKeeperGuard,
} from '../../hooks/useProtocolKeeper'
import type { Address, Hash, Lobby } from '../../game/types'
import { buildTestLobbyConfig } from '../fixtures'

/**
 * The daemon that stands in for the missing backend (ТЗ §4, §10).
 *
 * After an attack lands its geometry stays sealed until somebody carries the
 * attested plaintexts back on chain, and until they do the operation has no
 * trajectory, no winner and no claimable reward. Leaving that to a button
 * puts the cost on whoever happens to be looking — usually a defender who
 * just lost — so the client sends it instead.
 *
 * These pin down the guards, because the guards are the whole safety
 * argument: the reveal itself is permissionless and idempotent, so the risk
 * was never a wrong result. It was opening somebody's wallet without being
 * asked.
 */

const VIEWER = '0x1111111111111111111111111111111111111111' as Address
const STRANGER = '0x9999999999999999999999999999999999999999' as Address
const ATTACK = '0xattack'

vi.mock('../../hooks/useWallet', () => ({
  useWallet: () => ({ address: mockAddress }),
}))

/**
 * The two clients the guards branch on, and the difference is who pays.
 *
 * `maintain` is what makes a client keeper-capable at all. Contract mode on
 * top of it means a backend keeper signs the reveal and the page only posts
 * a nudge — free, so anybody with the operation open may send it. Anything
 * else signs in this tab, which is a wallet prompt and somebody's gas, and
 * that is the case the stake guard exists for.
 *
 * Hoisted to constants rather than built per call, because the real provider
 * hands back one stable client for the session and a mock that minted a new
 * object every render would be testing a component tree the app does not
 * have.
 */
const KEEPER_CLIENT = { mode: 'contract', maintain: () => Promise.resolve() }
const SIGNING_CLIENT = { mode: 'emulator', maintain: () => Promise.resolve() }

vi.mock('../../hooks/useBlockchainClient', () => ({
  useBlockchainClient: () => mockClient,
}))

let mockClient: typeof KEEPER_CLIENT | typeof SIGNING_CLIENT = KEEPER_CLIENT
let mockAddress: Address | null = VIEWER

function buildLobby(overrides: Partial<Lobby> = {}): Lobby {
  return {
    id: '0xlobby' as Hash,
    creationTxHash: '0xlobby' as Hash,
    creator: '0xcreator' as Address,
    createdAtBlock: 1,
    status: 'ACTIVE',
    ending: 'NONE',
    config: buildTestLobbyConfig(),
    participantCount: 1,
    participantAddresses: [VIEWER],
    currentEpochId: 1,
    activeAttackId: ATTACK,
    outcome: null,
    creatorSettlement: 0,
    creatorSettled: false,
    reveal: null,
    ...overrides,
  }
}

function render(overrides: Partial<Parameters<typeof useProtocolKeeper>[0]> = {}) {
  const reveal = vi.fn().mockResolvedValue(undefined)
  const onRevealed = vi.fn().mockResolvedValue(undefined)
  const props = {
    lobby: buildLobby(),
    attackId: ATTACK,
    // The one phase a reveal is due in: the round is over.
    phase: 'RESULT' as const,
    revealLoaded: true,
    isScored: false,
    reveal,
    onRevealed,
    ...overrides,
  }
  const result = renderHook(() => useProtocolKeeper(props))
  return { ...result, reveal: props.reveal, onRevealed: props.onRevealed }
}

afterEach(() => {
  __resetKeeperGuard()
  mockClient = KEEPER_CLIENT
  mockAddress = VIEWER
  vi.clearAllMocks()
})

describe('useProtocolKeeper (ТЗ §4, §10)', () => {
  it('reveals a finished round nobody has revealed, and re-reads it', async () => {
    const { reveal, onRevealed } = render()

    await waitFor(() => expect(reveal).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(onRevealed).toHaveBeenCalledTimes(1))
  })

  /**
   * A passer-by reading an operation they have nothing to do with must never
   * have their wallet opened or their gas spent on it. The manual Reveal
   * control stays on screen for them.
   */
  it('leaves a wallet with no stake alone when the reveal costs gas', async () => {
    mockClient = SIGNING_CLIENT
    mockAddress = STRANGER
    const { reveal } = render()

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reveal).not.toHaveBeenCalled()
  })

  /**
   * And the mirror image, which is the case that actually strands rounds.
   *
   * Where a backend keeper signs, a reveal is an HTTP nudge — no wallet, no
   * gas, nothing of the viewer's spent. The guard above has nothing left to
   * protect, and applying it anyway meant the round most likely to sit
   * unrevealed — the one whose players have closed the tab, watched by
   * somebody with no stake — was the one nobody was allowed to finish.
   */
  it('lets a passer-by finish the round when the keeper signs it', async () => {
    mockAddress = STRANGER
    const { reveal } = render()

    await waitFor(() => expect(reveal).toHaveBeenCalledTimes(1))
  })

  it('acts for the creator as well as the defenders', async () => {
    mockClient = SIGNING_CLIENT
    mockAddress = STRANGER
    const { reveal } = render({ lobby: buildLobby({ creator: STRANGER, participantAddresses: [] }) })

    await waitFor(() => expect(reveal).toHaveBeenCalledTimes(1))
  })

  it('does nothing while the round is still running', async () => {
    const { reveal } = render({ phase: 'ATTACK_ACTIVE' })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reveal).not.toHaveBeenCalled()
  })

  it('does nothing once somebody has already revealed', async () => {
    const { reveal } = render({ isScored: true })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reveal).not.toHaveBeenCalled()
  })

  /**
   * `revealed === null` means both "nobody has revealed" and "we have not
   * asked yet", and the second is briefly true on every load — so acting on
   * it would fire a reveal at every already-revealed operation somebody
   * opens.
   */
  it('waits for the chain to answer before deciding a reveal is due', async () => {
    const { reveal } = render({ revealLoaded: false })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reveal).not.toHaveBeenCalled()
  })

  /**
   * The attempt budget has to outlive the component.
   *
   * As a `useRef` it would reset on every remount, so navigating away and
   * back — or a StrictMode double-mount — would hand the attack a fresh
   * allowance each time and turn a bounded retry into an unbounded one.
   * Spending the budget down to zero here and then remounting is the test
   * that it is shared rather than per-instance.
   *
   * Failures, not successes: a send that landed must not spend another
   * attempt on remount, or the wallet opens for `revealAndResolve` again.
   */
  it('shares one attempt budget per attack, across remounts', async () => {
    mockClient = SIGNING_CLIENT
    const reveal = vi.fn().mockRejectedValue(new Error('not processed yet'))
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const view = render({ reveal })
      await waitFor(() => expect(reveal).toHaveBeenCalledTimes(attempt))
      await waitFor(() => expect(view.result.current.busy).toBe(false))
      view.unmount()
    }

    const exhausted = render({ reveal })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reveal).toHaveBeenCalledTimes(MAX_ATTEMPTS)
    exhausted.unmount()
  })

  /**
   * A failure is reported rather than swallowed, and re-rendering on its own
   * does not spend another attempt — the retry is on a timer, and a render
   * caused by the error being set must not be mistaken for one.
   */
  it('reports a failure without re-firing on the render it causes', async () => {
    const reveal = vi.fn().mockRejectedValue(new Error('covalidator unavailable'))
    const { result, rerender } = renderHook(() =>
      useProtocolKeeper({
        lobby: buildLobby(),
        attackId: ATTACK,
        phase: 'RESULT',
        revealLoaded: true,
        isScored: false,
        reveal,
        onRevealed: vi.fn(),
      }),
    )

    await waitFor(() => expect(result.current.error).toMatch(/covalidator unavailable/))
    expect(result.current.busy).toBe(false)

    rerender()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reveal).toHaveBeenCalledTimes(1)
  })

  /**
   * The reveal now makes a round trip to the covalidator quorum between its
   * two transactions, and the quorum learns about the unlock by watching the
   * chain — so "not processed yet" is an ordinary answer to fail on, and it
   * clears by itself. Giving up on the first one stranded the operation in a
   * finished round with no result, which is the state this hook exists to
   * prevent. It tries again, up to the budget.
   */
  it('tries again after a failure, up to the budget', async () => {
    mockClient = SIGNING_CLIENT
    vi.useFakeTimers()
    try {
      const reveal = vi.fn().mockRejectedValue(new Error('not processed yet'))
      render({ reveal })
      await vi.waitFor(() => expect(reveal).toHaveBeenCalledTimes(1))

      // The round is still unscored — nothing about the chain has changed,
      // which is precisely the case a dependency-driven effect cannot see.
      for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
        await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS + 1)
        await vi.waitFor(() => expect(reveal).toHaveBeenCalledTimes(attempt))
      }

      // And then it stops, rather than prompting the wallet forever.
      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 4)
      expect(reveal).toHaveBeenCalledTimes(MAX_ATTEMPTS)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * The nudge path is paced for a different cost.
   *
   * A retry that opens a wallet is worth three tries twelve seconds apart. A
   * retry that posts to a job the keeper already deduplicates per operation
   * is worth ten, three seconds apart — which is what turns "the reveal will
   * arrive eventually" into a wait a player can sit through. Both still
   * stop, because a keeper that is down must not be asked forever.
   */
  it('nudges more often, and more times, than it would sign', async () => {
    vi.useFakeTimers()
    try {
      const reveal = vi.fn().mockRejectedValue(new Error('the keeper did not start the reveal'))
      render({ reveal })
      await vi.waitFor(() => expect(reveal).toHaveBeenCalledTimes(1))

      for (let attempt = 2; attempt <= MAX_NUDGES; attempt++) {
        await vi.advanceTimersByTimeAsync(NUDGE_RETRY_DELAY_MS + 1)
        await vi.waitFor(() => expect(reveal).toHaveBeenCalledTimes(attempt))
      }

      await vi.advanceTimersByTimeAsync(NUDGE_RETRY_DELAY_MS * 4)
      expect(reveal).toHaveBeenCalledTimes(MAX_NUDGES)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * A send that already landed must not be sent again just because the
   * score has not been read back yet. That was the third wallet prompt:
   * `unlockRound`, `revealAndResolve`, and twelve seconds later another
   * `revealAndResolve`.
   */
  it('does not retry a reveal that already succeeded', async () => {
    vi.useFakeTimers()
    try {
      const { reveal } = render()
      await vi.waitFor(() => expect(reveal).toHaveBeenCalledTimes(1))

      await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS * 4)
      expect(reveal).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  /**
   * StrictMode remounts while the first send is still sitting in the wallet.
   * Starting a second attempt then is two `unlockRound`s plus the scoring
   * transaction — three prompts for a two-transaction protocol.
   */
  it('does not start a second attempt while one is still in flight', async () => {
    let release!: () => void
    const reveal = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const first = render({ reveal })
    await waitFor(() => expect(reveal).toHaveBeenCalledTimes(1))
    first.unmount()

    const second = render({ reveal })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reveal).toHaveBeenCalledTimes(1)

    release()
    await waitFor(() => expect(second.result.current.busy).toBe(false))
    second.unmount()
  })

  it('does nothing before the operation has loaded', async () => {
    const { reveal } = render({ lobby: null, phase: null })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(reveal).not.toHaveBeenCalled()
  })
})
