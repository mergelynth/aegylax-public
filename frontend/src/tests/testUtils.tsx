import { render, type RenderOptions } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { BlockchainClientProvider } from '../app/providers/BlockchainClientProvider'
import { AuthProvider } from '../auth'
import { ProviderThemeProvider } from '../theme'

/**
 * The same stack the app mounts, minus routing. `AuthProvider` resolves to
 * the local identity here — the test ENV configures no provider — so a
 * component that asks who is playing gets the emulator's answer without a
 * network call.
 *
 * The theme provider is included for the same reason: it is what decides
 * whether a component may credit a confidential provider, and the suite runs
 * in emulator mode — where the honest answer is "there isn't one". A test
 * that rendered without it would be asserting against a default no build
 * uses.
 */
function AllProviders({ children }: { children: ReactNode }) {
  return (
    <ProviderThemeProvider>
      <AuthProvider>
        <BlockchainClientProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </BlockchainClientProvider>
      </AuthProvider>
    </ProviderThemeProvider>
  )
}

export function renderWithProviders(ui: ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return render(ui, { wrapper: AllProviders, ...options })
}
