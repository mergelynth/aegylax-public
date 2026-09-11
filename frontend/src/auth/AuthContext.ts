import { createContext, useContext } from 'react'
import type { AuthSession } from './types'

export const AuthContext = createContext<AuthSession | null>(null)

/**
 * The app's only door into authentication.
 *
 * Everything above `auth/` — hooks, pages, the signer bridge — reads the
 * session from here, so swapping the provider underneath is invisible to
 * all of them.
 */
export function useAuth(): AuthSession {
  const session = useContext(AuthContext)
  if (!session) {
    throw new Error('useAuth must be used within <AuthProvider>')
  }
  return session
}
