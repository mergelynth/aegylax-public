import type { ReactNode } from 'react'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '../../auth'
import { ProviderThemeProvider } from '../../theme'
import { BlockchainClientProvider } from './BlockchainClientProvider'
import { WalletSignerBridge } from './WalletSignerBridge'

/**
 * Composes the app's providers.
 *
 * Authentication wraps everything because the blockchain client's signer
 * comes from it, but which provider that is — a hosted wallet service or
 * emulator mode's local identity — is decided inside `AuthProvider` from
 * ENV. This file names no vendor and needs no branch.
 *
 * The theme is outermost of all, for the same reason and one more: it paints
 * `:root`, so it has to be in place before anything renders — including the
 * sign-in screen, which is the first thing an unauthenticated visitor sees
 * and would otherwise flash the default palette. Which confidential
 * provider's theme that is comes from the deployment manifest, so this file
 * names no vendor here either.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ProviderThemeProvider>
      <AuthProvider>
        <BlockchainClientProvider>
          {/*
           * The signer bridge lives inside both: it needs the session's
           * wallet and the client to give it to. It renders nothing, and it
           * is a no-op for a client that cannot take a signer (the emulator)
           * or a session that has no wallet yet.
           */}
          <WalletSignerBridge />
          <BrowserRouter>{children}</BrowserRouter>
        </BlockchainClientProvider>
      </AuthProvider>
    </ProviderThemeProvider>
  )
}
