import type { WalletClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import {
  getProtocolHealth,
  reportPrivacyDelay,
  reportPrivacyLag,
  reportPrivacyOk,
} from '../../../protocolHealth'
import type { Address, Hash } from '../../../../game/types'
import {
  accountAddressOf,
  covalidatorLagSeconds,
  FREE_RETRIES,
  isNetworkUnavailable,
  isTransientDecryptFailure,
  REVEAL_DELAY_MS,
  REVEAL_RETRIES,
  REVEAL_TIMEOUT_MS,
  withPatience,
  type AttestedValue,
  type ConfidentialGateway,
  type FetchAttestedOptions,
} from '../gateway'

/**
 * Inco Lightning — the confidential network AEGYLAX shipped on first, kept
 * as a first-class alternative to Fhenix CoFHE.
 *
 * It is here rather than deleted for the reason the `IConfidentialEngine`
 * boundary exists at all: which network holds the secrets is a property of a
 * deployment, not of the protocol, and a second working implementation is
 * the only thing that keeps that claim honest. A deployment moves between
 * them with `CONFIDENTIAL_ENGINE` and a redeploy of the engine contract;
 * nothing in the game, the hooks or the UI changes.
 *
 * The whole file is loaded on demand — `@inco/js` is a large dependency and
 * a build running against Fhenix, the emulator or a local mock engine should
 * never pay for it.
 */

/**
 * Inco's own session-verifier contracts, keyed by chain id.
 *
 * These are *their* deployments, published in the Lightning JS docs, not
 * ours. Using them when the manifest has no verifier is what makes a probe
 * one transaction on a stock Base Sepolia / Base build, instead of a
 * transaction plus a signature. An ENV override still wins: a wrong
 * hardcoded address would be a voucher no covalidator honours, so an
 * operator who has been told a different verifier can still set
 * `VITE_CONFIDENTIAL_SESSION_VERIFIER`.
 *
 * @see https://docs.inco.org/js-sdk/voucher/allowance-voucher
 */
const INCO_SESSION_VERIFIERS: Record<number, Address> = {
  84532: '0xc34569efc25901bdd6b652164a2c8a7228b23005',
  8453: '0x68a5b59b4caf23416885859c1662746619a471f3',
}

export function defaultSessionVerifier(chainId: number): Address | null {
  return INCO_SESSION_VERIFIERS[chainId] ?? null
}

/**
 * Inco Lightning.
 *
 * Loaded on demand: it is a large dependency and a build running against the
 * emulator or a local mock engine should never pay for it.
 */
export class IncoGateway implements ConfidentialGateway {
  readonly kind = 'inco-lightning'

  private lightning: Promise<IncoLightningLike> | null = null

  /**
   * The reading session, once one has been granted. See `session()`.
   *
   * Held in memory for the life of this object, and mirrored into
   * `sessionStorage` so a reload of the lobby does not ask for the same
   * signature again. A voucher plus its ephemeral key is a bearer credential
   * for *every* handle this wallet can open — that is why it is not written
   * to `localStorage`, which would outlive the tab and be readable by any
   * later visit. `sessionStorage` dies with the tab, which is exactly as long
   * as the player is playing.
   */
  private reading: Promise<ReadingSession> | null = null
  /** The wallet the current session belongs to — a different one needs its own. */
  private readingOwner: Address | null = null
  /**
   * Set once the session path has failed, after which every read goes
   * straight to the per-call signature. See `decryptForOwner`.
   */
  private sessionUnavailable = false

  constructor(
    private readonly chainId: number,
    private readonly engineAddress: Address,
    private readonly getWalletClient: () => WalletClient | null,
    /**
     * The Inco release this deployment's engine was built against.
     *
     * Required, with no default on purpose. The executor the contract links
     * at compile time and the covalidator quorum this client resolves are
     * two halves of one choice, so a guessed value is not a fallback — it is
     * a client quietly asking the wrong quorum about handles it will never
     * be able to open. The manifest records what was deployed; if it does
     * not say, the deployment is the thing to fix.
     */
    private readonly pepper: string,
    /**
     * Inco's session-verifier contract, which decides whether a voucher this
     * wallet signed still authorises a given ephemeral key.
     *
     * Null disables the whole session path and leaves every read on the
     * per-call signature, which is the behaviour that predates it — a
     * deployment that has not been told which verifier to use gets the slower
     * flow rather than a guess. See `session()`.
     */
    private readonly sessionVerifier: Address | null,
    /**
     * HTTPS RPCs this tab already uses. Passed through to Inco so its own
     * viem client does not fall back to PublicNode — which 403s a browser
     * that is otherwise reading the chain fine. See `hostChainRpcUrlsForLightning`.
     */
    private readonly hostChainRpcUrls: readonly string[] = [],
  ) {}

  private async connect(): Promise<IncoLightningLike> {
    if (!this.lightning) {
      const hostChainRpcUrls = hostChainRpcUrlsForLightning(this.hostChainRpcUrls)
      this.lightning = ensureNodeGlobals()
        .then(() => import('@inco/js/lite'))
        .then(async (module) => {
          const { Lightning } = module as unknown as { Lightning: IncoLightningStatic }
          return Lightning.latest(
            this.pepper as never,
            this.chainId as never,
            hostChainRpcUrls ? { hostChainRpcUrls } : undefined,
          )
        })
    }
    return this.lightning
  }

  async encrypt(value: bigint, account: Address): Promise<`0x${string}`> {
    const lightning = await this.connect()
    return lightning.encrypt(value, { accountAddress: account, dappAddress: this.engineAddress })
  }

  /**
   * Load `@inco/js` before the first encryption needs it.
   *
   * The import and `Lightning.latest` are what a cold `encrypt` pays for
   * before it starts encrypting, and neither touches the wallet — so an
   * operation screen can pay them while the player is still choosing a
   * point. Nothing here grants a reading session; that is `ensureSession`,
   * and it prompts.
   */
  async warmUpEncrypt(): Promise<void> {
    await this.connect()
  }

  /**
   * Rehydrate a voucher this tab already signed. Never asks the wallet.
   *
   * Opening an operation used to call `session()`, which granted a new
   * voucher whenever `sessionStorage` was empty — every new tab, every
   * closed-and-reopened lobby, a signature the player did not ask for,
   * carrying Inco's mandatory leak warning. Restore is the silent half.
   */
  async warmUp(account: Address): Promise<void> {
    if (this.sessionUnavailable || !this.sessionVerifier) return
    if (this.readingOwner?.toLowerCase() === account.toLowerCase() && this.reading) return
    const restored = restorePersistedReadingSession(this.chainId, account)
    if (!restored) return
    this.readingOwner = account
    this.reading = Promise.resolve(restored)
  }

  /**
   * Grant a voucher if this tab does not already have one.
   *
   * Join calls this after the seat is taken; `decryptForOwner` calls
   * `session()` itself if a probe arrives first. A decline is swallowed
   * so the join they asked for still succeeds.
   */
  async ensureSession(account: Address): Promise<void> {
    if (this.sessionUnavailable || !this.sessionVerifier) return
    const wallet = this.getWalletClient()
    if (!wallet) return
    try {
      await this.session(wallet, account)
    } catch {
      // Left for `decryptForOwner` to retry or route around.
    }
  }

  /**
   * The probe answer, opened by its owner.
   *
   * The answer is unreadable to everyone else, and unreadable to this client
   * too without the player having authorised the read — that property is the
   * whole point and neither path below gives it up. What they differ on is
   * how often the player is asked.
   *
   * **The session path, first.** `attestedDecrypt` binds its EIP-712 request
   * to the exact handles being opened, so its signature can never be reused
   * and every probe costs a wallet prompt on top of the probe's own
   * transaction — two prompts to send one probe. Worse, that signature is
   * inside `withPatience`: the covalidator learns a handle exists by watching
   * the chain, so the first read after a probe routinely comes back "not
   * processed yet", and each retry re-prompted. A probe landing during
   * ingestion lag could ask for the same signature eight times.
   *
   * A session voucher is signed once, names an ephemeral key held in this
   * tab, and lets that key sign the read requests instead — so a probe is one
   * transaction and nothing else, and a retry costs nothing at all. The
   * authorisation is still the player's own signature over an Inco-worded
   * warning; it is granted once instead of per handle.
   *
   * **The per-call path, as the fallback.** Anything that goes wrong with a
   * session — no verifier configured, a grant the player declined, a
   * covalidator that will not take the voucher — falls back to signing the
   * read directly, and the flag makes that decision once rather than paying
   * for the discovery on every probe. This matters more than it looks: by the
   * time this runs, the probe transaction has already been mined and paid
   * for. Failing here would take something the player bought, so the
   * expensive path is always better than no path.
   */
  async decryptForOwner(handle: Hash, account?: Address): Promise<bigint> {
    const wallet = this.getWalletClient()
    if (!wallet) throw new Error('Sign in to read your reconnaissance results.')
    const lightning = await this.connect()

    const owner = account ?? accountAddressOf(wallet)
    let session: ReadingSession | null = null
    if (owner && !this.sessionUnavailable) {
      try {
        session = await this.session(wallet, owner)
      } catch (error) {
        /*
         * Only a *grant* that will not work demotes the tab. A decrypt that
         * failed with a live voucher is ingestion lag or an ACL that has
         * not landed — standing the session down on that sent every later
         * probe (and every per-block retry) through `attestedDecrypt`,
         * which is a wallet prompt per attempt.
         */
        if (isNetworkUnavailable(error) || isTransientDecryptFailure(error)) throw error
        this.sessionUnavailable = true
        this.reading = null
        if (this.readingOwner) {
          clearPersistedIncoSession(incoSessionStore(), incoSessionStorageKey(this.chainId, this.readingOwner))
        }
        console.warn(
          '[aegylax/confidential] Session-key reads unavailable; falling back to a wallet signature per read.',
          error,
        )
      }
    }

    if (session) {
      const granted = session
      // The handle exists on chain the moment the probe transaction lands,
      // but the network that can decrypt it learns about that by watching
      // the chain — so "not processed yet" is a normal answer for a few
      // seconds. Retrying here is free: the ephemeral key signs without a
      // prompt. Do not fall through to `attestedDecrypt` if this fails.
      return await withPatience(
        async () => {
          const [attestation] = await lightning.attestedDecryptWithVoucher(granted.account, granted.voucher, [handle])
          return BigInt(attestation.plaintext.value)
        },
        'open your Recon Probe result',
        FREE_RETRIES,
      )
    }

    /*
     * The fallback, and it is deliberately not retried.
     *
     * `attestedDecrypt` binds its EIP-712 request to the exact handle, so
     * every attempt is a *new wallet signature* — and wrapping it in the
     * retry loop above meant one probe could ask a player to sign eight
     * times over half a minute before failing anyway. That is the "endless
     * loader asking for more transactions" behaviour, and no part of it was
     * making the read more likely to succeed than being tried again later.
     *
     * One attempt, then an honest error. The handle stays on chain and the
     * probe stays the player's — `ContractBlockchainClient` records it as
     * pending so the read can be retried deliberately, for free, whenever
     * the player asks.
     */
    return withPatience(
      async () => {
        const [attestation] = await lightning.attestedDecrypt(wallet, [handle])
        return BigInt(attestation.plaintext.value)
      },
      'open your Recon Probe result',
      1,
    )
  }

  /**
   * Drops the in-memory session and the "this path is dead" flag.
   *
   * Deliberately leaves `sessionStorage` alone. The voucher is keyed by
   * wallet, so a reconnect of the same account — Privy restoring, a
   * StrictMode remount, a flicker to `null` — can pick it up without a
   * second signature. Clearing it here is what made every lobby reload
   * look like a new grant. An actual failed grant still forgets that
   * owner's blob in `decryptForOwner`.
   */
  reset(): void {
    this.reading = null
    this.readingOwner = null
    this.sessionUnavailable = false
  }

  /**
   * This tab's reading session, granted at most once per wallet.
   *
   * The ephemeral key is generated here. It lives in this object and, for
   * the tab's lifetime, in `sessionStorage` so a reload does not re-prompt.
   * The promise is cached rather than the result so that two probes fired
   * close together share one grant instead of racing into two wallet
   * prompts, which is the shape the reveal already had to learn (see
   * `useReveal`'s in-flight promise).
   *
   * Note what the voucher covers: **every** handle this wallet can open, for
   * as long as it lasts, which is why the TTL is short and the credential
   * never touches `localStorage`. `sessionStorage` is the reload path — same
   * tab, same wallet, no second prompt.
   */
  private async session(wallet: WalletClient, owner: Address): Promise<ReadingSession> {
    const verifier = this.sessionVerifier
    if (!verifier) throw new Error('No Inco session verifier is configured for this deployment.')

    // A wallet switch invalidates the in-memory voucher — it is signed by,
    // and scoped to, the account that granted it. Storage is keyed by
    // address, so the previous owner's blob stays for a switch back.
    if (this.readingOwner?.toLowerCase() !== owner.toLowerCase()) {
      this.reading = null
      this.readingOwner = owner
    }

    /*
     * A grant already in flight is joined rather than duplicated, and one
     * that failed is forgotten rather than cached: a single declined prompt
     * or network blip must not make the session path dead for the tab.
     * `sessionUnavailable` in the caller is what stops a *systematic* failure
     * from asking again.
     */
    const current = this.reading ? await this.reading.catch(() => null) : null
    // Renewed before it lapses rather than after: a voucher that expires
    // mid-read fails the covalidator's check, and the cost of being early is
    // one extra prompt an hour.
    if (current && current.expiresAtMs - Date.now() > SESSION_RENEWAL_MARGIN_MS) return current

    const restored = restorePersistedReadingSession(this.chainId, owner)
    if (restored) {
      this.reading = Promise.resolve(restored)
      return restored
    }

    const granting = (async () => {
      const lightning = await this.connect()
      const privateKey = generatePrivateKey()
      const account = privateKeyToAccount(privateKey)
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
      const voucher = await lightning.grantSessionKeyAllowanceVoucher(wallet, account.address, expiresAt, verifier)
      const session: ReadingSession = { account, voucher, expiresAtMs: expiresAt.getTime() }
      savePersistedIncoSession(incoSessionStore(), incoSessionStorageKey(this.chainId, owner), {
        privateKey,
        voucher,
        expiresAtMs: session.expiresAtMs,
      })
      return session
    })()

    this.reading = granting
    return granting
  }

  /**
   * Plaintexts for handles the contract has publicly unlocked.
   *
   * No wallet is involved: after `completeAttack` these values are meant to
   * be readable by anyone, which is what makes the reveal permissionless.
   * The signatures travel with them so the contract can check the quorum
   * itself.
   */
  async fetchAttested(handles: Hash[], options: FetchAttestedOptions = {}): Promise<AttestedValue[]> {
    if (handles.length === 0) return []
    const lightning = await this.connect()

    return withPatience(
      async () => {
        const attestations = await lightning.attestedReveal(handles)
        return attestations.map((attestation) => ({
          value: BigInt(attestation.plaintext.value),
          signatures: toHexSignatures(attestation),
        }))
      },
      'fetch the revealed attack data',
      options.attempts ?? REVEAL_RETRIES,
      REVEAL_DELAY_MS,
      options.timeoutMs ?? REVEAL_TIMEOUT_MS,
    )
  }

  async probeHealth(): Promise<void> {
    try {
      const lightning = await this.connect()
      const ping = await probeCovalidatorQuorum(covalidatorUrlsOf(lightning))
      if (ping.lagSeconds !== null) {
        reportPrivacyLag(ping.lagSeconds)
        return
      }
      if (!ping.ready) {
        reportPrivacyDelay()
        return
      }
      /*
       * `IsReady` is the process, not the indexer. status.inco.org can
       * read Healthy while ACL is half an hour behind, so a ready ping
       * must not clear a lag this tab already measured.
       */
      if (getProtocolHealth().privacyLagSeconds === null) reportPrivacyOk()
    } catch (error) {
      const lag = covalidatorLagSeconds(error)
      if (lag !== null) reportPrivacyLag(lag)
      else reportPrivacyDelay()
    }
  }
}

/**
 * `Buffer`, which `@inco/js` assumes exists.
 *
 * The SDK converts every ciphertext, handle and hex string through Node's
 * `Buffer` (`binary.js`, `handle.js`, `encryption.js`) with no browser
 * branch, so in a tab the first confidential call throws
 * `Buffer is not defined`. That failure is silent in the worst possible
 * way: `sendProbe` and `submitDefense` are *chain transactions that
 * already succeeded* — the probe is spent, the defense window is used —
 * and only the encryption or the decryption afterwards fails, so the money
 * is gone and the player is left with a map that never changes and a
 * Defend button that appears to do nothing.
 *
 * The polyfill is installed here rather than in `main.tsx` on purpose:
 * this is the only dependency that needs it, it is dynamically imported,
 * and a build running against the emulator or a mock engine should not
 * carry a Node shim it never calls. Loading it beside the SDK keeps the
 * two facts in one place.
 */
async function ensureNodeGlobals(): Promise<void> {
  const globals = globalThis as typeof globalThis & { Buffer?: unknown }
  if (globals.Buffer) return
  const { Buffer } = await import('buffer')
  globals.Buffer = Buffer
}

interface IncoAttestation {
  plaintext: { value: string | bigint }
  /** One per covalidator; the verifier checks them against its threshold. */
  covalidatorSignatures?: Array<Uint8Array | string>
  covalidatorSignature?: Uint8Array | string
}

/**
 * The quorum's signatures, as the contract expects them.
 *
 * All of them travel, not the first: the on-chain verifier counts valid
 * signatures against its own threshold, so dropping any of them is how a
 * reveal that should succeed starts failing the moment the quorum grows.
 */
function toHexSignatures(attestation: IncoAttestation): `0x${string}`[] {
  const raw = attestation.covalidatorSignatures ?? (attestation.covalidatorSignature ? [attestation.covalidatorSignature] : [])
  return raw.map((signature) =>
    typeof signature === 'string'
      ? (signature as `0x${string}`)
      : (`0x${Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('')}` as `0x${string}`),
  )
}

interface IncoLightningLike {
  encrypt(
    value: bigint,
    context: { accountAddress: string; dappAddress: string },
  ): Promise<`0x${string}`>
  attestedDecrypt(wallet: unknown, handles: string[]): Promise<IncoAttestation[]>
  attestedDecryptWithVoucher(
    ephemeralAccount: PrivateKeyAccount,
    voucher: AllowanceVoucher,
    handles: string[],
  ): Promise<IncoAttestation[]>
  grantSessionKeyAllowanceVoucher(
    wallet: unknown,
    granteeAddress: string,
    expiresAt: Date,
    sessionVerifierAddress: string,
  ): Promise<AllowanceVoucher>
  attestedReveal(handles: string[]): Promise<IncoAttestation[]>
  /**
   * Runtime field on the SDK instance. Typed here so a readiness ping can
   * hit the same quorum gameplay uses, without reaching through `any`.
   */
  covalidatorUrls?: readonly string[]
}

/**
 * Inco's signed allowance voucher, kept opaque on purpose.
 *
 * Nothing here reads inside it — it is produced by `grantSessionKeyAllowanceVoucher`
 * and handed straight back to `attestedDecryptWithVoucher`. Typing its fields
 * would be this file claiming to know a wire format it has no business
 * depending on.
 */
type AllowanceVoucher = object

/** A granted reading session: the key the voucher names, and how long it lasts. */
interface ReadingSession {
  account: PrivateKeyAccount
  voucher: AllowanceVoucher
  expiresAtMs: number
}

/** How long a reading session lasts. */
export const SESSION_TTL_MS = 60 * 60 * 1000

/** Renew this long before expiry, so no read is ever made against a lapsing voucher. */
export const SESSION_RENEWAL_MARGIN_MS = 5 * 60 * 1000

export const INCO_SESSION_STORAGE_PREFIX = 'aegylax:inco-session:'

export function incoSessionStorageKey(chainId: number, owner: Address): string {
  return `${INCO_SESSION_STORAGE_PREFIX}${chainId}:${owner.toLowerCase()}`
}

export interface PersistedIncoSession {
  privateKey: `0x${string}`
  voucher: unknown
  expiresAtMs: number
}

export function incoSessionStore(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null
    return sessionStorage
  } catch {
    return null
  }
}

export function loadPersistedIncoSession(
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null,
  key: string,
  nowMs = Date.now(),
  renewalMarginMs = SESSION_RENEWAL_MARGIN_MS,
): PersistedIncoSession | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedIncoSession>
    if (typeof parsed.privateKey !== 'string' || !parsed.privateKey.startsWith('0x')) return null
    if (typeof parsed.expiresAtMs !== 'number' || !Number.isFinite(parsed.expiresAtMs)) return null
    if (parsed.voucher === undefined || parsed.voucher === null) return null
    if (parsed.expiresAtMs - nowMs <= renewalMarginMs) {
      storage.removeItem(key)
      return null
    }
    return parsed as PersistedIncoSession
  } catch {
    return null
  }
}

export function savePersistedIncoSession(
  storage: Pick<Storage, 'setItem'> | null,
  key: string,
  session: PersistedIncoSession,
): void {
  if (!storage) return
  try {
    storage.setItem(key, JSON.stringify(session))
  } catch {
    // Quota, private mode, or a voucher that is not JSON. The in-memory
    // session still works for this tab; a reload will grant again.
  }
}

export function clearPersistedIncoSession(storage: Pick<Storage, 'removeItem'> | null, key: string): void {
  if (!storage) return
  try {
    storage.removeItem(key)
  } catch {
    // Storage can throw in private mode; forgetting the credential is best-effort.
  }
}

function restorePersistedReadingSession(chainId: number, owner: Address): ReadingSession | null {
  const stored = loadPersistedIncoSession(incoSessionStore(), incoSessionStorageKey(chainId, owner))
  if (!stored) return null
  try {
    return {
      account: privateKeyToAccount(stored.privateKey),
      voucher: stored.voucher as AllowanceVoucher,
      expiresAtMs: stored.expiresAtMs,
    }
  } catch {
    clearPersistedIncoSession(incoSessionStore(), incoSessionStorageKey(chainId, owner))
    return null
  }
}

interface IncoLightningStatic {
  latest(
    pepper: string,
    chainId: number,
    options?: { hostChainRpcUrls?: readonly string[] },
  ): Promise<IncoLightningLike>
}

/**
 * HTTPS endpoints Inco's SDK should read the host chain through.
 *
 * `Lightning.latest` without this falls back to viem's public RPC, which
 * for Base Sepolia is PublicNode. That endpoint 403s a browser that already
 * has working fallbacks of its own, and the covalidator then 500s
 * `AttestedReveal` because it never saw the unlock. WebSocket URLs are the
 * app's live-block feed; Inco wants HTTP.
 */
export function hostChainRpcUrlsForLightning(
  rpcUrls: readonly string[],
): readonly string[] | undefined {
  const http = rpcUrls.filter((url) => /^https?:\/\//i.test(url))
  if (http.length === 0) return undefined
  /*
   * One URL, the first. Inco's own viem client is unbatched and reads
   * every covalidator signer as a separate `eth_call` on connect. Handing
   * it the whole fallback list made those calls, plus CORS preflights,
   * plus our own watcher, look like a hundred requests in a couple of
   * seconds — and still sampled PublicNode, which 403s. This tab already
   * has fallbacks; Inco only needs one host RPC that works.
   */
  return [http[0]]
}

/**
 * Covalidator endpoints the live Lightning instance resolved.
 *
 * The SDK keeps this as a TypeScript-private field; at runtime it is on
 * the object, and it is the same list `AttestedReveal` posts to.
 */
export function covalidatorUrlsOf(lightning: { covalidatorUrls?: readonly string[] }): readonly string[] {
  return (lightning.covalidatorUrls ?? []).filter((url) => typeof url === 'string' && url.length > 0)
}

const IS_READY_PATH = '/inco.kms.lite.v1.KmsService/IsReady'
const IS_READY_TIMEOUT_MS = 8_000

function isReadyUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}${IS_READY_PATH}`
}

export interface CovalidatorPing {
  ready: boolean
  /** From `out of sync: N seconds behind` on the body, when present. */
  lagSeconds: number | null
}

/**
 * One covalidator's `IsReady` — the cheap RPC, not a decrypt.
 *
 * A 500 from `AttestedReveal` is a gameplay failure. This is the same
 * host answering whether it is even configured, which is what the header
 * can ask from Home without a handle to open. The body of a 500 can still
 * carry `out of sync: N seconds behind`; `ready: true` never does, and
 * must not be read as "the indexer caught up".
 */
export async function pingCovalidatorIsReady(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CovalidatorPing> {
  try {
    const response = await fetchImpl(isReadyUrl(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
      },
      body: '{}',
      signal: AbortSignal.timeout(IS_READY_TIMEOUT_MS),
    })
    const text = await response.text()
    const lagSeconds = covalidatorLagSeconds(text)
    if (lagSeconds !== null) return { ready: false, lagSeconds }
    if (!response.ok) return { ready: false, lagSeconds: null }
    try {
      const body = JSON.parse(text) as { ready?: unknown }
      return { ready: body.ready === true, lagSeconds: null }
    } catch {
      return { ready: false, lagSeconds: null }
    }
  } catch (error) {
    return { ready: false, lagSeconds: covalidatorLagSeconds(error) }
  }
}

/**
 * Whether any node in the quorum will take work. One ready node is enough
 * to call the lane operational; a published indexer lag on any node is
 * the status, even if another answers `ready`.
 */
export async function probeCovalidatorQuorum(
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<CovalidatorPing> {
  if (urls.length === 0) return { ready: false, lagSeconds: null }
  const results = await Promise.all(urls.map((url) => pingCovalidatorIsReady(url, fetchImpl)))
  const lags = results.map((result) => result.lagSeconds).filter((seconds): seconds is number => seconds !== null)
  const lagSeconds = lags.length > 0 ? Math.max(...lags) : null
  if (lagSeconds !== null) return { ready: false, lagSeconds }
  return { ready: results.some((result) => result.ready), lagSeconds: null }
}
