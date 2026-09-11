import { afterEach, describe, expect, it, vi } from 'vitest'
import { base, baseSepolia } from 'viem/chains'
import { toPrivyClientConfig } from '../../auth/adapters/privy/privyClientConfig'
import { parseAuthConfig, type AuthConfig } from '../../config/auth'

/**
 * This suite guards the one place a vendor's shape enters the app. It is
 * the checklist a replacement provider has to satisfy: the configured
 * login methods reach the modal, a managed wallet is minted for players
 * who arrive without one, the wallet is confined to the chains this build
 * knows, and nothing the operator left unset is invented here.
 */

function authConfig(env: Partial<Record<string, string>> = {}): AuthConfig {
  return parseAuthConfig({ VITE_PRIVY_APP_ID: 'app-id', ...env } as unknown as ImportMetaEnv, 'contract')
}

const chains = { supported: [base, baseSepolia], active: baseSepolia }

afterEach(() => {
  vi.restoreAllMocks()
})

describe('toPrivyClientConfig', () => {
  it('passes the configured login methods through unchanged', () => {
    const config = toPrivyClientConfig(authConfig({ VITE_AUTH_LOGIN_METHODS: 'email,google,wallet' }), chains)
    expect(config.loginMethods).toEqual(['email', 'google', 'wallet'])
  })

  it('asks for a managed wallet for players who sign in without one', () => {
    const config = toPrivyClientConfig(authConfig({ VITE_AUTH_MANAGED_WALLETS: 'users-without-wallets' }), chains)
    expect(config.embeddedWallets?.ethereum?.createOnLogin).toBe('users-without-wallets')
  })

  it('can be told not to mint wallets at all', () => {
    const config = toPrivyClientConfig(authConfig({ VITE_AUTH_MANAGED_WALLETS: 'off' }), chains)
    expect(config.embeddedWallets?.ethereum?.createOnLogin).toBe('off')
  })

  /**
   * A round costs several transactions — a probe, a defense, and the two the
   * keeper sends by itself — so a confirmation sheet in front of each one
   * buried the game in modals, including for actions the player never
   * pressed. Pinned because it is a deliberate trade of a real protection,
   * and it must not be turned back on by accident.
   *
   * It reaches managed wallets only. Somebody who connected their own wallet
   * still gets that wallet's own confirmation, which nothing here can change.
   */
  it('signs without a confirmation sheet on wallets the provider manages', () => {
    const config = toPrivyClientConfig(authConfig(), chains)
    expect(config.embeddedWallets?.showWalletUIs).toBe(false)
  })

  it('confines the wallet to the chains this build supports, defaulting to the active one', () => {
    const config = toPrivyClientConfig(authConfig(), chains)
    expect(config.supportedChains).toEqual([base, baseSepolia])
    expect(config.defaultChain).toBe(baseSepolia)
  })

  it('omits the default chain when no network is configured yet', () => {
    const config = toPrivyClientConfig(authConfig(), { supported: [base], active: null })
    expect(config).not.toHaveProperty('defaultChain')
  })

  it('maps appearance and legal settings', () => {
    const config = toPrivyClientConfig(
      authConfig({
        VITE_AUTH_THEME: 'dark',
        VITE_AUTH_ACCENT_COLOR: '#5b8cff',
        VITE_AUTH_LOGO_URL: 'https://example.test/logo.svg',
        VITE_AUTH_SHOW_WALLET_LOGIN_FIRST: 'true',
        VITE_AUTH_TERMS_URL: 'https://example.test/terms',
      }),
      chains,
    )
    expect(config.appearance?.theme).toBe('dark')
    expect(config.appearance?.accentColor).toBe('#5b8cff')
    expect(config.appearance?.logo).toBe('https://example.test/logo.svg')
    expect(config.appearance?.showWalletLoginFirst).toBe(true)
    expect(config.legal?.termsAndConditionsUrl).toBe('https://example.test/terms')
  })

  it('invents nothing an operator left unset, so dashboard settings keep winning', () => {
    const config = toPrivyClientConfig(authConfig(), chains)
    expect(config.appearance).toEqual({ showWalletLoginFirst: false })
    expect(config).not.toHaveProperty('legal')
    expect(config).not.toHaveProperty('walletConnectCloudProjectId')
  })

  it('drops a theme it cannot honour instead of passing junk to the modal', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const config = toPrivyClientConfig(authConfig({ VITE_AUTH_THEME: 'aubergine' }), chains)
    expect(config.appearance?.theme).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })

  it('accepts a hex theme colour', () => {
    const config = toPrivyClientConfig(authConfig({ VITE_AUTH_THEME: '#13152F' }), chains)
    expect(config.appearance?.theme).toBe('#13152F')
  })
})
