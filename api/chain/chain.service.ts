import { Inject, Injectable, Logger } from '@nestjs/common'
import {
  createPublicClient,
  createWalletClient,
  http,
  type Account,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { CONFIG, type AppConfig } from '../config/configuration'

/**
 * The chain, as the rest of the backend is allowed to see it.
 *
 * Everything that reads or writes the protocol goes through here, so there
 * is exactly one place that knows the address, the ABI and how a transaction
 * is sent — and exactly one place to change when the indexer wants a second
 * client, or a batch reader, or its own RPC.
 *
 * It holds no game state and answers no game question. `read` returns what
 * the contract said; `send` asks the contract to decide something. Anything
 * that looks like a rule belongs in the contract, not in a service that
 * happens to be closer to the reader.
 */
/** Blocks to average the block time over. Long enough to survive L2 timestamp quantisation. */
const BLOCK_TIME_SAMPLE = 200n

@Injectable()
export class ChainService {
  private readonly logger = new Logger(ChainService.name)
  private readonly client: PublicClient
  private readonly wallets = new Map<string, WalletClient>()
  private blockTimeCache: number | null = null

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {
    this.client = createPublicClient({ transport: http(config.chain.rpcUrl) }) as PublicClient
  }

  get publicClient(): PublicClient {
    return this.client
  }

  get chain() {
    return {
      id: this.config.chain.id,
      name: this.config.chain.network,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [this.config.chain.rpcUrl] } },
    } as const
  }

  blockNumber(): Promise<bigint> {
    return this.client.getBlockNumber()
  }

  /**
   * How long one block takes, measured rather than configured.
   *
   * The keeper schedules itself against block deadlines — an operation's
   * registration block, an attack's impact block — and turning those into a
   * `setTimeout` needs a seconds-per-block figure. Hardcoding one is a
   * number that is right on exactly one chain and silently wrong on the
   * next: too small and the keeper wakes early and does nothing, too large
   * and it wakes late and every player watches the gap.
   *
   * Sampled over a window rather than from two adjacent blocks, because
   * adjacent timestamps on an L2 are quantised and can differ by zero.
   * Cached for the life of the process: block time is a chain constant, and
   * re-measuring it would cost two archive reads per sweep for an answer
   * that never moves.
   */
  async blockTimeMs(): Promise<number> {
    if (this.blockTimeCache !== null) return this.blockTimeCache

    const fallback = 2_000
    try {
      const head = await this.client.getBlock()
      const span = head.number > BLOCK_TIME_SAMPLE ? BLOCK_TIME_SAMPLE : head.number
      if (span === 0n) return fallback
      const older = await this.client.getBlock({ blockNumber: head.number - span })
      const ms = (Number(head.timestamp - older.timestamp) * 1000) / Number(span)
      this.blockTimeCache = ms > 0 ? ms : fallback
      this.logger.log(`block time ${Math.round(this.blockTimeCache)}ms over ${span} blocks`)
    } catch (error) {
      // A measurement that fails must not stop the keeper — it only makes
      // its next wake-up less precise.
      this.logger.warn(`block time unmeasurable, assuming ${fallback}ms: ${short(error)}`)
      return fallback
    }
    return this.blockTimeCache
  }

  balanceOf(address: `0x${string}`): Promise<bigint> {
    return this.client.getBalance({ address })
  }

  read<T = any>(functionName: string, args: unknown[] = []): Promise<T> {
    return this.client.readContract({
      address: this.config.chain.contract,
      abi: this.config.chain.abi as any,
      functionName,
      args,
    }) as Promise<T>
  }

  /** A wallet client per key, made once — signing is stateless, connecting is not. */
  walletFor(privateKey: `0x${string}`): WalletClient {
    const existing = this.wallets.get(privateKey)
    if (existing) return existing
    const account = privateKeyToAccount(privateKey)
    const wallet = createWalletClient({ account, chain: this.chain as any, transport: http(this.config.chain.rpcUrl) })
    this.wallets.set(privateKey, wallet)
    return wallet
  }

  /**
   * Sends a contract call, and treats a failed simulation as "not now".
   *
   * Every permissionless transition the keeper sends is guarded by the
   * contract, and that guard is exactly what a caller out here is guessing
   * at from a read taken a block ago. Simulating first means the common case
   * — nothing to do — costs no gas, and a revert is an ordinary answer
   * rather than an error: it almost always means somebody else got there
   * first, or the condition stopped holding in between.
   *
   * Returns the hash on success and null on anything else, because every
   * caller wants the same thing from a failure: carry on.
   */
  async trySend(
    privateKey: `0x${string}`,
    functionName: string,
    args: unknown[],
    label: string,
  ): Promise<`0x${string}` | null> {
    const wallet = this.walletFor(privateKey)
    const account = wallet.account as Account

    try {
      await this.client.simulateContract({
        address: this.config.chain.contract,
        abi: this.config.chain.abi as any,
        functionName,
        args,
        account,
      })
    } catch {
      return null
    }

    try {
      const hash = await wallet.writeContract({
        address: this.config.chain.contract,
        abi: this.config.chain.abi as any,
        functionName,
        args,
        account,
        chain: this.chain as any,
      })
      const receipt = await this.client.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') {
        this.logger.warn(`${label} reverted on chain (${hash})`)
        return null
      }
      this.logger.log(`${label} — ${hash}`)
      return hash
    } catch (error) {
      this.logger.warn(`${label}: ${String((error as Error)?.message ?? error).split('\n')[0]}`)
      return null
    }
  }

  /** Every lobby id the lens knows, oldest first. */
  async allLobbyIds(): Promise<`0x${string}`[]> {
    const ids: `0x${string}`[] = []
    const pageSize = 100n
    for (let offset = 0n; ; offset += pageSize) {
      const [page, total] = await this.read<[`0x${string}`[], bigint]>('getLobbyIds', [offset, pageSize])
      ids.push(...page)
      if (BigInt(ids.length) >= total || page.length === 0) break
    }
    return ids
  }
}

function short(error: unknown): string {
  return String((error as Error)?.message ?? error).split('\n')[0]
}
