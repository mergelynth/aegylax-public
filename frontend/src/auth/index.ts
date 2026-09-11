/**
 * The authentication layer's public surface.
 *
 * Import from here, never from `auth/adapters/*` — those exist so the
 * provider can be swapped without the rest of the app noticing.
 */
export { AuthProvider } from './AuthProvider'
export { AuthContext, useAuth } from './AuthContext'
export type { AuthSession, AuthStatus, AuthUser, AuthWallet, AuthWalletKind } from './types'
