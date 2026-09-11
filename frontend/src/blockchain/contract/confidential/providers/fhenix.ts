import { encodeAbiParameters, parseAbiParameters, type PublicClient, type WalletClient } from 'viem'
/*
 * Types only. The runtime import stays dynamic (`import('@cofhe/sdk/web')`)
 * because the SDK carries a TFHE WASM module, and a build running against
 * the emulator or a local mock engine should never pay to download it —
 * `import type` is erased, so naming these costs nothing at runtime.
 */
import type { CofheClient } from '@cofhe/sdk'
import type { CofheChain } from '@cofhe/sdk/chains'
import { reportPrivacyDelay, reportPrivacyOk } from '../../../protocolHealth'
import { CofheWorkerLost, createWorkerEncryptor, type CofheEncryptor } from './cofheEncryptor'
import type { Address, Hash } from '../../../../game/types'
import {
  accountAddressOf,
  FREE_RETRIES,
  REVEAL_DELAY_MS,
  REVEAL_RETRIES,
  REVEAL_TIMEOUT_MS,
  withPatience,
  type AttestedValue,
  type ConfidentialGateway,
  type FetchAttestedOptions,
} from '../gateway'

/**
 * Fhenix CoFHE — the browser's half of `FhenixConfidentialEngine`.
 *
 * CoFHE is a coprocessor beside the host chain rather than a chain of its
 * own. The three things this file does are the three the protocol needs off
 * chain, and each has a different trust story:
 *
 *   - **Encrypt.** A Defense Point is encrypted here, proved here, and only
 *     the ciphertext handle ever reaches a transaction. The proof binds the
 *     input to *this wallet*, which is why the engine verifies it against
 *     the player rather than against its own caller (see
 *     `newEncryptedPoint`).
 *   - **Unseal.** A Recon Probe's answer is re-encrypted by the threshold
 *     network under a sealing key only this tab holds, and only for a handle
 *     `grantProbeHint` opened to this wallet. Nobody else can ask for it,
 *     including us.
 *   - **Reveal.** After impact the engine makes the handles globally
 *     decryptable, and the plaintexts come back for anyone who asks — which
 *     is what stops a reveal from depending on the players who lost.
 *
 * Loaded on demand: `@cofhe/sdk` carries a TFHE WASM module, and a build
 * running against the emulator or a local mock engine should never pay for
 * it. The SDK defers the FHE key and CRS download further still — to the
 * first `encryptInputs` — so opening a page costs nothing at all.
 */
export class FhenixGateway implements ConfidentialGateway {
  readonly kind = 'fhenix-cofhe'

  private client: Promise<CofheClient> | null = null
  /** The wallet the live client was connected for. */
  private clientOwner: Address | null = null
  /**
   * Set once ACP creation has failed, after which reads stop asking.
   *
   * A probe that has already been paid for must not be lost to a declined
   * prompt being re-offered on every retry — see `session`.
   */
  private acpUnavailable = false
  /**
   * Set when the SDK could not be initialised for a reason no retry fixes —
   * today, FHE parameters newer than this build can parse.
   *
   * Kept so the health lane can stop claiming the confidential layer is
   * fine. A green shield over a Defend button that cannot work is worse
   * than a yellow one: it tells a player the thing they are about to lose
   * a transaction to is healthy.
   */
  private fatal: string | null = null
  /**
   * An ACP grant already in flight, so two callers share one prompt.
   *
   * A probe now starts its session while the transaction is still being
   * signed — see `ContractBlockchainClient.sendReconProbe` — which puts
   * that grant and the read that needs it in flight together for the first
   * time. Without this they would be two `getOrCreateSelfACP` calls, and a
   * player would be asked to authorise the same read twice.
   */
  private acpJob: Promise<void> | null = null
  /** The account `acpJob` is granting for. */
  private acpJobOwner: Address | null = null
  /**
   * The worker every encryption is supposed to run on.
   *
   * `undefined` until something asks for it, `null` once this environment
   * has been found not to have one — a browser without workers or
   * IndexedDB, the test environment, or a worker that died mid-proof. Null
   * is a slow tab, not a broken one: `encrypt` falls back to doing the work
   * in the tab.
   */
  private offThread: CofheEncryptor | null | undefined = undefined

  constructor(
    private readonly chainId: number,
    private readonly engineAddress: Address,
    private readonly getWalletClient: () => WalletClient | null,
    private readonly publicClient: PublicClient,
    /**
     * Which CoFHE deployment this build talks to — `MAINNET`, `TESTNET`,
     * `LOCAL` or `MOCK`.
     *
     * The analogue of Inco's pepper, and required for the same reason: it
     * selects the coprocessor, the ZK verifier and the threshold network as
     * one set, and a guess is not a fallback but a client quietly asking the
     * wrong network about handles it will never be able to open. Unlike a
     * pepper it is *not* a compile-time choice on the contract side — CoFHE
     * links one TaskManager address everywhere — so the manifest is the only
     * place the two halves have to agree.
     */
    private readonly environment: string,
    /**
     * CoFHE's TaskManager on this chain, read off the engine at deploy time.
     *
     * `fetchAttested` reads published plaintexts straight off it, so a
     * reveal needs no service to be reachable at all once the network has
     * settled. Null falls back to asking the engine for it.
     */
    private readonly taskManager: Address | null,
    /**
     * Explicit CoFHE service URLs, when an operator runs their own.
     *
     * Empty is the normal case: `environment` already names Fhenix's hosted
     * endpoints and the SDK's own chain table fills them in.
     */
    private readonly services: CofheServiceUrls = {},
    /**
     * The app's own HTTPS RPCs, handed to the encryption worker.
     *
     * The worker builds its own viem client — it cannot share this tab's —
     * and without these it would fall back to viem's public endpoint for
     * the chain, which rate-limits independently of everything the app
     * already does to stay off it.
     */
    private readonly hostChainRpcUrls: readonly string[] = [],
  ) {}

  // -------------------------------------------------------------------
  // Encrypt
  // -------------------------------------------------------------------

  /**
   * One packed Defense Point, encrypted and proved for `account`.
   *
   * The blob is the ABI encoding `FhenixConfidentialEngine` decodes —
   * `(uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature)`,
   * CoFHE's own input shape. It travels through `submitDefense` as opaque
   * bytes: the game contract never looks inside it, and neither does
   * anything else in this repository.
   *
   * `euint128` rather than the widest type available, because it is the
   * widest CoFHE *has* — and a packed sector coordinate is nowhere near it.
   */
  async encrypt(value: bigint, account: Address): Promise<`0x${string}`> {
    const offThread = await this.encryptOffThread(value, account)
    if (offThread) return offThread

    const client = await this.connect(account)
    const { Encryptable } = await import('@cofhe/sdk')

    /*
     * `setConsumingContract` is the engine, not the game proxy and not the
     * player.
     *
     * The ZK verifier binds that address into the signature it issues, and
     * whoever later calls `FHE.asEuint*` with the blob is checked against
     * it. In this protocol that caller is `FhenixConfidentialEngine`: a
     * Defense Point travels through `submitDefense` as opaque bytes and the
     * engine hands it to `batchVerifyInputs` itself. Naming the game here
     * would produce a blob the engine cannot use, and naming the player one
     * that nothing can.
     *
     * `setAccount` is the player, and it is the other half of the same
     * check: the proof binds the input to the wallet that will send the
     * transaction, which is why the engine verifies against `player` rather
     * than against its own caller.
     *
     * `execute()` returns the per-input handles followed by one signature
     * over the whole batch. This batch is one item, so the pair destructures
     * — and the ABI shape below is exactly what `newEncryptedPoint` decodes.
     */
    const [ctHash, signature] = await client
      .encryptInputs([Encryptable.uint128(value)])
      .setAccount(account)
      .setChainId(this.chainId)
      .setSecurityZone(SECURITY_ZONE)
      .setConsumingContract(this.engineAddress)
      .execute()
      .catch((error: unknown) => {
        throw this.classify(error, 'encrypt your Defense Point')
      })

    return encodeAbiParameters(parseAbiParameters('uint256, uint8, uint8, bytes'), [
      BigInt(ctHash),
      SECURITY_ZONE,
      FHE_UINT128,
      signature,
    ])
  }

  /**
   * The same encryption, on the worker thread — or `null` when there is no
   * worker to run it on, which leaves the caller on the in-tab path above.
   *
   * A failure here is *not* fatal and is deliberately not classified: the
   * tab retries the same work itself, and only that attempt's error is
   * worth showing a player. What a broken worker must never do is cost
   * somebody their Defense.
   */
  private async encryptOffThread(value: bigint, account: Address): Promise<`0x${string}` | null> {
    const encryptor = this.encryptor()
    if (!encryptor) return null

    try {
      const { ctHash, signature } = await encryptor.encrypt({
        value,
        account,
        // The engine, not the game proxy and not the player — see the long
        // note on `setConsumingContract` in the in-tab path below.
        consumingContract: this.engineAddress,
        securityZone: SECURITY_ZONE,
      })
      reportPrivacyOk()
      return encodeAbiParameters(parseAbiParameters('uint256, uint8, uint8, bytes'), [
        ctHash,
        SECURITY_ZONE,
        FHE_UINT128,
        signature,
      ])
    } catch (error) {
      /*
       * Keep the worker unless the worker is what broke. An encryption that
       * failed on its own — a verifier 500, a network blip — is worth one
       * retry in the tab, and the next Defense Point should still get the
       * fast path rather than inheriting a session-long punishment for it.
       */
      if (error instanceof CofheWorkerLost) this.offThread = null
      return null
    }
  }

  private encryptor(): CofheEncryptor | null {
    if (this.offThread !== undefined) return this.offThread
    /*
     * `cofheChain` throws on a deployment whose endpoints are missing, and
     * that is a real error the in-tab path reports properly. Deciding here
     * that there is no worker leaves it to say so.
     */
    try {
      this.offThread = createWorkerEncryptor(this.cofheChain(), this.hostChainRpcUrls)
    } catch {
      this.offThread = null
    }
    return this.offThread
  }

  /**
   * Boot the encryption worker before anybody defends.
   *
   * It signs nothing and blocks nothing — the SDK import, the TFHE module
   * and the client handshake all happen on the worker's thread — so an
   * operation screen can do this on open. What it cannot do is pre-compute
   * the proof: that is bound to the coordinate, which is why the client
   * also encrypts a staged Defense Point speculatively (see
   * `ContractBlockchainClient.prepareDefense`).
   */
  async warmUpEncrypt(account: Address): Promise<void> {
    const encryptor = this.encryptor()
    if (encryptor) {
      await encryptor.warmUp(account).catch(() => {
        this.offThread = null
      })
      return
    }
    await this.connect(account)
  }

  // -------------------------------------------------------------------
  // Read your own
  // -------------------------------------------------------------------

  /**
   * The probe answer, opened by its owner.
   *
   * An ACP — Access Control Permission, the successor to what CoFHE used to
   * call a permit — is the session credential, and it is what makes a probe
   * one transaction: signed once, it names a sealing key held in this tab,
   * and every read after that is a request rather than a prompt. That matters
   * more than it looks — the coprocessor learns a handle exists by watching
   * the chain, so the first read after a probe routinely comes back "not
   * processed yet", and a per-read signature would re-prompt on every retry.
   *
   * Retrying is therefore free, and the loop is bounded: it waits out
   * ingestion lag, it does not paper over a refusal. A handle this wallet
   * was never granted fails the same way on every attempt.
   */
  async decryptForOwner(handle: Hash, account?: Address): Promise<bigint> {
    const wallet = this.getWalletClient()
    if (!wallet) throw new Error('Sign in to read your reconnaissance results.')
    const owner = account ?? accountAddressOf(wallet)
    if (!owner) throw new Error('Sign in to read your reconnaissance results.')

    const client = await this.connect(owner)
    await this.session(client, owner)
    const { FheTypes } = await import('@cofhe/sdk')

    return withPatience(
      async () =>
        client
          .decryptForView(BigInt(handle), FheTypes.Uint128)
          .setAccount(owner)
          .setChainId(this.chainId)
          // The ACP granted just above. `decryptForView` has no
          // global-allowance mode: a probe answer is readable by its owner
          // and by nobody else, which is the point of it.
          .withACP()
          .execute()
          .catch((error: unknown) => {
            throw this.classify(error, 'open your Recon Probe result')
          }),
      'open your Recon Probe result',
      FREE_RETRIES,
    )
  }

  /**
   * Reuse an ACP this browser already holds. Never asks the wallet.
   *
   * The SDK persists ACPs itself, so opening an operation after a reload
   * finds one already there and costs nothing. Granting from a page-load
   * effect is what this exists to avoid: the signature carries a
   * data-access warning, and popping it because somebody opened a page
   * reads as a scam.
   */
  async warmUp(account: Address): Promise<void> {
    if (this.acpUnavailable) return
    try {
      const client = await this.connect(account)
      client.acp.getActiveACP(this.chainId, account)
    } catch {
      // Nothing to restore. `ensureSession` or the first read will grant.
    }
  }

  /**
   * Grant an ACP if this browser does not already have a live one.
   *
   * Join calls this after the seat is taken; `decryptForOwner` calls
   * `session` itself if a probe arrives first. A decline is swallowed so the
   * join they asked for still succeeds.
   */
  async ensureSession(account: Address): Promise<void> {
    if (this.acpUnavailable) return
    if (!this.getWalletClient()) return
    try {
      const client = await this.connect(account)
      await this.session(client, account)
    } catch {
      // Left for `decryptForOwner` to retry.
    }
  }

  /**
   * Drops the SDK instance a wallet switch invalidated.
   *
   * Deliberately leaves the persisted ACPs alone: they are keyed by
   * account, so a reconnect of the same wallet — Privy restoring, a
   * StrictMode remount, a flicker to `null` — picks the existing one up
   * without a second signature.
   */
  reset(): void {
    this.client = null
    this.clientOwner = null
    this.acpUnavailable = false
    this.acpJob = null
    this.acpJobOwner = null
    // `fatal` deliberately survives: a wallet switch does not change which
    // TFHE this build carries.
  }

  private async session(client: CofheClient, owner: Address): Promise<void> {
    if (client.acp.getActiveACP(this.chainId, owner)) return
    if (this.acpJob && this.acpJobOwner?.toLowerCase() === owner.toLowerCase()) return this.acpJob
    try {
      this.acpJobOwner = owner
      this.acpJob = client.acp.getOrCreateSelfACP(this.chainId, owner).then(() => undefined)
      await this.acpJob
    } catch (error) {
      /*
       * One failed grant stands the path down for this gateway rather than
       * being rediscovered on every read. By the time a read runs, the probe
       * transaction has already been mined and paid for; re-prompting on
       * each of eight retries is how one probe came to ask for a signature
       * eight times before failing anyway.
       */
      this.acpUnavailable = true
      throw error
    } finally {
      // Forgotten either way: a grant that succeeded is now in
      // `getActiveACP`, and one that failed must be retryable.
      this.acpJob = null
      this.acpJobOwner = null
    }
  }

  // -------------------------------------------------------------------
  // Reveal
  // -------------------------------------------------------------------

  /**
   * Plaintexts for handles the contract has publicly unlocked.
   *
   * No wallet is involved, and that is the point: after `unlockRound` these
   * values are meant to be readable by anyone, which is what makes the
   * reveal permissionless.
   *
   * Two routes, tried in that order, and both end in something the engine
   * will accept:
   *
   *   1. **Read it off the chain.** Once the threshold network has published
   *      a decryption, the TaskManager holds it and `verifyDecryption`
   *      checks the claim against that — so the proof is an empty signature
   *      list and the reveal needs no service to be up at all.
   *   2. **Ask the threshold network.** Before it has published, the network
   *      will still hand over the plaintext with a signature over it, and
   *      `verifyDecryption` checks that signature instead. This is the path
   *      that lets a reveal land in the transaction after `unlockRound`
   *      rather than waiting for the network to write.
   *
   * Both are retried, because `unlockRound` has to be *mined* before CoFHE
   * will do either — the coprocessor learns the handles were opened by
   * watching the chain. One transaction cannot contain that round trip,
   * which is why the reveal is two.
   */
  async fetchAttested(handles: Hash[], options: FetchAttestedOptions = {}): Promise<AttestedValue[]> {
    if (handles.length === 0) return []
    const taskManager = await this.taskManagerAddress()

    return withPatience(
      async () => {
        const published = await this.readPublished(taskManager, handles)
        const attested = await Promise.all(
          published.map(async (value, index) =>
            value !== null
              ? ({ value, signatures: [] } satisfies AttestedValue)
              : await this.attestFromThresholdNetwork(handles[index]),
          ),
        )
        return attested
      },
      'fetch the revealed attack data',
      options.attempts ?? REVEAL_RETRIES,
      REVEAL_DELAY_MS,
      options.timeoutMs ?? REVEAL_TIMEOUT_MS,
    )
  }

  /** Decryptions the threshold network has already written to the chain. */
  private async readPublished(taskManager: Address, handles: Hash[]): Promise<(bigint | null)[]> {
    return Promise.all(
      handles.map(async (handle) => {
        try {
          const [value, decrypted] = (await this.publicClient.readContract({
            address: taskManager,
            abi: TASK_MANAGER_ABI,
            functionName: 'getDecryptResultSafe',
            args: [BigInt(handle)],
          })) as [bigint, boolean]
          return decrypted ? value : null
        } catch {
          // An older TaskManager without the getter is not a failed reveal;
          // the threshold network is asked instead.
          return null
        }
      }),
    )
  }

  /**
   * The plaintext plus whatever the network signs it with.
   *
   * The signature is passed through rather than parsed: the contract hands
   * it back to CoFHE's own verifier, so this client has no business knowing
   * the wire format. A response without one is not an error — it still
   * carries the value, and by the time the reveal transaction runs the
   * published-on-chain route has usually caught up.
   */
  private async attestFromThresholdNetwork(handle: Hash): Promise<AttestedValue> {
    const url = this.thresholdNetworkUrl()
    if (!url) throw new Error(`Timed out waiting to fetch the revealed attack data for ${handle}`)

    const response = await fetch(`${url.replace(/\/$/, '')}/decrypt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ct_tempkey: BigInt(handle).toString(16).padStart(64, '0'),
        host_chain_id: this.chainId,
      }),
    })
    if (!response.ok) {
      throw new Error(`Failed to reveal ${handle}: the confidential network answered ${response.status}.`)
    }

    const body = (await response.json()) as ThresholdDecryptResponse
    const value = decodePlaintext(body.decrypted)
    if (value === null) throw new Error(`Failed to decrypt handles: ${handle} is not processed yet.`)
    return { value, signatures: hexSignatures(body) }
  }

  /**
   * Whether the lane is answering, asked without a handle.
   *
   * The header runs this on every page so a CoFHE outage is a yellow shield
   * before anyone sends a probe. `signerAddress` is the ZK verifier's
   * cheapest endpoint and the same host the encrypt path depends on, so an
   * answer here means a Defense Point can actually be sealed.
   */
  async probeHealth(): Promise<void> {
    /*
     * A known-fatal SDK is the answer, and it outranks any ping: the
     * services can all be up and the layer still be unusable by this build.
     */
    if (this.fatal) {
      reportPrivacyDelay(this.fatal)
      return
    }
    const url = this.verifierUrl()
    if (!url) return
    try {
      const response = await fetch(`${url.replace(/\/$/, '')}/signerAddress`, {
        method: 'GET',
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      })
      if (response.ok) reportPrivacyOk()
      else reportPrivacyDelay()
    } catch {
      reportPrivacyDelay()
    }
  }

  // -------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------

  /**
   * The SDK, initialised for one wallet.
   *
   * Re-connected when the account changes, because an ACP is scoped to the
   * wallet that signed it and the SDK holds the active one per account:
   * carrying a stale instance across a switch is how one player's tab ends
   * up asking for another's handles and being refused.
   */
  private async connect(account: Address): Promise<CofheClient> {
    if (this.client && this.clientOwner?.toLowerCase() === account.toLowerCase()) return this.client

    const wallet = this.getWalletClient()
    if (!wallet) throw new Error('Sign in to use the confidential layer.')

    this.clientOwner = account
    this.client = import('@cofhe/sdk/web').then(async ({ createCofheClient, createCofheConfig }) => {
      const client = createCofheClient(createCofheConfig({ supportedChains: [this.cofheChain()] }))
      try {
        await client.connect(this.publicClient, wallet)
      } catch (error) {
        throw this.classify(error, 'reach the confidential layer')
      }
      return client
    })

    /*
     * A failed connect must not be cached as the answer for this account:
     * the promise is rejected, and every later call would get that same
     * rejection back without ever retrying. Clearing it here is what makes
     * a transient failure — an RPC blip during `connect` — recoverable on
     * the next action, while a version skew still stops asking, because
     * `fatal` is what stands that path down rather than the cached promise.
     */
    this.client.catch(() => {
      this.client = null
      this.clientOwner = null
    })

    return this.client
  }

  /**
   * The one chain entry this client talks to, assembled from the manifest.
   *
   * `@cofhe/sdk` takes networks as objects rather than as an environment
   * name, which is a better fit for this codebase than it looks: the
   * deployment already records the environment *and* any self-hosted
   * endpoints, so both halves are read from the manifest and nothing is
   * resolved from a table keyed on a string.
   *
   * The environment mapping has one wrinkle worth stating. The SDK knows
   * `MOCK`, `TESTNET` and `MAINNET` only — `LOCAL` is not one of them, and
   * a self-hosted CoFHE is expressed as `TESTNET` pointed at localhost
   * (which is exactly what the SDK's own `localcofhe` entry does). So
   * `LOCAL` maps to `TESTNET` here and the URLs carry the difference.
   */
  private cofheChain(): CofheChain {
    const services = { ...cofheServiceDefaults(this.environment), ...this.services }
    const missing = (['coFheUrl', 'verifierUrl', 'thresholdNetworkUrl'] as const).filter((key) => !services[key])
    if (missing.length > 0) {
      throw new Error(
        `The "${this.environment}" CoFHE environment has no ${missing.join(', ')} for chain ${this.chainId}. ` +
          'Record the endpoints in the deployment manifest (confidentialEngine.services), or deploy against ' +
          'an environment this build knows.',
      )
    }
    return {
      id: this.chainId,
      name: `chain ${this.chainId}`,
      network: `chain-${this.chainId}`,
      coFheUrl: services.coFheUrl as string,
      verifierUrl: services.verifierUrl as string,
      thresholdNetworkUrl: services.thresholdNetworkUrl as string,
      environment: this.environment === 'LOCAL' ? 'TESTNET' : (this.environment as CofheChain['environment']),
    }
  }

  /**
   * Turns an SDK failure into something a player can act on, and records the
   * one kind that no retry fixes.
   *
   * The skew check has moved with the SDK rather than been dropped: keys and
   * CRS are now fetched lazily, on the first `encryptInputs`, so a build
   * whose TFHE cannot read what the network serves fails at the moment a
   * Defense Point is sealed instead of at page load. That is a better place
   * for it to fail — but only if the message still says what it is, and if
   * the health lane still stops claiming the lane is fine.
   */
  private classify(error: unknown, what: string): Error {
    const detail = error as { message?: string; cause?: { message?: string } } | null
    if (isVersionSkew(detail)) {
      const message = describeInitFailure(this.environment, detail)
      this.fatal = message
      return new Error(message)
    }
    if (error instanceof Error) return new Error(`Could not ${what}: ${error.message}`, { cause: error })
    return new Error(`Could not ${what}: unknown error`)
  }

  /**
   * CoFHE's TaskManager, from the manifest or from the engine itself.
   *
   * The manifest records it at deploy time, so the common path is a field
   * read. Asking the engine is the fallback for a manifest written before
   * the field existed — the engine returns the address it was compiled
   * against, which is the one that matters.
   */
  private async taskManagerAddress(): Promise<Address> {
    if (this.taskManager) return this.taskManager
    return (await this.publicClient.readContract({
      address: this.engineAddress,
      abi: ENGINE_ABI,
      functionName: 'cofheTaskManager',
    })) as Address
  }

  private thresholdNetworkUrl(): string | null {
    return this.services.thresholdNetworkUrl ?? COFHE_SERVICES[this.environment]?.thresholdNetworkUrl ?? null
  }

  private verifierUrl(): string | null {
    return this.services.verifierUrl ?? COFHE_SERVICES[this.environment]?.verifierUrl ?? null
  }
}

/**
 * Fhenix's hosted CoFHE endpoints per environment.
 *
 * The same endpoints `@cofhe/sdk` carries in its own chain table, repeated
 * here because they are needed in two places the SDK is not: `cofheChain`
 * hands them *to* it, and two things this file does — the permissionless reveal and the health ping —
 * talk to those services *without* the SDK: the reveal must not require a
 * wallet, and the ping must work on a page with no operation open. An
 * operator running their own CoFHE overrides them in the manifest, and then
 * neither table is consulted.
 */
const COFHE_SERVICES: Record<string, CofheServiceUrls> = {
  MAINNET: {
    coFheUrl: 'https://mainnet-cofhe.fhenix.zone',
    verifierUrl: 'https://mainnet-cofhe-vrf.fhenix.zone',
    thresholdNetworkUrl: 'https://mainnet-cofhe-tn.fhenix.zone',
  },
  TESTNET: {
    coFheUrl: 'https://testnet-cofhe.fhenix.zone',
    verifierUrl: 'https://testnet-cofhe-vrf.fhenix.zone',
    thresholdNetworkUrl: 'https://testnet-cofhe-tn.fhenix.zone',
  },
  LOCAL: {
    coFheUrl: 'http://127.0.0.1:8448',
    verifierUrl: 'http://127.0.0.1:3001',
    thresholdNetworkUrl: 'http://127.0.0.1:3000',
  },
  // MOCK runs entirely against contracts etched on the host chain; there are
  // no services to reach, and the reveal reads the plaintext off the chain.
  MOCK: {},
}

export interface CofheServiceUrls {
  coFheUrl?: string
  verifierUrl?: string
  thresholdNetworkUrl?: string
}

export function cofheServiceDefaults(environment: string): CofheServiceUrls {
  return COFHE_SERVICES[environment] ?? {}
}

/**
 * Environments a manifest may name. An unknown one is a manifest to fix, not
 * a guess to make.
 *
 * `LOCAL` is this codebase's word, not the SDK's: `@cofhe/sdk` has only
 * `MOCK`, `TESTNET` and `MAINNET`, and a self-hosted stack is a `TESTNET`
 * pointed at localhost. `cofheChain` does that translation.
 */
export const COFHE_ENVIRONMENTS = ['MAINNET', 'TESTNET', 'LOCAL', 'MOCK'] as const

export function isCofheEnvironment(value: string | null | undefined): boolean {
  return typeof value === 'string' && (COFHE_ENVIRONMENTS as readonly string[]).includes(value)
}

/**
 * `euint128` — CoFHE's widest encrypted integer, and the type every handle
 * in this protocol carries.
 *
 * The number is shared with `Utils.EUINT128_TFHE` on the Solidity side,
 * which `FhenixConfidentialEngine.newEncryptedPoint` checks a blob against.
 * They are one wire constant with two spellings, so it is written literally
 * on both sides rather than read out of an enum on one of them.
 */
const FHE_UINT128 = 6

/**
 * The security zone every handle in this protocol lives in.
 *
 * CoFHE can partition ciphertexts into zones with different key material;
 * this protocol uses one, and says so explicitly rather than relying on the
 * SDK's default, because the number is *encoded into the blob* the engine
 * verifies. A default that changed under us would produce inputs the
 * TaskManager rejects, and the transaction that carries a Defense Point has
 * already been paid for by then.
 */
const SECURITY_ZONE = 0

const HEALTH_TIMEOUT_MS = 8_000

const TASK_MANAGER_ABI = [
  {
    type: 'function',
    name: 'getDecryptResultSafe',
    stateMutability: 'view',
    inputs: [{ name: 'ctHash', type: 'uint256' }],
    outputs: [
      { name: 'result', type: 'uint256' },
      { name: 'decrypted', type: 'bool' },
    ],
  },
] as const

const ENGINE_ABI = [
  {
    type: 'function',
    name: 'cofheTaskManager',
    stateMutability: 'pure',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const

/**
 * The one failure that must not read as a network blip.
 *
 * The SDK fetches the coprocessor's FHE public key and CRS and hands them to
 * TFHE-rs. If that library cannot parse them, what surfaces is an internal
 * error about a `usize` or a variant index — which looks transient, is not,
 * and no retry, wallet or setting on this side changes.
 *
 * This is the check that cost this project a working confidential layer for
 * a while, and it is kept for exactly that reason. `cofhejs` bundled
 * TFHE-rs 0.11 and called the plain deserializer while the network had moved
 * to versioned serialization on TFHE-rs 1.4+; the public key could be read
 * safely, the CRS could not be read at all, and every symptom pointed at the
 * network. `@cofhe/sdk` carries TFHE-rs 1.5 and reads both — so this branch
 * should now be unreachable, and the day it fires again it will mean the
 * same thing: this build's TFHE is behind the deployment it is pointed at.
 *
 * Kept unreachable-but-present rather than deleted, because the alternative
 * is rediscovering it from "an internal error occurred".
 */
/**
 * Whether a failure is the SDK and the network disagreeing about their
 * serialization format, as opposed to anything transient.
 */
export function isVersionSkew(error: { message?: string } | null): boolean {
  const cause = (error as { cause?: { message?: string } } | null)?.cause?.message
  const detail = [error?.message, cause].filter(Boolean).join(' — ')
  return /serializing (public key|crs)|expected variant index|expected usize/i.test(detail)
}

export function describeInitFailure(environment: string, error: { message?: string } | null): string {
  const cause = (error as { cause?: { message?: string } } | null)?.cause?.message
  const detail = [error?.message, cause].filter(Boolean).join(' — ')
  if (isVersionSkew(error)) {
    return (
      `The "${environment}" CoFHE deployment serves FHE parameters this build cannot read ` +
      `(${detail}). That is a version skew between the SDK's TFHE and the network, not a connection ` +
      'problem: upgrade @cofhe/sdk to a release built against the TFHE-rs this deployment serves. ' +
      'Retrying will not help.'
    )
  }
  return `Could not reach the "${environment}" CoFHE deployment: ${detail || 'unknown error'}`
}


/** The threshold network returns bytes; the protocol wants the integer behind them. */
function decodePlaintext(decrypted: ThresholdDecryptResponse['decrypted']): bigint | null {
  if (decrypted === undefined || decrypted === null) return null
  if (typeof decrypted === 'bigint') return decrypted
  if (typeof decrypted === 'number') return BigInt(decrypted)
  if (typeof decrypted === 'string') {
    const trimmed = decrypted.trim()
    if (trimmed === '') return null
    return BigInt(trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`)
  }
  if (Array.isArray(decrypted)) {
    return decrypted.reduce<bigint>((acc, byte) => (acc << 8n) | BigInt(byte & 0xff), 0n)
  }
  return null
}

/**
 * Whatever the network signed the plaintext with, as bytes the contract can
 * hand back to CoFHE's verifier.
 *
 * Empty is a supported answer, not a failure: `verifyDecryption` falls
 * through to the plaintext already published on chain, which by then is
 * usually there.
 */
function hexSignatures(body: ThresholdDecryptResponse): `0x${string}`[] {
  const raw = body.signature ?? body.signatures
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .map((signature) => toHex(signature))
    .filter((signature): signature is `0x${string}` => signature !== null)
}

function toHex(signature: unknown): `0x${string}` | null {
  if (typeof signature === 'string') {
    const trimmed = signature.trim()
    if (trimmed === '') return null
    return normaliseRecoveryId((trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`) as `0x${string}`)
  }
  if (Array.isArray(signature) || signature instanceof Uint8Array) {
    const bytes = Array.from(signature as ArrayLike<number>)
    if (bytes.length === 0) return null
    return normaliseRecoveryId(
      `0x${bytes.map((byte) => (byte & 0xff).toString(16).padStart(2, '0')).join('')}` as `0x${string}`,
    )
  }
  return null
}

/**
 * Puts the recovery byte in the range Solidity can recover from.
 *
 * The threshold network signs with a raw recovery id — `v` is 0 or 1 — and
 * `ECDSA.recover`, which is what CoFHE's own `verifyDecryptResult` calls,
 * accepts only 27 or 28 and rejects anything else outright. Passing the
 * signature through untouched therefore fails *every* reveal, and fails it
 * in the worst place: `unlockRound` has already been mined and paid for by
 * the time the second transaction is refused, so the round looks stuck
 * rather than misconfigured.
 *
 * Measured against Base Sepolia: the same plaintext and handle verify as
 * `false` with `v = 0` and `true` with `v = 27`.
 *
 * Anything that is not a 65-byte signature with a recovery id of 0 or 1 is
 * left exactly as it is — a network that already sends 27/28, or a format
 * this does not recognise, must not be rewritten on a guess.
 */
export function normaliseRecoveryId(signature: `0x${string}`): `0x${string}` {
  if (signature.length !== 132) return signature
  const v = Number.parseInt(signature.slice(130), 16)
  if (v !== 0 && v !== 1) return signature
  return `${signature.slice(0, 130)}${(v + 27).toString(16).padStart(2, '0')}` as `0x${string}`
}

interface ThresholdDecryptResponse {
  decrypted?: string | number | bigint | number[] | null
  signature?: unknown
  signatures?: unknown[]
}
