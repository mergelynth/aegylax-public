import { useEffect, useSyncExternalStore } from 'react'
import type { BlockchainClient } from '../blockchain/types'
import { useBlockchainClient } from './useBlockchainClient'

/**
 * How fast this chain is *actually* producing blocks, in ms per block.
 *
 * Every countdown in the app converts blocks into seconds, and it used to do
 * it with a configured constant. That constant is a nominal figure — "Base
 * makes a block every 2s" — and a real chain does not honour it: blocks
 * arrive early, late, and occasionally in bursts after a lull.
 *
 * The visible consequence is the one worth naming, because it looks like a
 * bug in the clock rather than in the chain. `useSmoothCountdown` re-anchors
 * on every block, so if the constant says 2s and blocks are really landing
 * every 2.4s, each re-anchor pushes the target further out than the
 * interpolation had assumed and the digits *jump upwards*. Faster blocks
 * make them jump down. The countdown ticks smoothly for two seconds, then
 * corrects, over and over — which is exactly the "random seconds" a player
 * sees.
 *
 * Measuring closes the loop. The estimate converges on the rate the chain is
 * actually running at, so successive anchors agree with the interpolation
 * between them and the correction shrinks to nothing. It is still the chain
 * deciding: this changes only how blocks are *translated* into seconds, never
 * which block anything is counting to.
 *
 * **The estimate is one number for the whole application, and that is the
 * point.** It used to be per-hook state: every component calling this started
 * its own average at the nominal figure and converged from there, over its own
 * subscription, from the moment *it* happened to mount. Two readouts counting
 * to the very same block therefore divided that block count by two different
 * numbers — a page that had been open for a while might be running on a
 * measured 5.4s while a modal that had just opened was still on the nominal
 * 2.0s, and the same eleven blocks read as a minute in one place and
 * twenty-two seconds in the other. The countdowns were not disagreeing about
 * the chain; they were disagreeing about the conversion. Hoisting the estimate
 * to module scope is what makes "one clock" true rather than merely intended:
 * there is one subscription, one running average, and every countdown on the
 * screen divides by the same figure in the same commit.
 */

/** How much each observation moves the estimate. Low enough that one odd block barely registers. */
const SMOOTHING = 0.15

/**
 * How far from the configured rate an observation may be and still be
 * believed, as a multiple of it.
 *
 * The samples worth discarding are not unusual blocks, they are not
 * measurements at all: a backgrounded tab resumes and reports one gap of
 * several minutes, and a client catching up after a reconnect sees a dozen
 * blocks arrive in one poll. Feeding either into the average would make the
 * countdown wrong for the next twenty blocks.
 */
const PLAUSIBLE_MIN_FACTOR = 0.2
const PLAUSIBLE_MAX_FACTOR = 5

/** 1% of a block is well under the smallest thing a countdown can show. */
const PUBLISH_THRESHOLD_FRACTION = 0.01

interface RateStore {
  client: BlockchainClient
  configuredMs: number
  /** The running average — updated on every block, published only when it moves enough to matter. */
  estimate: number
  /** What subscribers actually read. */
  published: number
  previous: { block: number; at: number } | null
  unsubscribeBlocks: (() => void) | null
}

let store: RateStore | null = null

/**
 * Outlives any one store, so `subscribe` can be a stable module-level
 * function. A changing `subscribe` identity makes `useSyncExternalStore` tear
 * the subscription down and rebuild it on every render, which is exactly the
 * churn this hook exists to remove.
 */
const subscribers = new Set<() => void>()

function subscribe(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange)
  return () => {
    subscribers.delete(onStoreChange)
  }
}

/**
 * Rebuilt only when the client or the nominal rate actually changes — which
 * in practice is once, at startup. Everything else shares what is here.
 */
function ensureStore(client: BlockchainClient, configuredMs: number): RateStore {
  if (store && store.client === client && store.configuredMs === configuredMs) return store

  store?.unsubscribeBlocks?.()

  store = {
    client,
    configuredMs,
    estimate: configuredMs,
    published: configuredMs,
    previous: null,
    unsubscribeBlocks: null,
  }
  const current = store

  current.unsubscribeBlocks = client.subscribeToBlocks((block) => {
    const at = Date.now()
    const last = current.previous
    current.previous = { block, at }
    if (!last || block <= last.block) return

    /*
     * Divided by the block delta rather than assuming one block per push. In
     * contract mode the feed is a poll, so several blocks can arrive in one
     * callback and the interval between callbacks is quantised by the polling
     * period — dividing by the delta is what turns both of those into an
     * honest per-block figure.
     */
    const perBlock = (at - last.at) / (block - last.block)
    if (perBlock < configuredMs * PLAUSIBLE_MIN_FACTOR || perBlock > configuredMs * PLAUSIBLE_MAX_FACTOR) return

    current.estimate += (perBlock - current.estimate) * SMOOTHING
    if (Math.abs(current.estimate - current.published) > configuredMs * PUBLISH_THRESHOLD_FRACTION) {
      current.published = current.estimate
      subscribers.forEach((notify) => notify())
    }
  })

  // A rebuilt store starts at the nominal figure again, so anything already
  // watching has to be told the number it is holding is stale.
  subscribers.forEach((notify) => notify())
  return current
}

/**
 * Resets the shared estimate. Test-only — the store is module state, so one
 * test's chain would otherwise be measured by the next one's.
 */
export function __resetBlockRateForTests(): void {
  store?.unsubscribeBlocks?.()
  store = null
}

export function useBlockRate(configuredMs: number): number {
  const client = useBlockchainClient()

  /*
   * The store is created during render rather than in an effect, so the very
   * first paint already reads the shared figure instead of the nominal one.
   * `ensureStore` is idempotent for an unchanged client, which is what makes
   * that safe under StrictMode's double render.
   */
  const active = ensureStore(client, configuredMs)

  useEffect(() => {
    // Re-assert on mount: a store torn down and rebuilt between the render
    // above and this effect must end up with a live subscription.
    ensureStore(client, configuredMs)
  }, [client, configuredMs])

  return useSyncExternalStore(
    subscribe,
    () => (store ?? active).published,
    () => configuredMs,
  )
}
