import { useEffect, useState } from 'react'
import type { Address } from '../game/types'
import { useBlockchainClient } from './useBlockchainClient'

/**
 * What this address holds, in ETH — push-driven (spec §3).
 *
 * Re-read on every new head through the existing block subscription, never
 * on a timer of its own: a balance changes when the chain changes, and
 * polling it independently is both wasted work and a second clock to
 * disagree with.
 *
 * `null` means *unknown*, and callers must not read it as zero. It is the
 * value before the first read lands, and it is also the honest answer in
 * contract mode with no RPC configured — a screen that treats it as an
 * empty wallet will refuse somebody with money in front of them.
 */
export function useWalletBalance(address: Address | null): number | null {
  const client = useBlockchainClient()
  const [balance, setBalance] = useState<number | null>(null)

  useEffect(() => {
    if (!address) {
      setBalance(null)
      return
    }
    let cancelled = false

    const refresh = () => {
      client.getBalance(address).then(
        (value) => {
          if (!cancelled) setBalance(value)
        },
        () => {
          // Contract mode with no RPC configured yet — leave the balance
          // unknown rather than throwing or inventing a zero.
        },
      )
    }

    refresh()
    const unsubscribe = client.subscribeToBlocks(refresh)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [client, address])

  return balance
}
