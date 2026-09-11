import { useCallback, useEffect } from 'react'
import type { BlockchainClient } from '../blockchain'
import { buyDrone, createLobby, joinLobby, leaveLobby } from '../game/gameService'
import type { Address, Hash, Lobby, LobbyConfig } from '../game/types'
import { useBlockchainClient } from './useBlockchainClient'
import { useTxRunner } from './useTxRunner'
import { useWallet } from './useWallet'

/**
 * Contract mode. The emulator has no confidential network to authorise
 * against — it reads its own state directly — so there is nothing to warm up.
 */
function supportsWarmUp(
  client: BlockchainClient,
): client is BlockchainClient & { warmUpConfidentialReads: (from: Address) => Promise<void> } {
  return typeof (client as Partial<{ warmUpConfidentialReads: unknown }>).warmUpConfidentialReads === 'function'
}

/**
 * Contract mode again — the encryption side, which has its own cold start:
 * the provider SDK is imported on demand and its first proof pays for the
 * chunk and the WASM before it encrypts anything.
 */
function supportsWriteWarmUp(
  client: BlockchainClient,
): client is BlockchainClient & { warmUpConfidentialWrites: (from: Address) => Promise<void> } {
  return typeof (client as Partial<{ warmUpConfidentialWrites: unknown }>).warmUpConfidentialWrites === 'function'
}

function supportsEnsureSession(
  client: BlockchainClient,
): client is BlockchainClient & { ensureConfidentialReads: (from: Address) => Promise<void> } {
  return typeof (client as Partial<{ ensureConfidentialReads: unknown }>).ensureConfidentialReads === 'function'
}

/** Create/Join/Buy-drone actions, each with their own tx lifecycle state (spec §15, §17, §34). */
export function useLobbyActions() {
  const client = useBlockchainClient()
  const { address } = useWallet()

  const createAction = useCallback(
    async (config: LobbyConfig) => {
      if (!address) throw new Error('Sign in before creating a lobby.')
      const { lobby } = await createLobby(client, address, config)
      return lobby
    },
    [client, address],
  )

  const joinAction = useCallback(
    async (lobbyId: Hash, value: number) => {
      if (!address) throw new Error('Sign in before joining a lobby.')
      await joinLobby(client, address, lobbyId, value)
      /*
       * ТЗ §5 — the reading session, taken here rather than by the first
       * probe. Not awaited: the seat is already on chain, and holding Join
       * for the confidential grant left the button on "Join" for seconds
       * after the wallet confirmed. The grant still fires; a decline still
       * does not fail the join.
       */
      if (supportsEnsureSession(client)) void client.ensureConfidentialReads(address)
      else if (supportsWarmUp(client)) void client.warmUpConfidentialReads(address)
    },
    [client, address],
  )

  /**
   * ТЗ §5 — leaving before the operation starts, and the refund that comes
   * back with it. The amount is read off the chain's own `LobbyLeft` event
   * rather than recomputed here: what the protocol actually paid back is
   * the only figure worth showing a player.
   */
  const leaveAction = useCallback(
    async (lobbyId: Hash) => {
      if (!address) throw new Error('Sign in before leaving a lobby.')
      const { refunded } = await leaveLobby(client, address, lobbyId)
      return refunded
    },
    [client, address],
  )

  const buyDroneAction = useCallback(
    async (lobbyId: Hash, value: number) => {
      if (!address) throw new Error('Sign in before purchasing a probe.')
      await buyDrone(client, address, lobbyId, value)
    },
    [client, address],
  )

  const create = useTxRunner<[LobbyConfig], Lobby>(createAction)
  const join = useTxRunner<[Hash, number], void>(joinAction)
  const leave = useTxRunner<[Hash], number | null>(leaveAction)
  const buyDroneTx = useTxRunner<[Hash, number], void>(buyDroneAction)

  return { create, join, leave, buyDrone: buyDroneTx }
}

/**
 * Get this tab's confidential layer ready without opening the wallet:
 * restore a reading session it already granted, and load the encryption
 * side before anybody defends.
 *
 * Must not open the wallet. A defender returning to an operation they
 * joined is not asking to sign; the voucher lives in `sessionStorage` for
 * the tab, and a missing one waits for Join (already past) or the first
 * probe, which is a real action.
 */
export function useConfidentialWarmup(joined: boolean): void {
  const client = useBlockchainClient()
  const { address } = useWallet()

  useEffect(() => {
    if (!joined || !address) return
    if (supportsWarmUp(client)) void client.warmUpConfidentialReads(address)
    /*
     * The other half, and the reason this hook is not only about reads: a
     * defender's first encryption otherwise loads the provider SDK while
     * they are watching a threat close, with the wallet still shut. This
     * loads it now. It signs nothing — the prompt-bearing grant is
     * `ensureConfidentialReads`, which stays on Join.
     */
    if (supportsWriteWarmUp(client)) void client.warmUpConfidentialWrites(address)
  }, [client, joined, address])
}
