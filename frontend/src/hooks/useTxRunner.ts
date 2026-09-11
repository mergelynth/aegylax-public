import { useCallback, useState } from 'react'
import type { TxLifecycleStatus } from '../blockchain/types'

export interface UseTxRunnerResult<TArgs extends unknown[], TResult> {
  status: TxLifecycleStatus
  error: string | null
  run: (...args: TArgs) => Promise<TResult | null>
}

/** Shared idle->preparing->pending->confirmed|failed wrapper (spec §44) around one write action. */
export function useTxRunner<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
): UseTxRunnerResult<TArgs, TResult> {
  const [status, setStatus] = useState<TxLifecycleStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(
    async (...args: TArgs) => {
      setStatus('preparing')
      setError(null)
      try {
        setStatus('pending')
        const result = await action(...args)
        setStatus('confirmed')
        return result
      } catch (err) {
        setStatus('failed')
        setError(err instanceof Error ? err.message : String(err))
        return null
      }
    },
    [action],
  )

  return { status, error, run }
}
