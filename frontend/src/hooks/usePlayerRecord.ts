import { useCallback, useEffect, useRef, useState } from 'react'
import { formatEther } from 'viem'
import { EmulatorBlockchainClient } from '../blockchain/EmulatorBlockchainClient'
import { appConfig } from '../config/env'
import type { Address } from '../game/types'
import { foldPlayerRecord } from './emulatorFold'
import { useBlockchainClient } from './useBlockchainClient'

/**
 * What this wallet has done, from the backend's fold of the protocol's log.
 *
 * The numbers are public — every one of them comes from an event the
 * contract emits in the open (ТЗ §11) — but they are spread over months of
 * blocks, and paging through those from a browser on a panel-open is not a
 * request anybody's RPC would thank us for. `api/indexer/` reads them
 * once and answers here in one call.
 *
 * Nothing confidential can arrive down this route, by construction rather
 * than by care: no event before `AttackRevealed` carries a coordinate, so a
 * record is counts and money. Where a player's probes went and what they
 * saw stays where it has always been — with the wallet that paid for it.
 */

export interface PlayerRecord {
  address: string
  operationsCreated: number
  operationsJoined: number
  operationsLeft: number
  /** Resolved rounds this wallet was still seated in. Rounds nobody played are not among them. */
  roundsPlayed: number
  interceptions: number
  currentStreak: number
  bestStreak: number
  probesBought: number
  probesSent: number
  defensesSubmitted: number
  /**
   * How the last twelve rounds went, oldest first: true where this wallet
   * was named a winner. The counts say how often; this says when.
   */
  recentRounds: boolean[]
  /** Wei, as decimal strings — the amounts outrun `number` long before they outrun a player. */
  stakedWei: string
  wonWei: string
  creatorFeesWei: string
  returnedWei: string
  firstBlock: number | null
  lastBlock: number | null
}

export type PlayerRecordStatus = 'idle' | 'loading' | 'ready' | 'unavailable'

export interface UsePlayerRecordResult {
  status: PlayerRecordStatus
  record: PlayerRecord | null
  /** True while the backend is still walking up from the deployment block. */
  syncing: boolean
  reload: () => void
}

/** Wei to ETH, as a number for display only. */
export function weiToEth(wei: string): number {
  try {
    return Number(formatEther(BigInt(wei)))
  } catch {
    return 0
  }
}

function asWei(value: string): bigint {
  try {
    return BigInt(value)
  } catch {
    return 0n
  }
}

/** Claimed rewards plus author fees — money this wallet took out. */
export function moneyWonWei(record: PlayerRecord): bigint {
  return asWei(record.wonWei) + asWei(record.creatorFeesWei)
}

/**
 * What went in and never came back. A profitable record is not a negative
 * loss: lost bottoms at zero, and winnings sit on the other tile.
 */
export function moneyLostWei(record: PlayerRecord): bigint {
  const out = asWei(record.stakedWei)
  const back = asWei(record.returnedWei) + moneyWonWei(record)
  return out > back ? out - back : 0n
}

/** Whether the wallet has ever done anything the protocol recorded. */
export function hasHistory(record: PlayerRecord | null): boolean {
  return record !== null && record.firstBlock !== null
}

/**
 * How often a played round ended in an interception, or null before there is
 * a round to divide by. A percentage over zero rounds is not 0% — it is a
 * statement about nothing.
 */
export function interceptionRate(record: PlayerRecord): number | null {
  if (record.roundsPlayed === 0) return null
  return record.interceptions / record.roundsPlayed
}

/** How long to wait before asking again while the backfill is still running. */
const SYNC_RETRY_MS = 5_000

export function usePlayerRecord(address: Address | null): UsePlayerRecordResult {
  const client = useBlockchainClient()
  const [status, setStatus] = useState<PlayerRecordStatus>('idle')
  const [record, setRecord] = useState<PlayerRecord | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)

  const reload = useCallback(() => setAttempt((value) => value + 1), [])

  useEffect(() => {
    if (!address) {
      setStatus('idle')
      setRecord(null)
      return
    }

    /*
     * The emulator's history lives in this tab. Fold it locally rather than
     * asking a backend that has never heard of these rooms — otherwise the
     * wallet panel would stay blank for the only mode most people develop in.
     */
    if (client.mode === 'emulator') {
      const emulator = client as EmulatorBlockchainClient
      const refresh = () => {
        const snapshot = emulator.inspect()
        setRecord(foldPlayerRecord(snapshot.lobbies, snapshot.participants, address))
        setSyncing(false)
        setStatus('ready')
      }
      refresh()
      return emulator.subscribeToBlocks(refresh)
    }

    let cancelled = false
    setStatus((current) => (current === 'ready' ? current : 'loading'))

    fetch(`${appConfig.apiBaseUrl}/api/players/${address}`)
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as
          | { ok: true; record: PlayerRecord; syncing: boolean }
          | { ok: false; error: string }
          | null
        if (cancelled) return

        /*
         * A build served without the backend behind it, or a deployment that
         * keeps no records, is not an error worth printing on a wallet panel:
         * the section simply is not there. `unavailable` is what says so.
         */
        if (!response.ok || !body || body.ok !== true) {
          setStatus('unavailable')
          setRecord(null)
          return
        }

        setRecord(body.record)
        setSyncing(body.syncing)
        setStatus('ready')

        // The first boot of a backend reads months of blocks, and a wallet
        // that opens the panel during it would otherwise see an empty record
        // and no reason to look again.
        if (body.syncing) {
          retry.current = setTimeout(() => setAttempt((value) => value + 1), SYNC_RETRY_MS)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('unavailable')
          setRecord(null)
        }
      })

    return () => {
      cancelled = true
      if (retry.current) clearTimeout(retry.current)
      retry.current = null
    }
  }, [address, attempt, client])

  return { status, record, syncing, reload }
}
