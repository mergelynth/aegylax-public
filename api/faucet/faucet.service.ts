import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import { formatEther, isAddress } from 'viem'
import { ChainService } from '../chain/chain.service'
import { CONFIG, type AppConfig } from '../config/configuration'

export type DripResult =
  | { status: 200; body: { ok: true; txHash: string; amountEth: string; retryAtMs: number } }
  | { status: 400 | 429 | 503; body: { ok: false; error: string; retryAtMs?: number } }

/**
 * The demo faucet: one drip per wallet per day, on the testnet this build
 * talks to.
 *
 * It lives on the server because it cannot live anywhere else. Signing a
 * transfer needs a private key, and every `VITE_*` variable is inlined into
 * the frontend bundle in plain text — a key placed there is published to
 * every visitor. A variable without the prefix is invisible to the browser.
 * There is no arrangement in which the page signs this itself: the browser
 * asks, and this decides.
 */
@Injectable()
export class FaucetService implements OnModuleInit {
  private readonly logger = new Logger(FaucetService.name)

  /**
   * Drips this process has just sent, and requests it is still serving.
   *
   * The chain is the durable record, but the *explorer index* is how this
   * reads it, and that index lags the chain by tens of seconds — measured,
   * not assumed: two requests seconds apart both got paid, and the same
   * request forty-five seconds later was correctly refused. For the length
   * of that lag the on-chain cooldown does not exist, which on a faucet
   * means somebody clicking twice gets paid twice.
   *
   * So this covers the gap and nothing else. It is deliberately not the
   * source of truth: it is lost on every deploy and is not shared between
   * instances, and both are fine, because anything it forgets is by then old
   * enough for the explorer to have indexed it.
   */
  private readonly recent = new Map<string, number>()
  private readonly inFlight = new Set<string>()

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly chain: ChainService,
  ) {}

  /** What one drip pays out. Configured — see `FAUCET_DRIP_ETH`. */
  dripAmount(): bigint {
    return this.config.faucet.dripWei
  }

  /**
   * Say at startup whether the configured drip is still enough to play with.
   *
   * The amount used to be derived from the contract, which never went stale
   * and was measured against the wrong thing: it covered a join and not a
   * create, so a funded newcomer's first button reverted. A configured
   * amount is the right call — the operator decides what a demo wallet is
   * worth — but it buys back the staleness, and a drip that quietly stops
   * being enough is exactly the failure that took a player to find.
   *
   * So the contract is read once, here, and the answer is a log line rather
   * than a refusal to boot. A faucet that is short is still worth running;
   * one that is short *and* silent about it is not.
   */
  async onModuleInit(): Promise<void> {
    if (!this.config.faucet.enabled) return this.logger.log('disabled')
    if (!this.config.faucet.privateKey) return this.logger.warn('no key — every request will be refused')

    const drip = this.dripAmount()
    this.logger.log(`${this.config.faucet.address} drips ${formatEther(drip)} ETH per wallet per day`)

    try {
      const costs = await this.entryCosts()
      if (drip < costs.join) {
        this.logger.warn(
          `the drip is below the cheapest join (${formatEther(costs.join)} ETH) — a funded wallet still cannot play`,
        )
      } else if (drip < costs.create) {
        this.logger.warn(
          `the drip covers a join but not creating an operation (${formatEther(costs.create)} ETH)`,
        )
      }
    } catch (error) {
      // A cold RPC at boot must not stop the faucet: this check is advice,
      // and every drip works without it.
      this.logger.warn(`could not check the drip against the contract: ${String((error as Error)?.message ?? error)}`)
    }
  }

  /**
   * The two amounts a newcomer's first transaction can cost, from the
   * contract's own parameters.
   *
   * `join` is the cheapest seat: the minimum entry plus the author's
   * commission, which is capped at `maxCreatorFeeBps`, so this is the worst
   * case for the cheapest lobby. `create` is what `createLobby` demands to
   * the wei — `startPrizePool + protocolJoinFee` — and it is the larger of
   * the two, which is the whole reason this check exists.
   */
  private async entryCosts(): Promise<{ join: bigint; create: bigint }> {
    // Mixed widths: the fees are uint128 and arrive as bigint, the basis
    // points are uint16 and arrive as a number.
    const [params] = await this.chain.read<[Record<string, bigint | number>, number]>('getParams')
    const minEntry = params.minEntryFee
    if (typeof minEntry !== 'bigint' || minEntry <= 0n) throw new Error('getParams returned no minEntryFee')
    const commission = (minEntry * BigInt(params.maxCreatorFeeBps ?? 0)) / 10_000n
    return {
      join: minEntry + commission,
      create: BigInt(params.minStartPrizePool ?? 0) + BigInt(params.protocolJoinFee ?? 0),
    }
  }

  /**
   * One drip, or the reason there is not one.
   *
   * Returns a shape rather than throwing, because every refusal here is an
   * ordinary answer the page has to render: too soon, empty, not configured.
   * Only genuine faults throw, and the controller turns those into a 502
   * without naming what failed — that would be a map of the deployment for
   * anybody probing it.
   */
  async drip(address: string): Promise<DripResult> {
    if (!isAddress(address)) return { status: 400, body: { ok: false, error: 'Not a valid address.' } }
    const key = this.config.faucet.privateKey
    if (!this.config.faucet.enabled || !key) {
      return { status: 503, body: { ok: false, error: 'The faucet is not available right now.' } }
    }

    const id = address.toLowerCase()
    if (this.inFlight.has(id)) {
      return { status: 429, body: { ok: false, error: 'A top-up for this wallet is already on its way.' } }
    }

    const remembered = this.recentDrip(id)
    if (remembered !== null) return this.tooSoon(remembered)

    this.inFlight.add(id)
    try {
      const amount = this.dripAmount()

      const previous = await this.lastDripAt(address as `0x${string}`)
      if (previous !== null) {
        // Remember it: the explorer answered once, and there is no reason to
        // ask again for the rest of the day.
        this.recent.set(id, previous)
        return this.tooSoon(previous)
      }

      const from = this.config.faucet.address!
      const balance = await this.chain.balanceOf(from)
      if (balance < amount) {
        this.logger.error(`${from} holds ${formatEther(balance)} ETH, needs ${formatEther(amount)}`)
        return { status: 503, body: { ok: false, error: 'The faucet is empty. Try again later.' } }
      }

      const wallet = this.chain.walletFor(key)
      const txHash = await wallet.sendTransaction({
        account: wallet.account!,
        to: address as `0x${string}`,
        value: amount,
        chain: this.chain.chain as any,
      })

      // Recorded before the receipt: the transaction is signed and broadcast,
      // and a second drip must not go out while the first is still pending.
      const at = this.remember(id)
      this.logger.log(`sent ${formatEther(amount)} ETH to ${address} — ${txHash}`)
      /*
       * The success carries the cooldown too, and not only the refusal.
       *
       * The page has to be able to say when this wallet may ask again the
       * moment a drip lands, and the length of the wait is this side's
       * number (`FAUCET_COOLDOWN_HOURS`) — same argument as the drip amount
       * in `useFaucet`. A client that assumed twenty-four hours would be a
       * second source of truth for a value an operator can change, going
       * stale in a bundle nobody rebuilds.
       */
      return {
        status: 200,
        body: {
          ok: true,
          txHash,
          amountEth: formatEther(amount),
          retryAtMs: at + this.config.faucet.cooldownMs,
        },
      }
    } finally {
      this.inFlight.delete(id)
    }
  }

  private tooSoon(at: number): DripResult {
    return {
      status: 429,
      body: {
        ok: false,
        error: 'This wallet has already been topped up today.',
        retryAtMs: at + this.config.faucet.cooldownMs,
      },
    }
  }

  /** Records the drip and returns when it happened, which is what dates the cooldown. */
  private remember(id: string): number {
    const now = Date.now()
    this.recent.set(id, now)
    const cutoff = now - this.config.faucet.cooldownMs
    for (const [key, at] of this.recent) if (at < cutoff) this.recent.delete(key)
    return now
  }

  private recentDrip(id: string): number | null {
    const at = this.recent.get(id)
    if (at === undefined) return null
    return at >= Date.now() - this.config.faucet.cooldownMs ? at : null
  }

  /**
   * When this address was last paid by the faucet, or null if not inside the
   * cooldown window.
   *
   * Read off the chain rather than out of a database. There is no store to
   * keep and nothing to keep in sync: the drips *are* the record, and a
   * transfer from the faucet to this address is the only evidence one
   * happened. That survives what a database would not — a redeploy, a
   * rollback, a second region — because the ledger it reads is the one the
   * payment landed in.
   *
   * Plain ETH transfers emit no logs, so `getLogs` has nothing to find and
   * the explorer's transaction index is the only way to ask "was this
   * address paid" without replaying every block by hand.
   */
  private async lastDripAt(to: `0x${string}`): Promise<number | null> {
    const from = this.config.faucet.address!
    const head = await this.chain.blockNumber()
    // The cooldown in seconds at two seconds a block, plus half again for
    // block time drifting or the chain halting and catching up.
    const span = BigInt(Math.ceil((this.config.faucet.cooldownMs / 1000 / 2) * 1.5))
    const startBlock = head > span ? head - span : 0n

    const url = new URL('https://api.etherscan.io/v2/api')
    url.searchParams.set('chainid', String(this.config.chain.id))
    url.searchParams.set('module', 'account')
    url.searchParams.set('action', 'txlist')
    url.searchParams.set('address', from)
    url.searchParams.set('startblock', String(startBlock))
    url.searchParams.set('endblock', '99999999')
    url.searchParams.set('sort', 'desc')
    if (this.config.faucet.explorerApiKey) url.searchParams.set('apikey', this.config.faucet.explorerApiKey)

    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`explorer returned ${response.status}`)
    const body = (await response.json()) as { message?: string; result: unknown }

    /*
     * "No transactions found" comes back as status "0" with an array result,
     * and it is the honest answer for a faucet that has not paid anybody
     * yet. A status "0" carrying a *string* result is a real error — a bad
     * key, a rate limit — and it has to refuse: reading that as "no previous
     * drip" would remove the cooldown exactly when the faucet is under load.
     */
    if (!Array.isArray(body.result)) throw new Error(`explorer error: ${body.message ?? 'unknown'}`)

    const wanted = to.toLowerCase()
    const cutoff = Date.now() - this.config.faucet.cooldownMs
    for (const entry of body.result as Array<Record<string, string>>) {
      if (entry.to?.toLowerCase() !== wanted) continue
      // A reverted transfer moved no value, so it does not spend the day.
      if (entry.isError === '1' || entry.value === '0') continue
      const at = Number(entry.timeStamp) * 1000
      if (Number.isFinite(at) && at >= cutoff) return at
    }
    return null
  }
}
