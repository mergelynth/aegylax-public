import { useCallback, useEffect, useState } from 'react'
import { appConfig } from '../config/env'
import type { Address } from '../game/types'
import { getStorageItem, setStorageItem } from '../utils/storage'

/**
 * The demo faucet, from the browser's side.
 *
 * Every decision that matters — how much, how often, whether at all — is the
 * backend's (`api/faucet/`), because the faucet wallet's key is there and
 * cannot be here. This hook asks and reports; it does not know the amount
 * until the answer comes back, and it must not: a client-side copy of the
 * drip size would be a second source of truth for a number set on the
 * server, and it would go stale in a bundle nobody rebuilds to change it.
 */

/**
 * How empty a wallet has to be for the panel to offer a top-up.
 *
 * A flat figure, and deliberately not derived from anything. It used to be
 * twice the protocol's `minEntryFee`, which tracked `setParams` for free but
 * answered the wrong question: that number is what one *seat* costs, so a
 * wallet a hair above it was refused a top-up and then could not afford the
 * second thing it tried. The line people actually want is "does this wallet
 * have a session's worth of ETH in it", which no on-chain parameter states.
 *
 * It matches what the faucet currently pays out, and that is a coincidence
 * worth keeping rather than a coupling worth building: `FAUCET_DRIP_ETH`
 * lives on the server and is not readable from here — see the note at the
 * top of this file — so this cannot follow it and must not pretend to. If
 * the drip changes, this is a separate decision to make.
 */
export const FAUCET_OFFER_BELOW_ETH = 0.02

export function faucetThresholdEth(): number {
  return FAUCET_OFFER_BELOW_ETH
}

/**
 * Whether a wallet is low enough to be offered a top-up.
 *
 * `null` while the balance is still loading — not "yes". An offer that
 * flashes on every page load before the first balance arrives is an alarm
 * about nothing, and it would be on screen for most of the time anybody
 * spends looking at the header.
 */
export function isWalletLow(balanceEth: number | null): boolean {
  if (balanceEth === null) return false
  return balanceEth < faucetThresholdEth()
}

/**
 * Whether the wallet holds nothing at all — the one state the header marks.
 *
 * A stricter line than `isWalletLow`, and the two are deliberately not the
 * same number. The panel offers a top-up to anybody who is short, because
 * there the offer is one control among several and costs a reader nothing.
 * The header has no room to be advisory: a drip beside the balance is the
 * app interrupting to say something is wrong, and the only balance that is
 * unambiguously wrong is zero, where nothing at all can be done until it
 * changes. Anything above that is a judgement call, and the header is not
 * the place to make it out loud.
 *
 * `null` is not zero: a balance that has not arrived is unknown, not empty.
 */
export function isWalletEmpty(balanceEth: number | null): boolean {
  return balanceEth === 0
}

export type FaucetStatus = 'idle' | 'sending' | 'sent' | 'failed'

export interface UseFaucetResult {
  status: FaucetStatus
  error: string | null
  /** How much arrived, as the server reported it. Null until a drip lands. */
  amountEth: string | null
  txHash: string | null
  /** When this wallet may ask again — set by a drip landing and by a refusal for asking too soon. */
  retryAtMs: number | null
  request: (address: Address) => Promise<void>
  reset: () => void
}

/**
 * Where a wallet's cooldown is remembered between page loads.
 *
 * This is a cache of the server's last answer, not a second authority. The
 * faucet still decides every request on its own — it reads the chain, which
 * no browser can lie to — so a cleared, edited or absent entry costs nothing
 * but a refusal the page then displays. What it buys is the state after a
 * reload: without it the control comes back live on a wallet that was topped
 * up ninety seconds ago, and the only way to find out is to press it and be
 * told no.
 *
 * Keyed by address, because one browser signs into more than one wallet and
 * a cooldown belongs to the wallet that spent it, not to the machine.
 */
function cooldownKey(address: Address): string {
  return `faucet.retryAt.${address.toLowerCase()}`
}

function rememberedCooldown(address: Address | null): number | null {
  if (address === null) return null
  const at = getStorageItem<number>(cooldownKey(address))
  // A wait that has already elapsed is not a wait. Reading it as one would
  // leave a dead clock on the button until something else cleared it.
  if (typeof at !== 'number' || at <= Date.now()) return null
  return at
}

/**
 * @param address The wallet the panel is showing, so a cooldown recorded
 *   before a reload can be restored. Null while there is nobody signed in.
 */
export function useFaucet(address: Address | null = null): UseFaucetResult {
  const [status, setStatus] = useState<FaucetStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [amountEth, setAmountEth] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)
  const [retryAtMs, setRetryAtMs] = useState<number | null>(() => rememberedCooldown(address))

  // And again whenever the wallet changes under the same mounted panel —
  // signing out of one account and into another must not carry the first
  // one's cooldown onto the second one's button.
  useEffect(() => {
    setRetryAtMs(rememberedCooldown(address))
  }, [address])

  const reset = useCallback(() => {
    setStatus('idle')
    setError(null)
    setAmountEth(null)
    setTxHash(null)
    setRetryAtMs(null)
  }, [])

  const request = useCallback(async (address: Address) => {
    setStatus('sending')
    setError(null)
    setRetryAtMs(null)

    /** Both answers can date the next request; both are worth keeping. */
    const recordCooldown = (at: number) => {
      setRetryAtMs(at)
      setStorageItem(cooldownKey(address), at)
    }

    try {
      const response = await fetch(`${appConfig.apiBaseUrl}/api/faucet`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address }),
      })

      /*
       * Read the body before the status, because the interesting refusals
       * carry one. A 429 means the cooldown, and `retryAtMs` is the only
       * thing that lets the panel say *when* instead of just "no".
       */
      const body = (await response.json().catch(() => null)) as
        | { ok: true; txHash: string; amountEth: string; retryAtMs?: number }
        | { ok: false; error: string; retryAtMs?: number }
        | null

      if (!response.ok || !body || body.ok !== true) {
        setStatus('failed')
        setError(body && body.ok === false ? body.error : 'The faucet did not answer. Try again in a minute.')
        if (body && body.ok === false && typeof body.retryAtMs === 'number') recordCooldown(body.retryAtMs)
        return
      }

      setStatus('sent')
      setAmountEth(body.amountEth)
      setTxHash(body.txHash)
      /*
       * A landed drip dates its own cooldown, so the control can count down
       * to the next one instead of going quiet. Optional on the way in: an
       * older server answers a success without it, and a faucet that works
       * but cannot say when it will work again is still a working faucet.
       */
      if (typeof body.retryAtMs === 'number') recordCooldown(body.retryAtMs)
    } catch {
      // A network error, an offline tab, or a build served without the
      // function behind it — none of which the player can act on beyond
      // trying again.
      setStatus('failed')
      setError('Could not reach the faucet. Check your connection and try again.')
    }
  }, [])

  return { status, error, amountEth, txHash, retryAtMs, request, reset }
}

/** "in 3 hours" / "in 12 minutes" — how long until this wallet may ask again. */
export function describeRetryWait(retryAtMs: number, nowMs: number = Date.now()): string {
  const remaining = Math.max(0, retryAtMs - nowMs)
  const hours = Math.floor(remaining / 3_600_000)
  if (hours >= 1) return `in ${hours} hour${hours === 1 ? '' : 's'}`
  const minutes = Math.ceil(remaining / 60_000)
  if (minutes >= 1) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`
  return 'in a moment'
}
