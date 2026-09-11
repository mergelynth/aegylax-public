import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseAuthConfig } from '../../config/auth'

function buildEnv(overrides: Partial<Record<string, string>> = {}): ImportMetaEnv {
  return { ...overrides } as unknown as ImportMetaEnv
}

afterEach(() => {
  vi.restoreAllMocks()
})

function silenceWarnings() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {})
}

describe('parseAuthConfig: which provider mounts', () => {
  it('stays local in emulator mode, so the game runs with nothing configured (ТЗ §8)', () => {
    expect(parseAuthConfig(buildEnv({}), 'emulator').provider).toBe('local')
    expect(parseAuthConfig(buildEnv({ VITE_PRIVY_APP_ID: 'app-id' }), 'emulator').provider).toBe('local')
  })

  it('picks the hosted provider when contract mode has credentials for it', () => {
    expect(parseAuthConfig(buildEnv({ VITE_PRIVY_APP_ID: 'app-id' }), 'contract').provider).toBe('privy')
  })

  it('warns rather than half-mounting when contract mode has no provider', () => {
    const warn = silenceWarnings()
    expect(parseAuthConfig(buildEnv({}), 'contract').provider).toBe('local')
    expect(warn).toHaveBeenCalled()
  })

  it('honours an explicit provider, so the real sign-in can be exercised on the emulator', () => {
    const config = parseAuthConfig(buildEnv({ VITE_AUTH_PROVIDER: 'privy', VITE_PRIVY_APP_ID: 'app-id' }), 'emulator')
    expect(config.provider).toBe('privy')
  })

  it('falls back to local when a provider is named without an app id', () => {
    const warn = silenceWarnings()
    const config = parseAuthConfig(buildEnv({ VITE_AUTH_PROVIDER: 'privy' }), 'contract')
    expect(config.provider).toBe('local')
    expect(warn).toHaveBeenCalled()
  })

  it('lets local be forced even where a provider is fully configured', () => {
    const warn = silenceWarnings()
    const config = parseAuthConfig(
      buildEnv({ VITE_AUTH_PROVIDER: 'local', VITE_PRIVY_APP_ID: 'app-id' }),
      'contract',
    )
    expect(config.provider).toBe('local')
    expect(warn).toHaveBeenCalled()
  })
})

describe('parseAuthConfig: login methods', () => {
  it('defaults to the simplest ways in, plus a wallet for players who have one', () => {
    expect(parseAuthConfig(buildEnv({}), 'emulator').loginMethods).toEqual(['email', 'google', 'wallet'])
  })

  it('reads a comma-separated list, trimming and de-duplicating', () => {
    const config = parseAuthConfig(buildEnv({ VITE_AUTH_LOGIN_METHODS: ' email , WALLET,email ' }), 'emulator')
    expect(config.loginMethods).toEqual(['email', 'wallet'])
  })

  it('drops an unknown method with a warning instead of failing the sign-in screen', () => {
    const warn = silenceWarnings()
    const config = parseAuthConfig(buildEnv({ VITE_AUTH_LOGIN_METHODS: 'email,myspace' }), 'emulator')
    expect(config.loginMethods).toEqual(['email'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('myspace'))
  })

  it('falls back to the defaults when every configured method is unknown', () => {
    silenceWarnings()
    const config = parseAuthConfig(buildEnv({ VITE_AUTH_LOGIN_METHODS: 'myspace' }), 'emulator')
    expect(config.loginMethods).toEqual(['email', 'google', 'wallet'])
  })
})

describe('parseAuthConfig: managed wallets and presentation', () => {
  it('mints a managed wallet for players who arrive without one, by default', () => {
    expect(parseAuthConfig(buildEnv({}), 'emulator').managedWallets).toBe('users-without-wallets')
  })

  it('reads the other policies, and ignores a value it does not recognise', () => {
    expect(parseAuthConfig(buildEnv({ VITE_AUTH_MANAGED_WALLETS: 'all-users' }), 'emulator').managedWallets).toBe(
      'all-users',
    )
    expect(parseAuthConfig(buildEnv({ VITE_AUTH_MANAGED_WALLETS: 'off' }), 'emulator').managedWallets).toBe('off')
    expect(parseAuthConfig(buildEnv({ VITE_AUTH_MANAGED_WALLETS: 'nonsense' }), 'emulator').managedWallets).toBe(
      'users-without-wallets',
    )
  })

  it('leaves every unset presentation value null, so the dashboard keeps deciding', () => {
    const config = parseAuthConfig(buildEnv({}), 'emulator')
    expect(config.appearance).toEqual({
      theme: null,
      accentColor: null,
      logoUrl: null,
      showWalletLoginFirst: false,
    })
    expect(config.legal).toEqual({ termsUrl: null, privacyUrl: null })
    expect(config.walletConnectProjectId).toBeNull()
  })

  it('reads presentation and legal values when they are set', () => {
    const config = parseAuthConfig(
      buildEnv({
        VITE_AUTH_THEME: 'dark',
        VITE_AUTH_ACCENT_COLOR: '#5b8cff',
        VITE_AUTH_LOGO_URL: 'https://example.test/logo.svg',
        VITE_AUTH_SHOW_WALLET_LOGIN_FIRST: 'true',
        VITE_AUTH_TERMS_URL: 'https://example.test/terms',
        VITE_AUTH_PRIVACY_URL: 'https://example.test/privacy',
        VITE_WALLETCONNECT_PROJECT_ID: 'wc-project',
      }),
      'emulator',
    )
    expect(config.appearance.theme).toBe('dark')
    expect(config.appearance.accentColor).toBe('#5b8cff')
    expect(config.appearance.showWalletLoginFirst).toBe(true)
    expect(config.legal.termsUrl).toBe('https://example.test/terms')
    expect(config.walletConnectProjectId).toBe('wc-project')
  })

  it('holds no credential of its own — everything comes from ENV', () => {
    const config = parseAuthConfig(buildEnv({}), 'emulator')
    expect(config.appId).toBeNull()
    expect(config.clientId).toBeNull()
  })
})
