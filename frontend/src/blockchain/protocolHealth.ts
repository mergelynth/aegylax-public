/**
 * This tab's view of whether the chain RPC and the privacy layer
 * are answering.
 *
 * The header used to paint the shield green whenever a contract address
 * was configured and *some* block had arrived. That stayed green through
 * public-RPC 403s (while a fallback still dribbled blocks) and through
 * Inco 500s (which never touch `eth_blockNumber`). The player saw
 * "operational" next to a reveal that would not open.
 *
 * There is no backend that could count how many other tabs are failing,
 * so this is deliberately local: errors this tab already sees, plus a
 * light RPC heartbeat. Green returns when those same calls succeed again.
 *
 * Yellow is held back for `DEGRADE_GRACE_MS` so a single retry that
 * lands in two seconds never flashes the shield.
 */

export type HealthLane = 'ok' | 'delayed'

export interface ProtocolHealth {
  rpc: HealthLane
  rpcReason: string | null
  privacy: HealthLane
  privacyReason: string | null
  /**
   * How far the confidential indexer is behind the host chain, when we
   * have been told. `IsReady` does not report this — it arrives as
   * `out of sync: N seconds behind` on an ACL check. Null means we have
   * not seen that, not that they are caught up.
   */
  privacyLagSeconds: number | null
}

/** No new block for this long, after we had one, is a stall rather than a quiet chain. */
export const RPC_STALE_MS = 15_000

/** A reported RPC error keeps the lane yellow at least this long, once it has passed the grace. */
export const RPC_ERROR_HOLD_MS = 25_000

/**
 * A reported Inco failure keeps the lane yellow until a successful read,
 * or until this long with no further failure — so a tab that has left the
 * Operation screen does not stay yellow forever.
 */
export const PRIVACY_HOLD_MS = 90_000

/**
 * How long a lane must keep failing before the shield turns yellow.
 * Shorter than this is a retry, not a status.
 */
export const DEGRADE_GRACE_MS = 8_000

/** How often the status hook re-reads `eth_blockNumber` when the push feed is silent. */
export const RPC_HEARTBEAT_MS = 12_000

/**
 * How often the header asks Inco `IsReady`.
 *
 * Longer than the RPC beat: this is a request to their covalidators, not
 * to an endpoint we already read every block. Short enough that a global
 * outage still turns the shield yellow on Home before a player has to
 * open an Operation to find out.
 */
export const PRIVACY_HEARTBEAT_MS = 20_000

/**
 * Indexer lag shorter than this is ACL settling, not a status. At 2s
 * blocks, 30s is ~15 blocks — enough that a player waiting on a decrypt
 * should see the executor block turn yellow.
 */
export const PRIVACY_LAG_WARN_SECONDS = 30

const PRIVACY_DELAY_REASON = 'The privacy layer is slow to answer.'
const RPC_DELAY_REASON = 'The chain RPC is slow to answer.'

const IDLE: ProtocolHealth = {
  rpc: 'ok',
  rpcReason: null,
  privacy: 'ok',
  privacyReason: null,
  privacyLagSeconds: null,
}

const subscribers = new Set<() => void>()

let lastBlockAt = 0
let rpcFailingSince = 0
let rpcLastFailAt = 0
let rpcReason: string | null = null
let privacyFailingSince = 0
let privacyLastFailAt = 0
let privacyReason: string | null = null
let privacyLagSeconds: number | null = null
let snapshot: ProtocolHealth = IDLE
let expiryTimer: ReturnType<typeof setTimeout> | null = null

export function subscribeProtocolHealth(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange)
  return () => {
    subscribers.delete(onStoreChange)
  }
}

export function getProtocolHealthSnapshot(): ProtocolHealth {
  return snapshot
}

export function getProtocolHealth(now = Date.now()): ProtocolHealth {
  const rpcDelayed =
    (lastBlockAt > 0 && now - lastBlockAt > RPC_STALE_MS) ||
    laneDelayed(rpcFailingSince, rpcLastFailAt, now, RPC_ERROR_HOLD_MS)
  const lagActive = privacyLagSeconds !== null && privacyLagSeconds >= PRIVACY_LAG_WARN_SECONDS
  /*
   * Indexer lag is not a blip: 29 minutes behind should yellow on the
   * first report, and stay yellow until a confidential read succeeds —
   * `IsReady` can be true the whole time. The 8s grace and 90s hold are
   * for "slow to answer", not for a number they themselves published.
   */
  const privacyDelayed =
    lagActive || laneDelayed(privacyFailingSince, privacyLastFailAt, now, PRIVACY_HOLD_MS)
  return {
    rpc: rpcDelayed ? 'delayed' : 'ok',
    rpcReason: rpcDelayed ? (rpcReason ?? RPC_DELAY_REASON) : null,
    privacy: privacyDelayed ? 'delayed' : 'ok',
    privacyReason: privacyDelayed ? (privacyReason ?? PRIVACY_DELAY_REASON) : null,
    privacyLagSeconds: lagActive ? privacyLagSeconds : null,
  }
}

function laneDelayed(failingSince: number, lastFailAt: number, now: number, holdMs: number): boolean {
  if (failingSince === 0 || lastFailAt === 0) return false
  if (now - failingSince < DEGRADE_GRACE_MS) return false
  return now - lastFailAt < holdMs
}

/** A block number arrived, or a heartbeat `eth_blockNumber` succeeded. */
export function reportChainBlock(now = Date.now()): void {
  lastBlockAt = now
  rpcFailingSince = 0
  rpcLastFailAt = 0
  rpcReason = null
  publish(now)
}

export function reportRpcFailure(reason: string, now = Date.now()): void {
  if (rpcFailingSince === 0) rpcFailingSince = now
  rpcLastFailAt = now
  rpcReason = reason
  publish(now)
}

export function reportPrivacyOk(now = Date.now()): void {
  if (privacyFailingSince === 0 && privacyLagSeconds === null) return
  privacyFailingSince = 0
  privacyLastFailAt = 0
  privacyReason = null
  privacyLagSeconds = null
  publish(now)
}

export function reportPrivacyDelay(reason: string = PRIVACY_DELAY_REASON, now = Date.now()): void {
  if (privacyFailingSince === 0) privacyFailingSince = now
  privacyLastFailAt = now
  privacyReason = reason
  publish(now)
}

/**
 * The covalidator told us how far its indexer is behind the host chain.
 *
 * Distinct from `reportPrivacyDelay`: a few seconds of "slow to answer"
 * still waits out the grace, but a published lag of tens of seconds is
 * already the status, and `IsReady` must not clear it.
 */
export function reportPrivacyLag(seconds: number, now = Date.now()): void {
  if (seconds < PRIVACY_LAG_WARN_SECONDS) {
    reportPrivacyDelay(describePrivacyLag(seconds), now)
    return
  }
  privacyLagSeconds = seconds
  if (privacyFailingSince === 0 || now - privacyFailingSince < DEGRADE_GRACE_MS) {
    privacyFailingSince = now - DEGRADE_GRACE_MS
  }
  privacyLastFailAt = now
  privacyReason = describePrivacyLag(seconds)
  publish(now)
}

export function describePrivacyLag(seconds: number): string {
  if (seconds < 60) return `The privacy layer is ${seconds} seconds behind the chain.`
  const minutes = Math.max(1, Math.round(seconds / 60))
  return `The privacy layer is ${minutes} minutes behind the chain.`
}

/**
 * Host-chain blocks the covalidator has not ingested, from the lag it
 * reported and this chain's block time. The executor contract has no
 * synced-height getter; this is the comparison the status row can show.
 */
export function incoIndexFromLag(
  chainBlock: number | null,
  lagSeconds: number | null,
  blockTimeMs: number,
): { blocksBehind: number; indexedBlock: number | null } | null {
  if (lagSeconds === null || lagSeconds < PRIVACY_LAG_WARN_SECONDS) return null
  const blockTimeS = Math.max(0.001, blockTimeMs / 1000)
  const blocksBehind = Math.max(1, Math.round(lagSeconds / blockTimeS))
  return {
    blocksBehind,
    indexedBlock: chainBlock === null ? null : Math.max(0, chainBlock - blocksBehind),
  }
}

/**
 * The host-chain height the covalidator has ingested, for the privacy
 * Current block row under Privacy executor.
 *
 * Inco does not publish a synced-height getter, so this is the network
 * head minus any lag they themselves reported. Same number as the chain
 * Current block when nothing is behind; yellow only when that gap is
 * already a status, not a few seconds of ACL settling.
 */
export function describePrivacyExecutorBlock(opts: {
  emulator: boolean
  lagSeconds: number | null
  chainBlock: number | null
  blockTimeMs: number
  delayReason: string | null
}): {
  privacyExecutorBlock: number | null
  privacyExecutorBlockHint: string | null
  privacyExecutorBlockWarn: boolean
} {
  if (opts.emulator) {
    return { privacyExecutorBlock: null, privacyExecutorBlockHint: null, privacyExecutorBlockWarn: false }
  }
  const index = incoIndexFromLag(opts.chainBlock, opts.lagSeconds, opts.blockTimeMs)
  if (index) {
    const lagHint = opts.delayReason ?? describePrivacyLag(opts.lagSeconds ?? 0)
    return {
      privacyExecutorBlock: index.indexedBlock,
      privacyExecutorBlockHint: `${lagHint} ${index.blocksBehind} blocks behind.`,
      privacyExecutorBlockWarn: true,
    }
  }
  return {
    privacyExecutorBlock: opts.chainBlock,
    privacyExecutorBlockHint: null,
    privacyExecutorBlockWarn: false,
  }
}

/**
 * Copy for the Privacy layer row.
 *
 * Indexer lag already yellows the privacy Current block row with the
 * same sentence plus how many blocks that is, so repeating it here made
 * the panel look like two errors. An unreachable quorum still belongs
 * on this row: that is not a height gap.
 */
export function privacyLayerDelayReason(
  delayReason: string | null,
  lagSeconds: number | null,
): string | null {
  if (lagSeconds !== null && lagSeconds >= PRIVACY_LAG_WARN_SECONDS) return null
  return delayReason
}

export function describeRpcError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (message.includes('403') || message.includes('forbidden')) {
    return 'The public RPC is refusing this browser.'
  }
  if (message.includes('429') || message.includes('too many requests')) {
    return 'The chain RPC is rate-limiting this tab.'
  }
  if (message.includes('500') || message.includes('internal server')) {
    return 'The chain RPC is failing to answer.'
  }
  return RPC_DELAY_REASON
}

/** Test-only — the store is module state. */
export function __resetProtocolHealth(): void {
  lastBlockAt = 0
  rpcFailingSince = 0
  rpcLastFailAt = 0
  rpcReason = null
  privacyFailingSince = 0
  privacyLastFailAt = 0
  privacyReason = null
  privacyLagSeconds = null
  snapshot = IDLE
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
}

function publish(now: number): void {
  const next = getProtocolHealth(now)
  const changed =
    next.rpc !== snapshot.rpc ||
    next.rpcReason !== snapshot.rpcReason ||
    next.privacy !== snapshot.privacy ||
    next.privacyReason !== snapshot.privacyReason ||
    next.privacyLagSeconds !== snapshot.privacyLagSeconds
  if (changed) {
    snapshot = next
    subscribers.forEach((notify) => notify())
  }
  scheduleExpiry(now)
}

function scheduleExpiry(now: number): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }

  const candidates = [
    graceAt(rpcFailingSince, now),
    holdUntil(rpcLastFailAt, RPC_ERROR_HOLD_MS, now),
    graceAt(privacyFailingSince, now),
    holdUntil(privacyLastFailAt, PRIVACY_HOLD_MS, now),
    lastBlockAt > 0 ? lastBlockAt + RPC_STALE_MS : Infinity,
  ]
  const nextAt = Math.min(...candidates)
  if (!Number.isFinite(nextAt)) return

  const wait = Math.max(0, nextAt - now + 25)
  expiryTimer = setTimeout(() => {
    expiryTimer = null
    publish(Date.now())
  }, wait)
}

function graceAt(failingSince: number, now: number): number {
  if (failingSince === 0) return Infinity
  const at = failingSince + DEGRADE_GRACE_MS
  return at > now ? at : Infinity
}

function holdUntil(lastFailAt: number, holdMs: number, now: number): number {
  if (lastFailAt === 0) return Infinity
  const at = lastFailAt + holdMs
  return at > now ? at : Infinity
}
