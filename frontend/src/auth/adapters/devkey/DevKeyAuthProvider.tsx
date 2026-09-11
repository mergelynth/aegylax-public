import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPublicClient, createWalletClient, http, type EIP1193Provider } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { AuthLoginMethod } from '../../../config/auth'
import { appConfig } from '../../../config/env'
import { resolveActiveChain } from '../../../config/networks'
import type { Address } from '../../../game/types'
import { AuthContext } from '../../AuthContext'
import type { AuthSession, AuthStatus, AuthWallet } from '../../types'

/**
 * A signing wallet from a private key — **development only** (ТЗ §8).
 *
 * The emulator's `local` adapter mints an address that cannot sign, and the
 * hosted adapter needs a human at an email or a social login. Neither can
 * drive the real contract from an automated browser, which leaves the whole
 * of contract mode — probe, defend, reveal, claim — testable only by hand.
 * This is the missing third case: a real key, signing real testnet
 * transactions, behind a session shaped exactly like the other two.
 *
 * Three guards, and they are the reason this is safe to keep in the tree:
 *
 *   - it only exists in a dev server. `import.meta.env.DEV` is false in
 *     `vite build`, and this adapter refuses to mount there — a production
 *     bundle cannot reach it whatever the environment says;
 *   - it is opt-in. `VITE_AUTH_PROVIDER=devkey` and nothing else selects it;
 *   - the key is never this app's to keep. It is read once at mount and
 *     lives in a closure; nothing writes it to storage.
 *
 * The key comes from `VITE_DEV_PRIVATE_KEY`, and — so that one dev server
 * can be two different players at once, which is what testing an operation
 * with two defenders actually needs — from `?devkey=0x…` on the URL, which
 * wins. Both are testnet keys by definition: a key that reaches a browser
 * tab is a key that has been disclosed.
 */

const DEV_LOGIN_METHODS: readonly AuthLoginMethod[] = ['wallet']

/** The key this tab plays as: the URL's if it carries one, else ENV's. */
function readPrivateKey(): `0x${string}` | null {
  const fromUrl =
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('devkey')
  const raw = (fromUrl ?? import.meta.env.VITE_DEV_PRIVATE_KEY ?? '').trim()
  return /^0x[0-9a-fA-F]{64}$/.test(raw) ? (raw as `0x${string}`) : null
}

/**
 * Whether this adapter has anything to offer — asked by `AuthProvider`
 * *before* it mounts anything.
 *
 * Without the check, `VITE_AUTH_PROVIDER=devkey` left in a shell takes the
 * app over whether or not a key came with it, and what it leaves behind is
 * the worst possible failure: a session that reports wallet-only sign-in, so
 * the header stops saying "Sign in", and a `login()` with no account to
 * authenticate, so pressing it does nothing at all and says nothing about
 * why. A dev-only adapter with no key is not a provider — it is an empty
 * one, and the configured provider should run instead.
 */
let warnedAboutMissingKey = false

export function hasDevKey(): boolean {
  if (readPrivateKey() !== null) return true
  // Once, not once per render: `AuthProvider` asks this on every render, and
  // the fact being reported does not change between them.
  if (!warnedAboutMissingKey) {
    warnedAboutMissingKey = true
    console.warn(
      '[aegylax/auth] VITE_AUTH_PROVIDER=devkey but no valid key — ignoring it and using the ' +
        'configured provider. Set VITE_DEV_PRIVATE_KEY, or open the page with ?devkey=0x…',
    )
  }
  return false
}

/**
 * An EIP-1193 provider over a local key.
 *
 * `WalletSignerBridge` asks every wallet for one of these and wraps it in
 * viem's `custom` transport, so a wallet that speaks this needs no special
 * case anywhere above `auth/`. Reads and anything unrecognised go to the
 * RPC unchanged; only the four methods that need the key are answered here.
 */
function createLocalKeyProvider(privateKey: `0x${string}`): EIP1193Provider {
  const account = privateKeyToAccount(privateKey)
  const chain = resolveActiveChain(appConfig) ?? undefined
  const rpcUrl = appConfig.rpcUrl ?? appConfig.deployment.rpcUrl ?? undefined
  const transport = http(rpcUrl)

  const publicClient = createPublicClient({ chain, transport })
  const walletClient = createWalletClient({ account, chain, transport })

  const request = async ({ method, params }: { method: string; params?: unknown }) => {
    const args = (params ?? []) as unknown[]

    switch (method) {
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return [account.address]

      case 'eth_chainId':
        return `0x${(chain?.id ?? 0).toString(16)}`

      // Signing in a real wallet is a prompt; here it is a key, which is the
      // entire difference between this adapter and the hosted one.
      case 'personal_sign':
        return account.signMessage({ message: { raw: args[0] as `0x${string}` } })

      case 'eth_signTypedData_v4': {
        const payload = args[1]
        return account.signTypedData(typeof payload === 'string' ? JSON.parse(payload) : payload)
      }

      case 'eth_sendTransaction': {
        const tx = args[0] as {
          to?: Address
          data?: `0x${string}`
          value?: `0x${string}`
          gas?: `0x${string}`
        }
        return walletClient.sendTransaction({
          account,
          chain,
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
          gas: tx.gas ? BigInt(tx.gas) : undefined,
        })
      }

      // There is one chain and no wallet UI to move: answering rather than
      // throwing keeps the bridge's switch-before-signing step quiet.
      case 'wallet_switchEthereumChain':
        return null

      default:
        return publicClient.request({ method, params } as never)
    }
  }

  return { request } as unknown as EIP1193Provider
}

export function DevKeyAuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isReady, setIsReady] = useState(false)

  const key = useMemo(readPrivateKey, [])
  const account = useMemo(() => (key ? privateKeyToAccount(key) : null), [key])
  const provider = useMemo(() => (key ? createLocalKeyProvider(key) : null), [key])

  useEffect(() => {
    console.warn(
      '[aegylax/auth] Dev key wallet active — signing locally with a disclosed key. ' +
        'This adapter exists for automated testing and never ships in a build.',
    )
    // Signing in is instant, but the session still passes through
    // "initializing" so the app sees the same shape every provider gives it.
    setIsReady(true)
  }, [key])

  const login = useCallback(async () => {
    // `AuthProvider` will not mount this adapter without a key, so this is
    // the unreachable branch — and it throws rather than returning quietly
    // because a sign-in control that resolves without signing anybody in is
    // exactly the dead button this adapter used to produce.
    if (!account) throw new Error('No dev key configured — set VITE_DEV_PRIVATE_KEY or open the page with ?devkey=0x…')
    setIsAuthenticated(true)
  }, [account])

  const logout = useCallback(async () => {
    setIsAuthenticated(false)
  }, [])

  const wallet = useMemo<AuthWallet | null>(
    () =>
      account && provider && isAuthenticated
        ? {
            address: account.address as Address,
            chainId: appConfig.chainId,
            // Not `managed`: nobody is holding this key on the player's
            // behalf. It is an external wallet that happens to live in the
            // page, and calling it anything else would understate that.
            kind: 'external',
            getEthereumProvider: async () => provider,
            switchChain: async () => {},
          }
        : null,
    [account, provider, isAuthenticated],
  )

  const session = useMemo<AuthSession>(() => {
    const status: AuthStatus = !isReady ? 'initializing' : isAuthenticated ? 'authenticated' : 'unauthenticated'
    return {
      // The app's own vocabulary has two providers; this one is a local
      // identity that can sign, so it reports as `local` rather than adding
      // a third value every consumer would have to learn.
      provider: 'local',
      status,
      isReady,
      isAuthenticated: isAuthenticated && Boolean(wallet),
      user: wallet ? { id: wallet.address, loginMethod: 'wallet', label: null } : null,
      wallet,
      loginMethods: DEV_LOGIN_METHODS,
      error: null,
      login,
      logout,
    }
  }, [isAuthenticated, isReady, login, logout, wallet])

  return <AuthContext.Provider value={session}>{children}</AuthContext.Provider>
}
