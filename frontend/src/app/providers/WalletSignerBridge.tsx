import { useEffect } from 'react'
import { createWalletClient, custom } from 'viem'
import { useAuth } from '../../auth'
import { appConfig } from '../../config/env'
import { resolveActiveChain } from '../../config/networks'
import { useBlockchainClient } from '../../hooks/useBlockchainClient'

/**
 * Hands the signed-in player's wallet to the blockchain client (ТЗ §10).
 *
 * Reads and writes come from opposite places and this is the seam between
 * them: the client can read the chain from the moment the page loads,
 * through its own RPC and with no wallet at all, but every write needs a
 * signer that only exists once a player has signed in. Attaching it here —
 * rather than constructing the client with one — is what lets somebody open
 * an operation, watch an attack and read a reveal before deciding to play.
 *
 * It knows nothing about *how* they signed in. All it wants from the
 * session is an address and an EIP-1193 provider, which is exactly what
 * `AuthWallet` promises whoever the provider is.
 */
export function WalletSignerBridge() {
  const client = useBlockchainClient()
  const { wallet } = useAuth()

  useEffect(() => {
    const target = client as { setWalletClient?: (walletClient: unknown) => void }
    if (typeof target.setWalletClient !== 'function') return

    let cancelled = false

    async function attach() {
      // A simulated (emulator) wallet has no provider to hand over, and
      // that absence is the signal: there is nothing to sign with.
      if (!wallet?.getEthereumProvider) {
        target.setWalletClient?.(null)
        return
      }

      const chain = resolveActiveChain(appConfig)

      /*
       * Put the wallet on the chain this build talks to before signing
       * anything. For a managed wallet this is silent, which is the whole
       * promise of the integration; an external wallet prompts. A refusal
       * is not fatal here — the write that follows will fail loudly on the
       * chain mismatch rather than being sent to the wrong network.
       */
      if (chain && wallet.switchChain && wallet.chainId !== null && wallet.chainId !== chain.id) {
        try {
          await wallet.switchChain(chain.id)
        } catch {
          console.warn(`[aegylax/auth] Wallet stayed on chain ${wallet.chainId}; ${chain.name} was requested.`)
        }
      }
      if (cancelled) return

      const provider = await wallet.getEthereumProvider()
      if (cancelled) return

      target.setWalletClient?.(
        createWalletClient({
          account: wallet.address,
          chain: chain ?? undefined,
          transport: custom(provider),
        }),
      )
    }

    attach().catch(() => {
      // A wallet that will not hand over a provider simply leaves the client
      // read-only; writes then fail with "connect a wallet", which is the
      // truthful message.
      target.setWalletClient?.(null)
    })

    return () => {
      cancelled = true
    }
  }, [client, wallet])

  return null
}
