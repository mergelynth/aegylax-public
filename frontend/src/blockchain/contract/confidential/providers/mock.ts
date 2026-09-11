import { encodeAbiParameters, parseAbiParameters, type PublicClient } from 'viem'
import type { Address, Hash } from '../../../../game/types'
import type { AttestedValue, ConfidentialGateway, FetchAttestedOptions } from '../gateway'

/**
 * The local stand-in, paired with `MockConfidentialEngine`.
 *
 * It exists so the whole application — including reveal and winner
 * determination — can be run end to end against a local node with no
 * external service. It provides no confidentiality whatsoever, which is
 * true of the engine it talks to as well, and the deployment pipeline
 * refuses to point a public network at either without an explicit override.
 */
export class MockGateway implements ConfidentialGateway {
  readonly kind = 'mock'

  constructor(
    private readonly publicClient: PublicClient,
    private readonly engineAddress: Address,
  ) {}

  async encrypt(value: bigint): Promise<`0x${string}`> {
    return encodeAbiParameters(parseAbiParameters('uint256'), [value])
  }

  async decryptForOwner(handle: Hash, _account?: Address): Promise<bigint> {
    return this.peek(handle)
  }

  async fetchAttested(handles: Hash[], _options?: FetchAttestedOptions): Promise<AttestedValue[]> {
    const values = await Promise.all(handles.map((handle) => this.peek(handle)))
    return values.map((value) => ({ value, signatures: [] }))
  }

  private async peek(handle: Hash): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: this.engineAddress,
      abi: [
        {
          type: 'function',
          name: 'unsafePeek',
          stateMutability: 'view',
          inputs: [{ name: 'handle', type: 'bytes32' }],
          outputs: [{ name: '', type: 'uint256' }],
        },
      ],
      functionName: 'unsafePeek',
      args: [handle],
    })) as bigint
  }
}
