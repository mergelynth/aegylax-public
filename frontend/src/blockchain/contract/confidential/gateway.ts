import {
  describePrivacyLag,
  reportPrivacyDelay,
  reportPrivacyLag,
  reportPrivacyOk,
} from '../../protocolHealth'
import type { Address, Hash } from '../../../game/types'

/**
 * What the protocol asks of a confidential network, and nothing about which
 * one (ТЗ §1, §3).
 *
 * The contracts have `IConfidentialEngine`; this is its other half. Three
 * things have to happen off chain, and every provider in `providers/` does
 * these three and no more:
 *
 *   - a Defense Point is **encrypted before it leaves the tab**, against the
 *     engine's address, so the coordinate is never a readable transaction
 *     argument;
 *   - a Recon Probe's answer is **decrypted by its owner alone**, through a
 *     re-encryption the confidential network performs for exactly the
 *     wallet the engine granted access to;
 *   - after an attack lands, the plaintexts behind its handles are fetched
 *     **with whatever the network signs them with**, which is what lets the
 *     contract accept a revealed coordinate as its own rather than as a
 *     claim.
 *
 * The frontend never derives hidden data itself. Everything a provider does
 * is a request to its network and a transcription of the answer; there is no
 * path where a trajectory is reconstructed locally, and none where a
 * coordinate is recovered without the network having agreed to release it.
 *
 * The error vocabulary below is shared on purpose. Fhenix and Inco fail with
 * different strings, but a player only ever needs to be told one of three
 * things — *this read is refused*, *the network is catching up*, or *the
 * network is down* — and the hooks that pick the words are written against
 * these predicates, not against a provider.
 */

export interface AttestedValue {
  value: bigint
  signatures: `0x${string}`[]
}

export interface ConfidentialGateway {
  readonly kind: string
  /** Encrypts one packed value for `engineAddress`, bound to `account`. */
  encrypt(value: bigint, account: Address): Promise<`0x${string}`>
  /**
   * Loads whatever the first `encrypt` would have had to load, without
   * encrypting anything and without opening the wallet.
   *
   * The provider SDKs are the largest dependency in the build and they are
   * imported on demand, so the first encryption on a page pays for the
   * chunk, the WASM and the client handshake before it starts doing the
   * work the player asked for — seconds, all of it in front of the wallet
   * prompt. Calling this when an operation opens moves that cost to a
   * moment nobody is waiting on.
   *
   * A no-op when there is nothing to load, and never throws anything the
   * caller has to handle: nothing downstream depends on it having run.
   */
  warmUpEncrypt?(account: Address): Promise<void>
  /** Opens a handle this wallet was granted access to — a probe's own answer. */
  decryptForOwner(handle: Hash, account: Address): Promise<bigint>
  /** Fetches attested plaintexts for handles the contract has unlocked. */
  fetchAttested(handles: Hash[], options?: FetchAttestedOptions): Promise<AttestedValue[]>
  /**
   * Restores a reading session this tab already granted, without opening
   * the wallet. A no-op when there is nothing to restore.
   *
   * Used on lobby load so a reload of the same tab is silent. It must not
   * grant a new voucher: that signature is Inco's scary "may leak your
   * private data" prompt, and popping it because somebody opened a page
   * reads as a scam.
   */
  warmUp?(account: Address): Promise<void>
  /**
   * Grants a reading session if this tab does not already have one.
   *
   * May open the wallet. Call it from a player action (Join, or the first
   * probe) never from a page-load effect. Never throws: `decryptForOwner`
   * is the fallback, so a decline costs a prompt later rather than a
   * failed join.
   */
  ensureSession?(account: Address): Promise<void>
  /**
   * Drops in-memory session state for the wallet that just went away.
   *
   * Optional. On Inco it forgets the live voucher and the flag that stands
   * the session path down, so a wallet switch starts clean. It does *not*
   * erase `sessionStorage`: that blob is keyed by account, and wiping it
   * on a reconnect is what re-prompted every lobby reload.
   */
  reset?(): void
  /**
   * Ask the covalidator quorum whether it will answer, without a handle.
   *
   * The header runs this on every page so an Inco outage is a yellow
   * shield before anyone sends a probe. Gameplay reports (`withPatience`)
   * still refine the same lane; this is the probe that makes the lane
   * exist off the Operation screen.
   */
  probeHealth?(): Promise<void>
}

export interface FetchAttestedOptions {
  /** How many times to ask while the quorum catches up with an unlock. */
  attempts?: number
  /** Per-attempt ceiling; a hung node must not occupy the spinner forever. */
  timeoutMs?: number
}

/**
 * Whether a failure is the confidential network being unavailable, as
 * opposed to this read being refused.
 *
 * The two need different words in front of a player. A refusal is about
 * them — a handle their wallet was never granted — and no amount of waiting
 * changes it. An unreachable quorum is about the network: their probe is
 * on chain, paid for and still theirs, and it will open when the network is
 * back. Telling them the first when it is the second is how a working probe
 * comes to look like a lost one.
 *
 * Matched on the shapes Inco's client actually produces when its covalidator
 * quorum cannot answer: too few nodes responding to meet the threshold.
 *
 * `failed to check acl` is *not* this. That is the covalidator looking at
 * a grant `collectProbe` just wrote — the same ingestion lag as
 * `Failed to decrypt handles`. Treating it as the network being down
 * aborted the first read of a paid probe and told the player their result
 * was unreachable, when waiting a few seconds would have opened it.
 *
 * A timeout of *our* making is not this. The covalidator learns about an
 * unlock by watching the chain, so "not processed yet" (and a request that
 * sits unanswered until our ceiling) is ingestion lag — it retries. Folding
 * that into "network down" aborted the reveal after one 12s wait and sent
 * the player back around the wallet for another `unlockRound`.
 */
export function isNetworkUnavailable(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    message.includes('cannot reach threshold') ||
    message.includes('failed clients exceed limit') ||
    message.includes('connection refused') ||
    message.includes('fetch failed')
  )
}

/**
 * A decrypt that failed because the handle is not open *yet*, not because
 * the session voucher is junk.
 *
 * Inco answers `Failed to decrypt handles` or `failed to check acl` when
 * the covalidator has not ingested `collectProbe`, or the ACL grant has
 * not landed. That is the same fact `withPatience` exists to wait out.
 * Treating it as a refused session demoted the tab onto `attestedDecrypt`
 * — a *new wallet signature per attempt* — and the Operation screen's
 * per-block poll then asked for that signature on every block.
 */
export function isTransientDecryptFailure(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    message.includes('failed to decrypt') ||
    message.includes('decrypt handles') ||
    message.includes('not processed') ||
    message.includes('handle is not allowed') ||
    (message.includes('failed to check acl') && !isCovalidatorBehind(error)) ||
    isNetworkUnavailable(error) ||
    isOurTimeout(error)
  )
}

/**
 * The player-facing copy `withPatience` uses when the quorum will not
 * answer. Distinct from a refused read: the probe is still on chain, and
 * the Operation screen should keep trying rather than freeze the pull.
 */
export function isConfidentialNetworkQuiet(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    message.includes('slow to answer') ||
    message.includes('privacy layer is down') ||
    message.includes('privacy layer is not answering') ||
    message.includes('confidential network is down') ||
    message.includes('confidential network is not answering')
  )
}

/** Our own per-attempt ceiling, not an Inco refusal. See `withPatience`. */
function isOurTimeout(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return message.includes('timed out waiting')
}

/**
 * The covalidator is indexing the host chain and has fallen behind it.
 *
 * `failed to check acl` without this is a grant that has not landed yet —
 * a few seconds. `out of sync: 1725 seconds behind` is their indexer ~29
 * minutes late; retrying a decrypt will not catch it up, it only storms
 * the RPC and the KMS.
 */
export function covalidatorLagSeconds(error: unknown): number | null {
  const match = (error instanceof Error ? error.message : String(error)).match(
    /out of sync:\s*(\d+)\s*seconds behind/i,
  )
  if (!match) return null
  const seconds = Number(match[1])
  return Number.isFinite(seconds) ? seconds : null
}

export function isCovalidatorBehind(error: unknown): boolean {
  return covalidatorLagSeconds(error) !== null
}

export function describeCovalidatorLag(error: unknown): string {
  const seconds = covalidatorLagSeconds(error)
  if (seconds === null) return 'The privacy layer is behind the chain.'
  return describePrivacyLag(seconds)
}

/**
 * The confidential network is answering with a server failure, not with
 * "not processed yet". Distinct from `isTransientDecryptFailure`, which
 * includes ingestion lag that a probe is supposed to wait out.
 */
function isConfidentialOutage(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    message.includes('failed to reveal') ||
    message.includes('internal server') ||
    message.includes('attesteddecrypt') ||
    message.includes('attestedreveal') ||
    message.includes('out of sync') ||
    /(?:^|\D)500(?:\D|$)/.test(message)
  )
}

/**
 * The address a WalletClient is acting as.
 *
 * viem accepts either a string (`account: '0x…'`) or an Account object.
 * The signer bridge passes a string — that is the EIP-1193 shape, and it is
 * what Privy hands over. Reading `.address` off a string is `undefined`,
 * which used to skip the session path entirely and fall through to a
 * per-read wallet signature: two prompts to send one probe, even after a
 * session had already been granted at join.
 */
export function accountAddressOf(
  wallet: { account?: Address | { address?: string } | null } | null | undefined,
): Address | undefined {
  const account = wallet?.account
  if (!account) return undefined
  return (typeof account === 'string' ? account : account.address) as Address | undefined
}

/**
 * How long one confidential-network round trip is allowed to sit unanswered.
 *
 * Without this a hung covalidator — not a refusal, a request that never
 * comes back — left the Operation screen on a spinner forever: the probe
 * transaction had confirmed, the reveal's first half had confirmed, and
 * nothing in front of the player could move. A timeout turns that into an
 * error they can retry; the handle stays on chain either way.
 *
 * Forty-five seconds because a probe hint measurably takes more than
 * twelve, and the old ceiling was cutting off answers that were on their
 * way. Timed against CoFHE on Base Sepolia: a Defense Point handle — a
 * ciphertext the player made, which the coprocessor never computed on —
 * opens in **3s**, while a probe hint takes **26–30s**. The difference is
 * the four encrypted remainders behind every hint, and it is not lag: it is
 * the answer being computed.
 *
 * At twelve seconds the SDK's own polling was killed mid-flight, twice,
 * before a third attempt happened to start late enough to catch the result
 * — and `withPatience` counts three of those as a hung node and gives up.
 * A read the player had already paid for could therefore fail on a network
 * that was working correctly, just not quickly. One attempt long enough to
 * outlast the computation is both more reliable and cheaper than three that
 * cannot.
 */
const ATTEMPT_TIMEOUT_MS = 45_000

async function withTimeout<T>(action: () => Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting to ${what}`)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * How soon the first retry goes out.
 *
 * `delayMs` is the *ceiling* the backoff climbs to, not the wait between
 * every attempt. Ingestion lag is usually a second or two and occasionally
 * much longer, so a flat four seconds paid the worst case on every read:
 * an answer that became available 200ms after the first miss sat unclaimed
 * for the rest of the interval. Doubling from here reaches the same ceiling
 * by the fourth attempt, which is where the long waits actually live.
 */
const FIRST_RETRY_MS = 700

/**
 * Retries the confidential network while it catches up with the chain.
 *
 * Bounded and short: this waits out ingestion lag, it does not paper over a
 * refusal. An unauthorised read fails the same way on every attempt and
 * still ends as an error, with a message a player can act on.
 *
 * `delayMs` is the ceiling of an exponential backoff — see `FIRST_RETRY_MS`.
 */
export async function withPatience<T>(
  action: () => Promise<T>,
  what: string,
  attempts = FREE_RETRIES,
  delayMs = 4000,
  timeoutMs = ATTEMPT_TIMEOUT_MS,
): Promise<T> {
  let backoff = Math.min(FIRST_RETRY_MS, delayMs)
  let lastError: unknown
  let hung = 0
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await withTimeout(action, timeoutMs, what)
      reportPrivacyOk()
      return result
    } catch (error) {
      lastError = error
      /*
       * An unreachable quorum is not ingestion lag, so waiting it out is
       * spending the player's time on an answer that is not coming. It fails
       * in milliseconds and identically every time — eight rounds of it is
       * half a minute of spinner before the same error.
       */
      if (isNetworkUnavailable(error) || isCovalidatorBehind(error)) {
        const lag = covalidatorLagSeconds(error)
        if (lag !== null) reportPrivacyLag(lag)
        else reportPrivacyDelay()
        break
      }
      /*
       * Our ceiling firing is ingestion lag until it isn't. One 12s hang
       * used to abort the whole reveal and send the player back around the
       * wallet; three in a row is a node that will not answer.
       */
      if (isOurTimeout(error)) {
        hung += 1
        if (hung >= 3) {
          reportPrivacyDelay()
          break
        }
      } else {
        hung = 0
      }
      // A 500 from AttestedReveal is not "not processed yet". Yellow the
      // shield while we still retry, so the header matches the console
      // rather than waiting out the whole loop first.
      if (attempts > 1 && isConfidentialOutage(error)) reportPrivacyDelay()
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, backoff))
        backoff = Math.min(backoff * 2, delayMs)
      }
    }
  }
  if (isCovalidatorBehind(lastError)) {
    const lag = covalidatorLagSeconds(lastError)
    if (lag !== null) reportPrivacyLag(lag)
    else reportPrivacyDelay(describeCovalidatorLag(lastError))
    throw new Error(describeCovalidatorLag(lastError))
  }
  if (isNetworkUnavailable(lastError) || isOurTimeout(lastError)) {
    reportPrivacyDelay()
    throw new Error(
      'The privacy layer is slow to answer. Still calculating your result.',
    )
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError)
  // A single cheap probe (`attempts: 1`) failing as ingestion lag is
  // expected; the header must not go yellow for that. Exhausting a real
  // retry loop, or a hung/unreachable quorum, is the confidential network
  // not answering this tab.
  if (attempts > 1) reportPrivacyDelay()
  throw new Error(`Could not ${what}: ${detail}`)
}

/**
 * How many times a read that costs the player *nothing* is retried.
 *
 * Only the voucher path and the permissionless reveal qualify: both are
 * signed by a key this tab already holds, so a retry is a request and not a
 * prompt. The per-call path is explicitly excluded — see `decryptForOwner`.
 */
export const FREE_RETRIES = 8

/**
 * The reveal's round trip to the quorum. Longer than a probe read: the
 * covalidator has to notice `unlockRound` on chain before it will sign, and
 * the CLI that does this from outside the browser waits up to two minutes
 * for the same reason (`fetchAttestedWithPatience` in `tools/chain/reveal.mjs`).
 */
export const REVEAL_RETRIES = 15
export const REVEAL_DELAY_MS = 4_000
export const REVEAL_TIMEOUT_MS = 15_000
