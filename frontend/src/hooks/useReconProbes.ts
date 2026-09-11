import { useCallback, useEffect, useRef, useState } from 'react'
import type { BlockchainClient } from '../blockchain'
import { isConfidentialNetworkQuiet } from '../blockchain/contract/confidential'
import type { TxLifecycleStatus } from '../blockchain/types'
import { sendReconProbe } from '../game/gameService'
import type { Address, Hash, ReconProbeRecord } from '../game/types'
import { getStorageItem, setStorageItem } from '../utils/storage'
import { useBlockchainClient } from './useBlockchainClient'
import { useWallet } from './useWallet'

/**
 * Blocks to skip after a quiet-network miss before asking the confidential
 * network again.
 *
 * One — which suppresses the immediate re-pull and lets the next block do
 * it, rather than sitting out four.
 *
 * The miss being backed off from is now almost always ingestion lag
 * measured in seconds: the hint is granted by the send transaction, so
 * there is no second transaction for the confidential network to notice
 * and nothing left to wait for except the coprocessor catching up.
 * `withPatience` already spends an escalating backoff inside a single
 * attempt, and a pull in flight is shared rather than duplicated, so the
 * extra blocks bought nothing but a screen sitting still on top of an
 * answer that was probably already there.
 */
const QUIET_NETWORK_BACKOFF_BLOCKS = 1

export interface UseReconProbesResult {
  status: TxLifecycleStatus
  error: string | null
  /**
   * The transaction round trip, and only that.
   *
   * True from the press until `sendProbe` has landed or failed — the wallet
   * prompt and the mining, not the wait for the answer afterwards. It is
   * what the Send control has to be gated on, because until the transaction
   * lands nothing on this screen knows a probe was sent: `lastProbeBlock`
   * is still the previous one on chain and there is no reading yet, so the
   * protocol's own eight-block rule cannot see it either. A second press in
   * that window buys a signature on a transaction that will revert.
   *
   * Deliberately narrower than `status === 'pending'`, which also covers a
   * probe whose answer is still ripening in the confidential network. That
   * one must *not* block the next probe — see `CommandCenter`.
   */
  sending: boolean
  /**
   * Every probe this wallet has sent on this attack, oldest first — what
   * the fog is built from, since the picture is the *fusion* of all of them
   * rather than the latest answer alone (ТЗ §1.3).
   */
  results: ReconProbeRecord[]
  /**
   * True only for a probe sent from this screen. A reload or a wallet
   * switch rehydrates stored readings with this false, so the fog lands
   * immediately instead of replaying a scan wave for intelligence that
   * arrived minutes ago.
   */
  live: boolean
  /**
   * Probes this wallet has paid for that have not yet produced a reading —
   * the ones still in flight. Counted so the remaining badge can drop the
   * moment Send is pressed, rather than waiting for the hint to land.
   */
  pendingCount: number
  /** Sends one probe over the whole working area. No target, by construction. */
  /**
   * `aimDegrees` is where the player pointed this one — null for the
   * opening sweep, which is the only probe nobody can aim (ТЗ §4).
   */
  send: (attackId: string, probeId: string, aimDegrees?: number | null) => Promise<ReconProbeRecord | null>
}

/**
 * Where one player's reconnaissance is remembered (ТЗ §1.3).
 *
 * Scoped to the wallet *and* the attack, both in the key. Probe answers are
 * private to whoever paid for them, and an attack is the whole lifetime of
 * a set of them — so nothing another wallet can read, and nothing that
 * survives into the next operation.
 *
 * The `v2` is the shape break: probes used to answer about a sector, and a
 * stored answer from the old model would fuse into nonsense.
 */
function reconStorageKey(lobbyId: Hash, attackId: string, address: Address): string {
  return `recon:v2:${lobbyId}:${attackId}:${address.toLowerCase()}`
}

function loadResults(lobbyId: Hash | null, attackId: string | null, address: Address | null): ReconProbeRecord[] {
  if (!lobbyId || !attackId || !address) return []
  return getStorageItem<ReconProbeRecord[]>(reconStorageKey(lobbyId, attackId, address)) ?? []
}

function saveResults(lobbyId: Hash, attackId: string, address: Address, results: ReconProbeRecord[]): void {
  setStorageItem(reconStorageKey(lobbyId, attackId, address), results)
}

function mergeResults(current: ReconProbeRecord[], extra: ReconProbeRecord[]): ReconProbeRecord[] {
  const seen = new Set(current.map((probe) => probe.id))
  const next = [...current]
  for (const probe of extra) {
    if (seen.has(probe.id)) continue
    seen.add(probe.id)
    next.push(probe)
  }
  return next
}

function supportsPendingProbes(
  client: BlockchainClient,
): client is BlockchainClient & {
  resolvePendingProbes: (lobbyId: Hash, attackId: string, from: Address) => Promise<ReconProbeRecord[]>
  countPendingProbes: (lobbyId: Hash, attackId: string, from: Address) => number
} {
  return (
    typeof (client as Partial<{ resolvePendingProbes: unknown }>).resolvePendingProbes === 'function' &&
    typeof (client as Partial<{ countPendingProbes: unknown }>).countPendingProbes === 'function'
  )
}

/**
 * Wraps `sendReconProbe` with the transaction lifecycle the UI renders
 * (spec §44), and keeps the accumulated intelligence across a reload
 * (ТЗ §1.3).
 *
 * The answers are stored locally rather than re-read from the chain because
 * they are not chain-readable: a probe's answer is delivered once, as the
 * private computation's output on the player's own transaction, and there
 * is no read that hands a participant their past probes back. Storing them
 * client-side keeps the intelligence exactly where it already was — with
 * the one player who bought it — which is also why the key is scoped to
 * their address.
 */
export function useReconProbes(
  lobbyId: Hash | null,
  attackId: string | null,
  options: { recoverPending?: boolean } = {},
): UseReconProbesResult {
  const recoverPending = options.recoverPending ?? true
  const client = useBlockchainClient()
  const { address } = useWallet()
  const [status, setStatus] = useState<TxLifecycleStatus>('idle')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<ReconProbeRecord[]>(() => loadResults(lobbyId, attackId, address))
  const [live, setLive] = useState(false)
  const awaitingRef = useRef(false)
  /** After a decrypt failure, stop hammering the wallet / Inco on every block. */
  const haltPullRef = useRef(false)
  /** Skip this many block ticks after a quiet-network miss before asking Inco again. */
  const backoffRef = useRef(0)

  // Rehydrate when the identity of the readout changes — a reload, a new
  // attack, or a wallet switch all have to land on that wallet's own
  // intelligence rather than on whatever was last in state.
  //
  // `client` is deliberately not a dependency. A new client object (the
  // provider swapping the instance, a signer attaching) used to re-run
  // this effect mid-send, which cleared `live` and `awaitingRef` and left
  // the map with a static cloud: the probe was in flight, but the sweep
  // that should have shown it never started.
  useEffect(() => {
    setLive(false)
    awaitingRef.current = false
    haltPullRef.current = false
    backoffRef.current = 0
    setError(null)
    setResults(loadResults(lobbyId, attackId, address))
  }, [lobbyId, attackId, address])

  useEffect(() => {
    if (!recoverPending || !lobbyId || !attackId || !address || !supportsPendingProbes(client)) {
      if (!awaitingRef.current) setStatus('idle')
      return
    }

    let cancelled = false
    let pulling = false
    let queued = false
    const pendingCount = client.countPendingProbes(lobbyId, attackId, address)
    if (!awaitingRef.current) setStatus(pendingCount > 0 ? 'pending' : 'idle')

    const pull = () => {
      if (haltPullRef.current) return
      if (backoffRef.current > 0) {
        backoffRef.current -= 1
        if (backoffRef.current > 0) return
      }
      if (pulling) {
        queued = true
        return
      }
      pulling = true
      void client
        .resolvePendingProbes(lobbyId, attackId, address)
        .then(
          (opened) => {
            if (cancelled) return
            setError(null)
            if (opened.length === 0) return
            const next = mergeResults(loadResults(lobbyId, attackId, address), opened)
            saveResults(lobbyId, attackId, address, next)
            setResults(next)
            if (awaitingRef.current) {
              awaitingRef.current = false
              setLive(true)
            }
            setStatus('confirmed')
          },
          (err) => {
            if (cancelled) return
            queued = false
            setError(err instanceof Error ? err.message : String(err))
            // The probe is on chain; Inco just has not answered yet. Keep
            // the sweep going and ask again in a few blocks — freezing the
            // pull here is how a paid result sat unopened until reload.
            if (isConfidentialNetworkQuiet(err)) {
              backoffRef.current = QUIET_NETWORK_BACKOFF_BLOCKS
              setStatus('pending')
              return
            }
            awaitingRef.current = false
            haltPullRef.current = true
            setStatus('failed')
          },
        )
        .finally(() => {
          pulling = false
          if (queued && !cancelled && !haltPullRef.current && backoffRef.current === 0) {
            queued = false
            pull()
          }
        })
    }
    pull()
    const unsubscribe = client.subscribeToBlocks(() => {
      if (!cancelled && !haltPullRef.current) pull()
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [lobbyId, attackId, address, client, recoverPending])

  const send = useCallback(
    async (nextAttackId: string, probeId: string, aimDegrees: number | null = null) => {
      if (!address || !lobbyId) {
        setStatus('failed')
        setError('Sign in before sending a Recon Probe.')
        return null
      }
      setStatus('preparing')
      setSending(true)
      setError(null)
      awaitingRef.current = true
      haltPullRef.current = false
      backoffRef.current = 0
      /*
       * Marks the reading this press will produce as this screen's, so the
       * sweep plays when it lands. Set here rather than only on the
       * decrypt because the hint can also arrive through the pending-probe
       * pull — and a probe the player just paid for has to be the one case
       * that always gets its wave, whichever path delivered it.
       */
      setLive(true)
      try {
        setStatus('pending')
        const { probe } = await sendReconProbe(client, address, {
          lobbyId,
          attackId: nextAttackId,
          probeId,
          aimDegrees,
        })
        if (probe) {
          awaitingRef.current = false
          setStatus('confirmed')
          // Read-modify-write against storage rather than against React
          // state: the write has to happen exactly once per confirmed
          // probe, and a state updater is not a place to put a side effect.
          const next = mergeResults(loadResults(lobbyId, nextAttackId, address), [probe])
          saveResults(lobbyId, nextAttackId, address, next)
          setResults(next)
        }
        // `probe` is null while the hint is still in flight. Status stays
        // `pending` so the button keeps launching; `resolvePendingProbes`
        // opens it once the confidential network has caught up.
        return probe
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        const stillPending =
          supportsPendingProbes(client) && address
            ? client.countPendingProbes(lobbyId, nextAttackId, address)
            : 0
        if (stillPending > 0 && isConfidentialNetworkQuiet(err)) {
          haltPullRef.current = false
          backoffRef.current = 0
          setStatus('pending')
          return null
        }
        awaitingRef.current = false
        setStatus('failed')
        return null
      } finally {
        // The transaction is done, one way or the other. Whether its answer
        // has arrived is `status`'s business, not this flag's.
        setSending(false)
      }
    },
    [client, address, lobbyId],
  )

  const pendingCount = (() => {
    const onChain =
      lobbyId && attackId && address && supportsPendingProbes(client)
        ? client.countPendingProbes(lobbyId, attackId, address)
        : 0
    const inFlight = status === 'preparing' || status === 'pending' ? 1 : 0
    return Math.max(onChain, inFlight)
  })()

  return { status, sending, error, results, live, pendingCount, send }
}
