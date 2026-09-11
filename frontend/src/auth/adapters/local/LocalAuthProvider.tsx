import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { AuthLoginMethod } from '../../../config/auth'
import type { Address } from '../../../game/types'
import { getStorageItem, setStorageItem } from '../../../utils/storage'
import { AuthContext } from '../../AuthContext'
import type { AuthSession, AuthStatus, AuthWallet } from '../../types'

const ADDRESS_KEY = 'emulator-wallet-address'
const CONNECTED_KEY = 'emulator-wallet-connected'

/**
 * The no-provider adapter: emulator mode's identity (ТЗ §8).
 *
 * It mints one random address per browser so create/join flows work with
 * nothing installed and no account anywhere. What it stores is *only* that
 * address and a connected flag — there is no key to store, because nothing
 * here signs anything: the in-memory chain accepts an address as the actor
 * and settles the rest itself.
 */
function randomAddress(): Address {
  const bytes = new Uint8Array(20)
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}` as Address
}

function getOrCreateLocalAddress(): Address {
  const existing = getStorageItem<Address>(ADDRESS_KEY)
  if (existing) return existing
  const address = randomAddress()
  setStorageItem(ADDRESS_KEY, address)
  return address
}

/**
 * What this adapter can honestly offer. It has no email, no social and no
 * real wallet — the connect control reads this to decide whether it invites
 * a player to "Sign in" or to connect a wallet.
 */
const LOCAL_LOGIN_METHODS: readonly AuthLoginMethod[] = ['wallet']

export function LocalAuthProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<Address | null>(null)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    setAddress(getOrCreateLocalAddress())
    setIsAuthenticated(getStorageItem<boolean>(CONNECTED_KEY) ?? false)
    setIsReady(true)
  }, [])

  const login = useCallback(async () => {
    setAddress(getOrCreateLocalAddress())
    setIsAuthenticated(true)
    setStorageItem(CONNECTED_KEY, true)
  }, [])

  const logout = useCallback(async () => {
    setIsAuthenticated(false)
    setStorageItem(CONNECTED_KEY, false)
  }, [])

  /*
   * The wallet appears only once the player has connected, exactly as it
   * does for a hosted provider.
   *
   * The address itself is minted earlier — this adapter generates one per
   * browser and there is nobody to authenticate against — but handing it to
   * the app before the session exists is what made "connect" decorative:
   * every write guards on having an address, so an address that arrives
   * ahead of the session lets an unconnected visitor create, join, probe and
   * defend. Emulator or not, connecting has to mean something, so the two
   * adapters now expose the same shape and the difference between them stays
   * where it belongs — in whether anything can actually be signed.
   */
  const wallet = useMemo<AuthWallet | null>(
    () =>
      address && isAuthenticated
        ? // No `getEthereumProvider` and no `switchChain` on purpose: this
          // wallet cannot sign, and pretending otherwise would let a
          // contract-mode bug hide behind a stub that always "works".
          { address, chainId: null, kind: 'simulated' }
        : null,
    [address, isAuthenticated],
  )

  const session = useMemo<AuthSession>(() => {
    const status: AuthStatus = !isReady ? 'initializing' : isAuthenticated ? 'authenticated' : 'unauthenticated'
    return {
      provider: 'local',
      status,
      isReady,
      isAuthenticated: isAuthenticated && Boolean(wallet),
      user: wallet ? { id: wallet.address, loginMethod: 'wallet', label: null } : null,
      wallet,
      loginMethods: LOCAL_LOGIN_METHODS,
      error: null,
      login,
      logout,
    }
  }, [isAuthenticated, isReady, login, logout, wallet])

  return <AuthContext.Provider value={session}>{children}</AuthContext.Provider>
}
