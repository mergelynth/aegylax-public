/**
 * The chain tooling under `tools/` is plain ESM JavaScript, written to run
 * without a build step. The backend reaches into exactly one of those
 * modules — the confidential client, which is far too much protocol
 * knowledge to duplicate — so this is the shape of that one door rather
 * than an invitation to widen it.
 */
declare module '*/confidential-client.mjs' {
  export function connectConfidential(options: {
    manifest: Record<string, unknown>
    chainId: number
    rpcUrl: string
    publicClient: unknown
  }): Promise<{
    label: string
    fetchAttested(handles: string[], options?: { attempts?: number; delayMs?: number }): Promise<unknown[]>
    decryptForOwner(walletClient: unknown, handle: string, options?: Record<string, unknown>): Promise<bigint>
    encrypt(value: bigint, walletClient: unknown): Promise<`0x${string}`>
  }>
}
