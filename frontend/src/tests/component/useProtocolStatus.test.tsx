import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { BlockchainClient } from '../../blockchain'
import { appConfig } from '../../config/env'
import { describeEngine, useProtocolStatus } from '../../hooks/useProtocolStatus'

const probeConfidentialHealth = vi.fn().mockResolvedValue(undefined)

const contractClient = {
  mode: 'contract',
  getBlockNumber: vi.fn().mockResolvedValue(10),
  subscribeToBlocks: vi.fn().mockReturnValue(() => {}),
  probeConfidentialHealth,
} as unknown as BlockchainClient

const emulatorClient = {
  mode: 'emulator',
  getBlockNumber: vi.fn().mockResolvedValue(1),
  subscribeToBlocks: vi.fn().mockReturnValue(() => {}),
  probeConfidentialHealth,
} as unknown as BlockchainClient

let client: BlockchainClient = contractClient

vi.mock('../../hooks/useBlockchainClient', () => ({
  useBlockchainClient: () => client,
}))

/**
 * The two versions the status panel prints.
 *
 * They were one row labelled "Protocol version" carrying the *client build*,
 * sitting directly under the contract address — so a number that ticks on a
 * CSS fix read as the protocol's own. Nothing checked the label, which is
 * how it stayed wrong through a redeploy.
 */
describe('useProtocolStatus — versions', () => {
  it('reports the contract implementation version separately from the build', async () => {
    client = contractClient
    // The test manifest carries no version, and asserting against that would
    // be asserting null twice — the same answer the emulator gives, which
    // would pass whether or not the contract path works at all.
    const original = appConfig.deployment.version
    appConfig.deployment.version = '1.8.0'
    try {
      const { result } = renderHook(() => useProtocolStatus())
      await waitFor(() => expect(result.current.currentBlock).not.toBeNull())

      expect(result.current.contractVersion).toBe('1.8.0')
      // A different string with a different meaning: the client build.
      //
      // Both shapes `resolveProtocolVersion` documents are accepted:
      // `MAJOR.MINOR.count` where the history can be counted, and
      // `MAJOR.MINOR+sha` where it cannot. Pinning the first alone asserted
      // the checkout rather than the hook — it passed on a developer's full
      // clone and failed under `actions/checkout`, which is shallow by
      // default, so the one place it ran was the one place it broke.
      expect(result.current.buildVersion).toMatch(/^\d+\.\d+(\.\d+|\+[0-9a-f]{7,})$/)
      expect(result.current.buildVersion).not.toBe(result.current.contractVersion)
    } finally {
      appConfig.deployment.version = original
    }
  })

  it('has no contract version in the emulator, where there is no contract', async () => {
    client = emulatorClient
    const { result } = renderHook(() => useProtocolStatus())
    await waitFor(() => expect(result.current.currentBlock).not.toBeNull())

    // Null even when a manifest version is present: the emulator has no
    // contract for it to describe.
    const original = appConfig.deployment.version
    appConfig.deployment.version = '1.8.0'
    try {
      expect(result.current.contractVersion).toBeNull()
      // The build still identifies which client is running.
      expect(result.current.buildVersion).toBeTruthy()
    } finally {
      appConfig.deployment.version = original
    }
  })
})

describe('useProtocolStatus — confidential probe', () => {
  it('asks Inco from the header on a contract build, not only during a probe', async () => {
    client = contractClient
    probeConfidentialHealth.mockClear()
    renderHook(() => useProtocolStatus())
    await waitFor(() => expect(probeConfidentialHealth).toHaveBeenCalled())
  })

  it('does not ping a covalidator from the emulator', async () => {
    client = emulatorClient
    probeConfidentialHealth.mockClear()
    renderHook(() => useProtocolStatus())
    await waitFor(() => expect(emulatorClient.getBlockNumber).toHaveBeenCalled())
    expect(probeConfidentialHealth).not.toHaveBeenCalled()
  })
})

/**
 * What the Protocol Status panel calls the confidential layer.
 *
 * This is the one place a player is told whose network holds the round's
 * secrets, and it is assembled from two manifest fields rather than written
 * anywhere — so a provider switch has to change it, and an unrecognised one
 * has to be shown rather than hidden. Pinning it here is the assertion the
 * panel itself would make.
 */
describe('describeEngine', () => {
  const withEngine = (kind: string | null, release: string | null) =>
    ({ deployment: { confidentialEngineKind: kind, confidentialRelease: release } }) as never

  it('names Fhenix CoFHE and the deployment it runs', () => {
    expect(describeEngine(withEngine('fhenix-cofhe', 'TESTNET'))).toBe('Fhenix CoFHE Testnet')
    expect(describeEngine(withEngine('fhenix-cofhe', 'MAINNET'))).toBe('Fhenix CoFHE Mainnet')
  })

  it('still names Inco for a deployment running it', () => {
    expect(describeEngine(withEngine('inco-lightning', 'devnet'))).toBe('Inco Lightning Devnet')
  })

  /*
   * The release is the trust assumption, not the host chain: the contracts
   * are on Base either way, and which network can decrypt an attack is what
   * this row exists to disclose.
   */
  it('says so when the layer provides no confidentiality at all', () => {
    expect(describeEngine(withEngine('mock', null))).toBe('Mock engine (no confidentiality)')
  })

  it('shows an unrecognised kind verbatim rather than blank', () => {
    expect(describeEngine(withEngine('zama-fhevm', 'sepolia'))).toBe('zama-fhevm Sepolia')
  })

  it('is null when there is no deployment to describe', () => {
    expect(describeEngine(withEngine(null, null))).toBeNull()
  })
})
