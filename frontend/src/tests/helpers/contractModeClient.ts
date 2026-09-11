import { getAddress } from 'viem'
import type { EmulatorBlockchainClient } from '../../blockchain/EmulatorBlockchainClient'
import { readOwnPoint, writeOwnPoint } from '../../blockchain/contract/ownSecrets'
import type { BlockchainClient, ContractReadFunctionName } from '../../blockchain/types'
import type { Address, DefenseAttempt, DefensePoint, Hash, Lobby, Participant } from '../../game/types'

/**
 * The Operation screen as a player on a real chain meets it.
 *
 * The emulator reseals a Defense Point to its owner and keeps probe answers
 * in its own state, so a reload "just works" in emulator mode. Contract mode
 * has neither: the chain returns checksummed addresses, no sealed envelope,
 * and a probe answer that exists only as a confidential handle. This facade
 * is that gap, so the UI can be exercised against the semantics it actually
 * has to survive — without a live node or Inco.
 */
export function asContractMode(inner: EmulatorBlockchainClient): {
  client: BlockchainClient
  warmUps: Address[]
} {
  const warmUps: Address[] = []

  const facade: Record<string, unknown> = {
    get mode() {
      return 'contract' as const
    },
    warmUpConfidentialReads: async (from: Address) => {
      warmUps.push(from)
    },
    ensureConfidentialReads: async (from: Address) => {
      warmUps.push(from)
    },
    resolvePendingProbes: (lobbyId: Hash, attackId: string, from: Address) =>
      inner.resolvePendingProbes(lobbyId, attackId, from),
    countPendingProbes: () => 0,
    submitDefense: async (
      from: Address,
      params: { lobbyId: Hash; attackId: string; defensePoint: DefensePoint },
    ) => {
      const result = await inner.submitDefense(from, params)
      if (result.defensePoint) writeOwnPoint(params.attackId as Hash, from, result.defensePoint)
      return result
    },
    readContract: async (functionName: ContractReadFunctionName, args: never) => {
      const result = await inner.readContract(functionName, args)
      if (functionName === 'getDefenseAttempts') {
        const typed = args as { viewer: Address | null; attackId: string }
        return (result as DefenseAttempt[]).map((attempt) => ({
          ...attempt,
          participant: checksum(attempt.participant),
          sealedPoint: null,
          defensePoint:
            attempt.defensePoint ??
            (typed.viewer ? readOwnPoint(typed.attackId as Hash, typed.viewer) : null),
        }))
      }
      if (functionName === 'getLobbyParticipants') {
        return (result as Participant[]).map((participant) => ({
          ...participant,
          address: checksum(participant.address),
        }))
      }
      if (functionName === 'getLobby' && result) {
        const lobby = result as Lobby
        return {
          ...lobby,
          creator: checksum(lobby.creator),
          participantAddresses: lobby.participantAddresses.map(checksum),
        }
      }
      return result
    },
  }

  const client = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop in facade) return Reflect.get(facade, prop, receiver)
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? (value as (...args: never[]) => unknown).bind(target) : value
    },
  }) as unknown as BlockchainClient

  return { client, warmUps }
}

function checksum(address: string): Address {
  return getAddress(address) as Address
}
