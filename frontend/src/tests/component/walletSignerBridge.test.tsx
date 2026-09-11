import { render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { EIP1193Provider } from 'viem'
import { baseSepolia } from 'viem/chains'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BlockchainClientContext } from '../../app/providers/BlockchainClientProvider'
import { WalletSignerBridge } from '../../app/providers/WalletSignerBridge'
import { AuthContext } from '../../auth'
import type { AuthSession, AuthWallet } from '../../auth/types'
import type { BlockchainClient } from '../../blockchain/types'
import type { Address } from '../../game/types'

const chain = vi.hoisted(() => ({ active: null as unknown }))

vi.mock('../../config/networks', async () => {
  const actual = await vi.importActual<typeof import('../../config/networks')>('../../config/networks')
  return { ...actual, resolveActiveChain: () => chain.active }
})

const ADDRESS = '0x00000000000000000000000000000000000000aa' as Address

function session(wallet: AuthWallet | null): AuthSession {
  return {
    provider: 'privy',
    status: wallet ? 'authenticated' : 'unauthenticated',
    isReady: true,
    isAuthenticated: Boolean(wallet),
    user: null,
    wallet,
    loginMethods: ['email'],
    error: null,
    login: async () => {},
    logout: async () => {},
  }
}

/** A client that can take a signer, standing in for the contract client. */
function signableClient() {
  const setWalletClient = vi.fn()
  return { client: { setWalletClient } as unknown as BlockchainClient, setWalletClient }
}

function renderBridge(wallet: AuthWallet | null, client: BlockchainClient): ReactNode {
  render(
    <AuthContext.Provider value={session(wallet)}>
      <BlockchainClientContext.Provider value={client}>
        <WalletSignerBridge />
      </BlockchainClientContext.Provider>
    </AuthContext.Provider>,
  )
  return null
}

/** The least an EIP-1193 provider has to be for viem to build a client on it. */
function stubProvider(): EIP1193Provider {
  return { request: vi.fn(async () => null), on: vi.fn(), removeListener: vi.fn() } as unknown as EIP1193Provider
}

function managedWallet(overrides: Partial<AuthWallet> = {}): AuthWallet {
  return {
    address: ADDRESS,
    chainId: baseSepolia.id,
    kind: 'managed',
    getEthereumProvider: vi.fn(async () => stubProvider()),
    switchChain: vi.fn(async () => {}),
    ...overrides,
  }
}

beforeEach(() => {
  chain.active = baseSepolia
})

describe('<WalletSignerBridge /> (ТЗ §10)', () => {
  it('attaches a signer built from whatever provider the session hands over', async () => {
    const { client, setWalletClient } = signableClient()
    renderBridge(managedWallet(), client)

    await waitFor(() => expect(setWalletClient).toHaveBeenCalled())
    const attached = setWalletClient.mock.calls.at(-1)?.[0]
    expect(attached).toMatchObject({ account: expect.objectContaining({ address: ADDRESS }) })
  })

  it('leaves the client read-only while nobody is signed in', async () => {
    const { client, setWalletClient } = signableClient()
    renderBridge(null, client)

    await waitFor(() => expect(setWalletClient).toHaveBeenCalledWith(null))
  })

  it('leaves the client read-only for a wallet that cannot sign, rather than stubbing one', async () => {
    const { client, setWalletClient } = signableClient()
    renderBridge({ address: ADDRESS, chainId: null, kind: 'simulated' }, client)

    await waitFor(() => expect(setWalletClient).toHaveBeenCalledWith(null))
  })

  it('moves the wallet onto this build’s chain before anything is signed', async () => {
    const { client, setWalletClient } = signableClient()
    const wallet = managedWallet({ chainId: 1 })
    renderBridge(wallet, client)

    await waitFor(() => expect(wallet.switchChain).toHaveBeenCalledWith(baseSepolia.id))
    await waitFor(() => expect(setWalletClient).toHaveBeenCalledWith(expect.anything()))
  })

  it('does not disturb a wallet already on the right chain', async () => {
    const { client, setWalletClient } = signableClient()
    const wallet = managedWallet()
    renderBridge(wallet, client)

    await waitFor(() => expect(setWalletClient).toHaveBeenCalled())
    expect(wallet.switchChain).not.toHaveBeenCalled()
  })

  it('still attaches when the wallet refuses to switch, so the failure surfaces on the write', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, setWalletClient } = signableClient()
    const wallet = managedWallet({
      chainId: 1,
      switchChain: vi.fn(async () => {
        throw new Error('user rejected')
      }),
    })
    renderBridge(wallet, client)

    await waitFor(() => expect(setWalletClient).toHaveBeenCalledWith(expect.anything()))
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('falls back to read-only when the wallet will not hand over a provider', async () => {
    const { client, setWalletClient } = signableClient()
    renderBridge(
      managedWallet({
        getEthereumProvider: vi.fn(async (): Promise<EIP1193Provider> => {
          throw new Error('no provider')
        }),
      }),
      client,
    )

    await waitFor(() => expect(setWalletClient).toHaveBeenCalledWith(null))
  })

  it('does nothing at all to a client that takes no signer (the emulator)', async () => {
    const client = {} as BlockchainClient
    expect(() => renderBridge(managedWallet(), client)).not.toThrow()
  })
})
