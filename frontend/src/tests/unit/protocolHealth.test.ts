import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetProtocolHealth,
  DEGRADE_GRACE_MS,
  describePrivacyExecutorBlock,
  describeRpcError,
  getProtocolHealth,
  getProtocolHealthSnapshot,
  incoIndexFromLag,
  PRIVACY_HOLD_MS,
  privacyLayerDelayReason,
  reportChainBlock,
  reportPrivacyDelay,
  reportPrivacyLag,
  reportPrivacyOk,
  reportRpcFailure,
  RPC_ERROR_HOLD_MS,
  RPC_STALE_MS,
  subscribeProtocolHealth,
} from '../../blockchain/protocolHealth'

beforeEach(() => {
  vi.useFakeTimers()
  __resetProtocolHealth()
})

afterEach(() => {
  __resetProtocolHealth()
  vi.useRealTimers()
})

describe('protocolHealth', () => {
  it('starts operational on both lanes', () => {
    expect(getProtocolHealth()).toEqual({
      rpc: 'ok',
      rpcReason: null,
      privacy: 'ok',
      privacyReason: null,
      privacyLagSeconds: null,
    })
  })

  it('does not turn yellow for a failure shorter than the grace', () => {
    reportPrivacyDelay()
    expect(getProtocolHealth().privacy).toBe('ok')

    vi.advanceTimersByTime(2_000)
    expect(getProtocolHealthSnapshot().privacy).toBe('ok')

    reportPrivacyOk()
    vi.advanceTimersByTime(DEGRADE_GRACE_MS)
    expect(getProtocolHealthSnapshot().privacy).toBe('ok')
  })

  it('turns privacy delayed only after the grace, then recovers on a successful read', () => {
    reportPrivacyDelay()
    vi.advanceTimersByTime(DEGRADE_GRACE_MS + 50)
    expect(getProtocolHealthSnapshot().privacy).toBe('delayed')
    expect(getProtocolHealthSnapshot().privacyReason).toBe('The privacy layer is slow to answer.')

    reportPrivacyOk()
    expect(getProtocolHealth().privacy).toBe('ok')
  })

  it('clears a privacy delay after the hold with no further failure', () => {
    reportPrivacyDelay()
    vi.advanceTimersByTime(DEGRADE_GRACE_MS + 50)
    expect(getProtocolHealthSnapshot().privacy).toBe('delayed')

    vi.advanceTimersByTime(PRIVACY_HOLD_MS)
    expect(getProtocolHealthSnapshot().privacy).toBe('ok')
  })

  it('marks RPC delayed after a failure that outlives the grace, then recovers on a block', () => {
    reportRpcFailure('The public RPC is refusing this browser.')
    expect(getProtocolHealth().rpc).toBe('ok')

    vi.advanceTimersByTime(DEGRADE_GRACE_MS + 50)
    expect(getProtocolHealthSnapshot().rpc).toBe('delayed')
    expect(getProtocolHealthSnapshot().rpcReason).toBe('The public RPC is refusing this browser.')

    reportChainBlock()
    expect(getProtocolHealth().rpc).toBe('ok')
    expect(getProtocolHealth().rpcReason).toBeNull()
  })

  it('marks RPC delayed when blocks stall after one had arrived', () => {
    reportChainBlock()
    expect(getProtocolHealth().rpc).toBe('ok')

    vi.advanceTimersByTime(RPC_STALE_MS + 50)
    expect(getProtocolHealthSnapshot().rpc).toBe('delayed')
    expect(getProtocolHealthSnapshot().rpcReason).toBe('The chain RPC is slow to answer.')
  })

  it('does not treat a tab that has never seen a block as a stall', () => {
    vi.advanceTimersByTime(RPC_STALE_MS + 50)
    expect(getProtocolHealth().rpc).toBe('ok')
  })

  it('clears an RPC error hold once it expires', () => {
    reportRpcFailure('The chain RPC is failing to answer.')
    vi.advanceTimersByTime(DEGRADE_GRACE_MS + RPC_ERROR_HOLD_MS + 50)
    expect(getProtocolHealthSnapshot().rpc).toBe('ok')
  })

  it('notifies subscribers when a lane actually changes, not on the first blip', () => {
    const notify = vi.fn()
    const unsubscribe = subscribeProtocolHealth(notify)
    reportPrivacyDelay()
    expect(notify).not.toHaveBeenCalled()
    vi.advanceTimersByTime(DEGRADE_GRACE_MS + 50)
    expect(notify).toHaveBeenCalledTimes(1)
    reportPrivacyDelay()
    expect(notify).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})

describe('privacy indexer lag', () => {
  it('turns the privacy lane yellow immediately and keeps the published lag', () => {
    reportPrivacyLag(1725)
    expect(getProtocolHealth()).toMatchObject({
      privacy: 'delayed',
      privacyReason: 'The privacy layer is 29 minutes behind the chain.',
      privacyLagSeconds: 1725,
    })
  })

  it('does not drop a published lag when the ordinary hold expires', () => {
    reportPrivacyLag(1725)
    vi.advanceTimersByTime(PRIVACY_HOLD_MS + 1_000)
    expect(getProtocolHealth().privacy).toBe('delayed')
    expect(getProtocolHealth().privacyLagSeconds).toBe(1725)
  })

  it('clears lag only when a confidential read succeeds', () => {
    reportPrivacyLag(1725)
    reportPrivacyOk()
    expect(getProtocolHealth()).toMatchObject({
      privacy: 'ok',
      privacyReason: null,
      privacyLagSeconds: null,
    })
  })

  it('still waits out the grace for a few seconds of ACL lag', () => {
    reportPrivacyLag(12)
    expect(getProtocolHealth().privacy).toBe('ok')
    expect(getProtocolHealth().privacyLagSeconds).toBeNull()
  })
})

describe('incoIndexFromLag', () => {
  it('converts seconds behind into host-chain blocks', () => {
    expect(incoIndexFromLag(45_356_164, 1725, 2000)).toEqual({
      blocksBehind: 863,
      indexedBlock: 45_355_301,
    })
  })

  it('ignores lag shorter than the warn threshold', () => {
    expect(incoIndexFromLag(100, 12, 2000)).toBeNull()
  })
})

describe('describePrivacyExecutorBlock', () => {
  it('shows the ingested height and why it is behind', () => {
    expect(
      describePrivacyExecutorBlock({
        emulator: false,
        lagSeconds: 1725,
        chainBlock: 45_356_164,
        blockTimeMs: 2000,
        delayReason: 'The privacy layer is 29 minutes behind the chain.',
      }),
    ).toEqual({
      privacyExecutorBlock: 45_355_301,
      privacyExecutorBlockHint: 'The privacy layer is 29 minutes behind the chain. 863 blocks behind.',
      privacyExecutorBlockWarn: true,
    })
  })

  it('matches the network head when nothing is behind', () => {
    expect(
      describePrivacyExecutorBlock({
        emulator: false,
        lagSeconds: null,
        chainBlock: 10,
        blockTimeMs: 2000,
        delayReason: null,
      }),
    ).toEqual({
      privacyExecutorBlock: 10,
      privacyExecutorBlockHint: null,
      privacyExecutorBlockWarn: false,
    })
  })

  it('does not yellow the block row for an unreachable quorum', () => {
    expect(
      describePrivacyExecutorBlock({
        emulator: false,
        lagSeconds: null,
        chainBlock: 10,
        blockTimeMs: 2000,
        delayReason: 'The privacy layer is slow to answer.',
      }),
    ).toEqual({
      privacyExecutorBlock: 10,
      privacyExecutorBlockHint: null,
      privacyExecutorBlockWarn: false,
    })
  })
})

describe('privacyLayerDelayReason', () => {
  it('drops indexer lag so the Privacy layer row does not repeat the block hint', () => {
    expect(
      privacyLayerDelayReason('The privacy layer is 29 minutes behind the chain.', 1725),
    ).toBeNull()
  })

  it('keeps an unreachable-quorum reason on the Privacy layer row', () => {
    expect(privacyLayerDelayReason('The privacy layer is slow to answer.', null)).toBe(
      'The privacy layer is slow to answer.',
    )
  })
})

describe('describeRpcError', () => {
  it('names a 403 as the public RPC refusing the browser', () => {
    expect(describeRpcError(new Error('HTTP request failed: 403 Forbidden'))).toBe(
      'The public RPC is refusing this browser.',
    )
  })

  it('names a 500 as the chain RPC failing to answer', () => {
    expect(describeRpcError(new Error('Internal Server Error 500'))).toBe(
      'The chain RPC is failing to answer.',
    )
  })

  it('falls back to a delay when the error has no status', () => {
    expect(describeRpcError(new Error('fetch failed'))).toBe('The chain RPC is slow to answer.')
  })
})
