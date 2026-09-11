import { useEffect } from 'react'
import type { BlockchainClient } from '../blockchain'
import { getConfiguredContractAddress } from '../contracts/addresses'
import { isProtocolOwnedLobby, isUnfilledPastDraw } from '../game/globalDefense'
import type { GlobalDefenseHudState } from './useGlobalDefenseDraw'
import { useBlockchainClient } from './useBlockchainClient'
import { useEpochClock } from './useEpochClock'
import { claimProtocolAutoAttempt } from '../blockchain/protocolAutoAttempt'
import { useWallet } from './useWallet'

interface KeeperCapable {
  maintain: (action: 'cancelLobby', lobbyId: string, from: `0x${string}`) => Promise<unknown>
}

function isKeeperCapable(client: BlockchainClient): client is BlockchainClient & KeeperCapable {
  return typeof (client as Partial<KeeperCapable>).maintain === 'function'
}

/**
 * Close a leftover Global Defense draw without waiting for someone to mint
 * a new operation.
 *
 * Ordinary writes (`create` / `join` / probe / defense / reveal) already
 * unwind an under-filled protocol room as a side effect. That still needs
 * a player who is *playing*. The trophy sits on every page, so a signed-in
 * session can send the same permissionless `cancelLobby` from here.
 *
 * A managed wallet signs silently — that is how a player who is only
 * looking at Home returns the jackpot. An external wallet is left alone
 * unless they already sat in that room: opening MetaMask on a passer-by
 * for a lobby they never opened is not a service.
 */
export function useGlobalDefenseKeeper(draw: GlobalDefenseHudState): void {
  const client = useBlockchainClient()
  const { address, walletKind } = useWallet()
  const { blockNumber } = useEpochClock()
  const lobby = draw.drawLobby
  const lobbyId = draw.drawLobbyId

  const involved =
    lobby !== null &&
    address !== null &&
    lobby.participantAddresses.some((participant) => participant.toLowerCase() === address.toLowerCase())
  const silent = walletKind === 'managed'
  const due =
    draw.ready &&
    lobby !== null &&
    lobbyId !== null &&
    isProtocolOwnedLobby(lobby.creator, getConfiguredContractAddress()) &&
    isUnfilledPastDraw(lobby, blockNumber, Date.now())

  useEffect(() => {
    if (!due || !lobbyId || !address || !isKeeperCapable(client)) return
    if (!involved && !silent) return
    if (!claimProtocolAutoAttempt(lobbyId, 'cancelLobby')) return

    void client.maintain('cancelLobby', lobbyId, address)
  }, [client, address, due, involved, silent, lobbyId])
}
