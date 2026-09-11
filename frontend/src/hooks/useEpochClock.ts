import { useEffect, useSyncExternalStore } from 'react'
import type { BlockchainClient } from '../blockchain/types'
import { useBlockchainClient } from './useBlockchainClient'

/**
 * The shared block reference every client derives epoch/attack state from
 * (spec §19) — never local wall-clock time for authoritative state.
 *
 * Pushed via `subscribeToBlocks` instead of polling `getBlockNumber` on a
 * timer. The **timestamp** is the chain's own `block.timestamp`, fetched
 * once per head and shared for the whole tab, so two windows looking at
 * the same block compute the same countdown origin rather than each
 * anchoring on whenever *their* RPC happened to answer.
 */

export interface EpochClock {
  blockNumber: number | null
  /** Unix ms of the head block, or null until `getBlock` has answered. */
  timestampMs: number | null
}

let clock: EpochClock = { blockNumber: null, timestampMs: null }
let version = 0
const subscribers = new Set<() => void>()

interface Watch {
  client: BlockchainClient
  unsubscribe: () => void
}

let watch: Watch | null = null
/** Newest head we have asked `getBlock` for, so a slow RPC cannot publish an older timestamp. */
let inflight = -1

function subscribe(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange)
  return () => {
    subscribers.delete(onStoreChange)
  }
}

function publish(next: EpochClock): void {
  if (next.blockNumber === clock.blockNumber && next.timestampMs === clock.timestampMs) return
  if (clock.blockNumber !== null && next.blockNumber !== null && next.blockNumber < clock.blockNumber) return
  clock = next
  version += 1
  subscribers.forEach((notify) => notify())
}

function ingest(client: BlockchainClient, blockNumber: number): void {
  if (blockNumber < inflight) return
  inflight = blockNumber

  if (typeof client.getBlock !== 'function') {
    publish({ blockNumber, timestampMs: null })
    return
  }

  void client.getBlock(blockNumber).then(
    (block) => {
      if (block.number < inflight) return
      publish({
        blockNumber: block.number,
        timestampMs: block.timestamp < 1e12 ? block.timestamp * 1000 : block.timestamp,
      })
    },
    () => {
      if (blockNumber < inflight) return
      publish({ blockNumber, timestampMs: null })
    },
  )
}

function ensureWatch(client: BlockchainClient): void {
  if (watch?.client === client) return
  watch?.unsubscribe()
  clock = { blockNumber: null, timestampMs: null }
  inflight = -1
  version += 1
  const unsub = client.subscribeToBlocks((next) => ingest(client, next))
  watch = { client, unsubscribe: unsub }
  void client.getBlockNumber().then(
    (next) => ingest(client, next),
    () => {},
  )
  subscribers.forEach((notify) => notify())
}

export function __resetEpochClockForTests(): void {
  watch?.unsubscribe()
  watch = null
  clock = { blockNumber: null, timestampMs: null }
  inflight = -1
  version += 1
}

/**
 * The chain's head, as number and as timestamp.
 *
 * One subscription and one `getBlock` per new head for the whole app, so
 * the header countdown and the operation countdown cannot be reading two
 * different blocks, and two browser windows cannot invent two different
 * "now"s from the moment they heard the poll.
 */
export function useEpochClock(): EpochClock {
  const client = useBlockchainClient()
  useEffect(() => {
    ensureWatch(client)
  }, [client])

  useSyncExternalStore(subscribe, () => version, () => 0)
  return clock
}
