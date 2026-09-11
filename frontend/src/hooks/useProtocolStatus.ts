import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  describePrivacyExecutorBlock,
  describeRpcError,
  getProtocolHealthSnapshot,
  PRIVACY_HEARTBEAT_MS,
  privacyLayerDelayReason,
  reportChainBlock,
  reportPrivacyDelay,
  reportRpcFailure,
  RPC_HEARTBEAT_MS,
  subscribeProtocolHealth,
} from '../blockchain/protocolHealth'
import type { BlockchainClient } from '../blockchain'
import { isPageVisible, subscribeToPageVisibility } from '../app/pageVisibility'
import { PROTOCOL_VERSION } from '../config/gameConfig'
import { appConfig, type ProtocolLimits } from '../config/env'
import { resolveActiveChain } from '../config/networks'
import { getConfiguredContractAddress } from '../contracts/addresses'
import { useBlockchainClient } from './useBlockchainClient'

export type ProtocolStatusLevel = 'operational' | 'degraded' | 'offline'

export interface ProtocolStatus {
  level: ProtocolStatusLevel
  network: string
  /**
   * Whether the money on this network is play money.
   *
   * Read from the chain definition rather than asserted, so a build pointed
   * at a real network stops saying it. It is deliberately not "are we in
   * demo mode": the disclosure has to follow the chain the wallet is
   * actually signing against, and that is a runtime fact.
   */
  isTestnet: boolean
  contractAddress: string | null
  currentBlock: number | null
  /**
   * The shipped client build — `MAJOR.MINOR.<commits on HEAD>`, resolved at
   * build time. It says which site you are looking at, and nothing about
   * the protocol.
   */
  buildVersion: string
  /**
   * `AegylaxGame.version()`, as recorded in the deployment manifest.
   *
   * A constant in the bytecode, so it names the *implementation* rather than
   * the instance: redeploying the same source to a new proxy reports the
   * same version, and only an upgrade with changed source moves it. Null in
   * emulator mode, where there is no contract to have one.
   */
  contractVersion: string | null
  /** Why the chain Current block row is yellow, if it is. Hover copy. */
  rpcDelayReason: string | null
  /**
   * Why the privacy-protocol row is yellow, if it is.
   * Indexer lag is shown on the privacy Current block row instead, so this
   * is null when that row already explains the same delay.
   */
  privacyDelayReason: string | null
  /**
   * The host-chain height the privacy executor has ingested, shown as
   * Current block under its address so it can be read against the chain
   * head above.
   *
   * A confidential network does not generally expose a synced-height
   * getter, so this is the network head minus any lag it reported. Yellow
   * only when that gap is already a status, not a few seconds of ACL
   * settling.
   */
  privacyExecutorBlock: number | null
  privacyExecutorBlockHint: string | null
  privacyExecutorBlockWarn: boolean
  /**
   * Who provides confidentiality, and the contract *they* run (ТЗ §1, §3).
   *
   * Worth publishing beside the game contract rather than leaving implicit:
   * the single property the protocol rests on is that nobody can read an
   * attack before it lands, and that property is not `AegylaxGame`'s. A
   * player who wants to check the claim needs to know whose network holds
   * it and where to look them up.
   *
   * `privacyExecutorAddress` is the confidential network's own contract —
   * Inco's executor, CoFHE's TaskManager — recorded in the deployment
   * manifest. Deliberately not this protocol's own adapter, which is a
   * contract in this repository and told a player nothing they could verify
   * about the privacy claim. `privacyLayerUrl` comes from ENV, so a build
   * wired to a different confidential network links to that one instead.
   */
  privacyLayer: string | null
  privacyExecutorAddress: string | null
  privacyLayerUrl: string | null
  /**
   * The protocol's own take, per seat — including the creator's, who holds
   * the first one. The only thing the treasury is fed by.
   */
  protocolJoinFee: number
  /**
   * Every rule the protocol owns, as it is actually deployed.
   *
   * The panel used to publish exactly two economic figures and stop, which
   * made it a summary of the two a player happened to pay rather than a
   * statement of the rules. These are the values a creator *cannot* set and
   * a player cannot negotiate — probe pricing, attack cadence, and the ranges
   * a creator picks inside — and they come from the same resolved config
   * every other layer validates against, which in contract mode is the
   * deployment manifest rather than this build's ENV.
   *
   * The panel renders a chosen subset rather than all of it: world geometry
   * (interception radius, sector span, grid) is protocol-owned but is not a
   * *term*, and listing it made the panel a constants dump. See
   * `ProtocolStatus`.
   */
  limits: ProtocolLimits
}

/**
 * Reads protocol health off the existing `BlockchainClient` subscriptions,
 * plus a light RPC heartbeat and a readiness ping at the confidential
 * network. Gameplay still reports its failures into the same lane; the ping is what
 * makes that lane move on Home and Docs, not only on an Operation.
 * Nothing here aggregates other players — there is no backend for that —
 * it is this tab's view.
 */
export function useProtocolStatus(): ProtocolStatus {
  const client = useBlockchainClient()
  const health = useSyncExternalStore(subscribeProtocolHealth, getProtocolHealthSnapshot, getProtocolHealthSnapshot)
  const [currentBlock, setCurrentBlock] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const isContract = client.mode === 'contract'

    const unsubscribeBlocks = client.subscribeToBlocks((blockNumber) => {
      if (isContract) reportChainBlock()
      setCurrentBlock(blockNumber)
    })

    const applyBlock = (blockNumber: number, fillOnly = false) => {
      if (cancelled) return
      if (isContract) reportChainBlock()
      if (fillOnly) {
        setCurrentBlock((current) => current ?? blockNumber)
        return
      }
      setCurrentBlock(blockNumber)
    }

    /**
     * One read on mount, then pushes take over. Without it the block row
     * would read "—" until the next block happens to arrive, which for the
     * emulator is a full block interval (it has no emit-on-subscribe).
     * Fill-only so a push that already landed is not overwritten by a
     * slightly staler `eth_blockNumber`.
     */
    client.getBlockNumber().then((blockNumber) => applyBlock(blockNumber, true), (error) => {
      if (isContract) reportRpcFailure(describeRpcError(error))
    })

    /**
     * The block subscription can go silent while `eth_blockNumber` still
     * works, or the other way around. A slow heartbeat is what turns either
     * into yellow rather than a shield that stays green on a dead socket.
     */
    const beatRpc = () => {
      client.getBlockNumber().then(applyBlock, (error) => {
        reportRpcFailure(describeRpcError(error))
      })
    }

    const heartbeat = isContract
      ? window.setInterval(() => {
          if (!isPageVisible()) return
          beatRpc()
        }, RPC_HEARTBEAT_MS)
      : null

    /**
     * The confidential network is not on the block feed. Without this, the
     * privacy row only moved when a probe or reveal actually talked to it —
     * which is an Operation, so Home stayed green through a global outage.
     */
    const probePrivacy = () => {
      if (cancelled || !supportsPrivacyProbe(client)) return
      void client.probeConfidentialHealth().catch(() => {
        reportPrivacyDelay()
      })
    }
    if (isContract) probePrivacy()
    const privacyBeat = isContract
      ? window.setInterval(() => {
          if (!isPageVisible()) return
          probePrivacy()
        }, PRIVACY_HEARTBEAT_MS)
      : null

    /**
     * Neither beat runs while the window is behind another one, and both
     * run again the moment it comes back.
     *
     * Between them that is an `eth_blockNumber` every 12s and a readiness
     * ping at the confidential network every 20s — each a request, a JSON
     * parse and a store notification — kept up indefinitely by a tab nobody
     * has looked at since this morning, in every browser it is open in.
     *
     * Skipping the beat rather than clearing the interval on purpose: a
     * timer whose callback returns immediately costs nothing worth the
     * bookkeeping, and leaving the intervals in place keeps the teardown
     * below the only place they are cleared.
     *
     * Firing both on the way back is what keeps this from trading heat for
     * a lie. The shield is a *current* reading, and resuming into a
     * 12-second wait would show the state the protocol was in when the
     * window was hidden — green on an outage that started an hour ago.
     */
    const releaseVisibility = isContract
      ? subscribeToPageVisibility((visible) => {
          if (!visible || cancelled) return
          beatRpc()
          probePrivacy()
        })
      : null

    return () => {
      cancelled = true
      unsubscribeBlocks()
      releaseVisibility?.()
      if (heartbeat !== null) window.clearInterval(heartbeat)
      if (privacyBeat !== null) window.clearInterval(privacyBeat)
    }
  }, [client])

  const chain = resolveActiveChain(appConfig)
  const isEmulator = client.mode === 'emulator'
  const contractAddress = isEmulator ? null : getConfiguredContractAddress()

  /*
   * The RPC the client actually uses, which is ENV *or* the one recorded in
   * the deployment manifest — and leaving `VITE_RPC_URL` empty so the
   * manifest supplies it is the documented normal case. Reading only ENV
   * here reported "Not configured" and an offline protocol on precisely the
   * configuration the app ships with, while every read on the page was
   * succeeding against the manifest's endpoint.
   */
  const rpcUrl = appConfig.rpcUrl ?? appConfig.deployment.rpcUrl
  const rpcConfigured = isEmulator || Boolean(rpcUrl)

  const network = isEmulator
    ? 'Local emulator'
    : (chain?.name ?? (appConfig.chainId ? `Chain ${appConfig.chainId}` : 'Not configured'))

  const rpcDelayed = !isEmulator && health.rpc === 'delayed'
  const privacyDelayed = !isEmulator && health.privacy === 'delayed'

  const level: ProtocolStatusLevel = isEmulator
    ? 'operational'
    : !rpcConfigured || !contractAddress
      ? 'offline'
      : currentBlock === null || rpcDelayed || privacyDelayed
        ? 'degraded'
        : 'operational'

  return {
    level,
    network,
    // `=== true` on purpose: viem marks its testnets and says nothing about
    // the rest, and a manifest-derived chain carries no such flag. Absent is
    // "not known to be a testnet", which must not print as one.
    isTestnet: !isEmulator && chain?.testnet === true,
    contractAddress,
    currentBlock,
    buildVersion: PROTOCOL_VERSION,
    contractVersion: isEmulator ? null : appConfig.deployment.version,
    rpcDelayReason: rpcDelayed ? health.rpcReason : null,
    privacyDelayReason: privacyLayerDelayReason(
      privacyDelayed ? health.privacyReason : null,
      health.privacyLagSeconds,
    ),
    ...describePrivacyExecutorBlock({
      emulator: isEmulator,
      lagSeconds: health.privacyLagSeconds,
      chainBlock: currentBlock,
      blockTimeMs: appConfig.blockTimeMs,
      delayReason: privacyDelayed ? health.privacyReason : null,
    }),
    // The emulator provides no confidentiality worth naming — it seals
    // locally with a key the browser holds — so it says so rather than
    // borrowing the manifest's answer.
    privacyLayer: isEmulator ? 'Local emulator (no privacy layer)' : describeEngine(appConfig),
    privacyExecutorAddress: isEmulator ? null : appConfig.deployment.confidentialExecutor,
    // No link on the emulator's row: there is no privacy layer behind
    // it, and pointing at one would be advertising a property it lacks.
    privacyLayerUrl: isEmulator ? null : appConfig.links.privacyLayerUrl,
    protocolJoinFee: appConfig.protocol.joinFee,
    limits: appConfig.protocol,
  }
}

/**
 * Confidential stacks by the `kind` a deployment manifest records.
 *
 * The manifest's kind is a machine identifier chosen at deploy time
 * (`CONFIDENTIAL_ENGINE`), and `createGateway` refuses to run against one it
 * does not recognise — so an unknown kind here is shown verbatim rather than
 * hidden: a player looking at a build wired to something this table has not
 * heard of should see its name, not a blank.
 */
const ENGINE_NAMES: Record<string, string> = {
  'fhenix-cofhe': 'Fhenix CoFHE',
  'inco-lightning': 'Inco Lightning',
  mock: 'Mock engine (no confidentiality)',
}

export function describeEngine(config: typeof appConfig): string | null {
  const kind = config.deployment.confidentialEngineKind
  if (!kind) return null
  const name = ENGINE_NAMES[kind] ?? kind

  /*
   * The release — Inco's `pepper`, CoFHE's `environment` — rather than the
   * host chain.
   *
   * These are two different networks and only one of them is the trust
   * assumption. The contracts live on Base Sepolia; the covalidator quorum
   * that can decrypt an attack is the confidential network's, and which one
   * that is comes from the release the engine was wired to. Labelling this
   * row with the host chain would name the wrong network for exactly the
   * fact the row exists to disclose.
   */
  const release = config.deployment.confidentialRelease
  return release ? `${name} ${capitalize(release)}` : name
}

/**
 * Title-cases a release name for the panel.
 *
 * The rest of the word is lowered, not left alone: providers spell these
 * differently — Inco's peppers are lowercase (`devnet`), CoFHE's
 * environments are uppercase (`TESTNET`) — and only upcasing the first
 * letter put "Fhenix CoFHE TESTNET" in a row that reads as prose next to
 * "Inco Lightning Devnet".
 */
function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
}

function supportsPrivacyProbe(
  client: BlockchainClient,
): client is BlockchainClient & { probeConfidentialHealth: () => Promise<void> } {
  return typeof client.probeConfidentialHealth === 'function'
}
