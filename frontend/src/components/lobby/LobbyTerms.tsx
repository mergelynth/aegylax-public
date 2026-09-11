import type { Lobby } from '../../game/types'
import { calculateParticipantCost } from '../../game/economics'
import { isProtocolOwnedLobby } from '../../game/globalDefense'
import { getConfiguredContractAddress } from '../../contracts/addresses'
import { formatEth } from '../../utils/format'
import { TermsList } from '../common/TermsList'

/**
 * The operation's fixed configuration — the terms a visitor reads to decide
 * whether to join. Settled at creation and never changing afterwards, which
 * is exactly what separates it from the status block above it.
 *
 * This is now the *only* full read-back of an operation's terms. Create
 * Operation used to render the same list as a preview directly under the
 * form it duplicated, which ТЗ §11 removed: restating every parameter under
 * the controls still showing them read as an invoice, not a confirmation.
 * That dialog keeps a four-figure launch summary instead, and the complete
 * terms belong here — where somebody who did *not* configure the operation
 * is reading them to decide whether to join.
 */
export function OperationTerms({
  lobby,
  advertisedPrizePool,
}: {
  lobby: Lobby
  /** Protocol draw: the idle pile, until the round actually starts. */
  advertisedPrizePool?: number
}) {
  const { participation, economics } = lobby.config
  const startPrize = advertisedPrizePool ?? economics.prizePool

  return (
    <TermsList
      terms={[
        { label: 'Entry', value: formatEth(participation.entryPrice) },
        { label: 'Creator commission', value: `${economics.creatorFeePercent}%` },
        { label: 'Join total', value: formatEth(calculateParticipantCost(
          participation.entryPrice,
          economics.creatorFeePercent,
          isProtocolOwnedLobby(lobby.creator, getConfiguredContractAddress()),
        )) },
        { label: 'Protocol creation fee', value: `${formatEth(economics.protocolJoinFee)} · paid by creator` },
        { label: 'Min players', value: participation.minPlayers },
        { label: 'Max players', value: participation.maxPlayers },
        { label: 'Start prize pool', value: formatEth(startPrize) },
        { label: 'Application deadline', value: new Date(participation.deadline).toLocaleString() },
      ]}
    />
  )
}

/**
 * Recon Probe terms, kept out of `OperationTerms` because probes are their
 * own subsystem (spec §30-34) rather than another line of the entry
 * agreement. A joined player's own allotment sits on Buy probe — on the
 * hero while applications are open, and in this section once the round
 * has started. These lines are the protocol terms, not that allotment.
 */
export function ReconProbeTerms({ lobby }: { lobby: Lobby }) {
  const { drones } = lobby.config

  return (
    <TermsList
      terms={[
        { label: 'Free probes', value: drones.freeCount },
        { label: 'Maximum probes', value: drones.maxCount },
        { label: 'Probe price', value: formatEth(drones.price) },
      ]}
    />
  )
}
