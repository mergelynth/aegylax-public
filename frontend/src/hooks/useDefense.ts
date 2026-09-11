import { useCallback, useState } from 'react'
import type { TxLifecycleStatus } from '../blockchain/types'
import { submitDefenseAttempt } from '../game/gameService'
import type { DefenseAttempt, DefensePoint, Hash } from '../game/types'
import { useBlockchainClient } from './useBlockchainClient'
import { useWallet } from './useWallet'

export interface UseDefenseResult {
  status: TxLifecycleStatus
  error: string | null
  lastAttempt: DefenseAttempt | null
  submit: (attackId: string, defensePoint: DefensePoint) => Promise<DefenseAttempt | null>
  /**
   * Encrypt a point the player has placed but not sent. It never fails
   * visibly and never touches the wallet. See
   * `ContractBlockchainClient.prepareDefense`.
   */
  prepare: (defensePoint: DefensePoint) => void
  /**
   * Whether that encryption is running right now.
   *
   * The work was already happening; nothing said so. Sealing a point takes
   * five to nine seconds, and a player who places a marker and presses
   * Defend straight away waits all of it inside `submitDefense` — the same
   * silence the pre-sealing was built to remove, just moved. Naming the
   * state is what turns "the button is broken" into "it is nearly ready",
   * and it is the only thing that tells somebody the wait is shorter if
   * they let the marker settle.
   */
  arming: boolean
}

/**
 * Wraps `submitDefenseAttempt` with the transaction lifecycle the UI
 * renders (spec §44).
 *
 * It deliberately does not resolve anything. Whether a Defense Point
 * intercepted is decided by the protocol when the attack lands, arrives
 * with the reveal, and is read back from the operation's outcome — a
 * client-side answer here would be a second source of truth for the one
 * number the whole game turns on.
 */
export function useDefense(lobbyId: Hash | null): UseDefenseResult {
  const client = useBlockchainClient()
  const { address } = useWallet()
  const [status, setStatus] = useState<TxLifecycleStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [lastAttempt, setLastAttempt] = useState<DefenseAttempt | null>(null)
  const [arming, setArming] = useState(false)

  const submit = useCallback(
    async (attackId: string, defensePoint: DefensePoint) => {
      if (!address || !lobbyId) {
        setStatus('failed')
        setError('Sign in before submitting Defense.')
        return null
      }
      setStatus('preparing')
      setError(null)
      try {
        setStatus('pending')
        const { attempt } = await submitDefenseAttempt(client, address, { lobbyId, attackId, defensePoint })
        setStatus('confirmed')
        setLastAttempt(attempt)
        return attempt
      } catch (err) {
        setStatus('failed')
        setError(err instanceof Error ? err.message : String(err))
        return null
      }
    },
    [client, address, lobbyId],
  )

  const prepare = useCallback(
    (defensePoint: DefensePoint) => {
      if (!address || !lobbyId) return
      const pending = client.prepareDefense?.(address, defensePoint)
      if (!pending) return
      setArming(true)
      // `prepareDefense` swallows its own failures, so this only ever
      // settles — and either way the point is no longer being sealed.
      void pending.finally(() => setArming(false))
    },
    [client, address, lobbyId],
  )

  return { status, error, lastAttempt, submit, prepare, arming }
}
