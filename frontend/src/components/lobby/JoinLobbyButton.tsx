import { useCallback, useEffect, useRef, useState } from 'react'
import { getConfiguredContractAddress } from '../../contracts/addresses'
import { calculateParticipantCost } from '../../game/economics'
import { isProtocolOwnedLobby } from '../../game/globalDefense'
import { canJoinLobby } from '../../game/lobby'
import type { Lobby } from '../../game/types'
import { useEpochClock } from '../../hooks/useEpochClock'
import { useLobbyActions } from '../../hooks/useLobbyActions'
import { useWallet } from '../../hooks/useWallet'
import { formatEth } from '../../utils/format'
import { Button } from '../common/Button'
import styles from './JoinLobbyButton.module.css'

export interface JoinLobbyButtonProps {
  lobby: Lobby
  hasJoined: boolean
  onJoined: () => void
  /** Lets the caller place the button — e.g. as the hero's call to action. */
  className?: string
}

/** JOIN is only ever available while the lobby is OPEN and before its deadline (spec §17-18). */
export function JoinLobbyButton({ lobby, hasJoined, onJoined, className }: JoinLobbyButtonProps) {
  const { join } = useLobbyActions()
  const { isConnected, connect, status: walletStatus } = useWallet()
  // The block deadline is the one the contract enforces, so the control has
  // to be offered against the same clock it will be judged by.
  const { blockNumber } = useEpochClock()
  const [connectError, setConnectError] = useState<string | null>(null)
  const canJoin = canJoinLobby(lobby, Date.now(), blockNumber)
  const cost = calculateParticipantCost(
    lobby.config.participation.entryPrice,
    lobby.config.economics.creatorFeePercent,
    isProtocolOwnedLobby(lobby.creator, getConfiguredContractAddress()),
  )

  const [awaitingSeat, setAwaitingSeat] = useState(false)

  const submit = useCallback(async () => {
    setAwaitingSeat(true)
    const result = await join.run(lobby.id, cost)
    if (result === null) {
      setAwaitingSeat(false)
      return
    }
    onJoined()
  }, [join, lobby.id, cost, onJoined])

  useEffect(() => {
    if (hasJoined) setAwaitingSeat(false)
  }, [hasJoined])

  /**
   * Set while the visitor is signing in *because they pressed Join*.
   *
   * Same shape as Create Operation's, and for the same reason: signing in is
   * not on its own an instruction to spend money — somebody may sign in from
   * the header at any moment — so the resume has to know this particular
   * sign-in answered this particular press.
   */
  const resumeAfterConnect = useRef(false)

  /**
   * Pressed while the sign-in provider is still starting up.
   *
   * There is nothing to open yet — the SDK cannot accept a login until it
   * has restored its session, and asking it to is what used to make this
   * press do literally nothing. So the press is *taken* rather than
   * refused: the resume flag above is set, the button says it is waiting,
   * and the moment a wallet exists the effect finishes what was asked for.
   *
   * Kept separate from the ref because this one has to render. It clears
   * itself when the provider stops initializing, so a provider that fails
   * to come up at all returns the button to the player rather than leaving
   * it busy forever.
   */
  const [awaitingProvider, setAwaitingProvider] = useState(false)

  useEffect(() => {
    if (!isConnected || !resumeAfterConnect.current) return
    resumeAfterConnect.current = false
    void submit()
  }, [isConnected, submit])

  useEffect(() => {
    if (walletStatus !== 'initializing') setAwaitingProvider(false)
  }, [walletStatus])

  /*
   * Every early return lives below the hooks, not above them: React counts
   * hooks per render, and a lobby that stops being joinable while this is on
   * screen would otherwise change that count mid-life.
   */
  if (hasJoined) return null
  if (!canJoin) return null

  /**
   * Press, and what a signed-out visitor gets.
   *
   * This is the app's primary call to action and it used to answer them with
   * "Sign in before joining a lobby." — a refusal printed under a
   * button, on a screen with no way to act on it. Joining *is* the intent, so
   * the press opens sign-in and the effect above finishes the join once the
   * session lands.
   */
  const handleJoin = async () => {
    if (!isConnected) {
      resumeAfterConnect.current = true
      setConnectError(null)

      // Nothing to open yet — wait for the provider instead of pressing a
      // button that cannot answer. The resume above finishes the join.
      if (walletStatus === 'initializing') {
        setAwaitingProvider(true)
        return
      }

      try {
        await connect()
      } catch (err) {
        resumeAfterConnect.current = false
        setConnectError(err instanceof Error ? err.message : String(err))
      }
      return
    }
    await submit()
  }

  const isJoining =
    awaitingSeat ||
    join.status === 'preparing' ||
    join.status === 'pending' ||
    join.status === 'confirmed'

  return (
    <div className={styles.wrap} data-guide="join-button">
      <Button
        variant="primary"
        className={className}
        onClick={handleJoin}
        activity={
          isJoining || awaitingProvider ? 'busy' : join.status === 'confirmed' ? 'success' : 'idle'
        }
        /* ТЗ §9 — same waits as Launch Operation, same words for them: the
           provider coming up, then building the transaction, then the
           confirmation.

           None of them name a wallet. A player who signed in with an email
           has one, but never sees it: Privy signs for them, so "Confirm in
           wallet" described a prompt that was never going to appear and sent
           them looking for an extension they had not installed. "Confirming"
           is true of both paths — and of the phase this actually is, which is
           the transaction being confirmed by the chain rather than by a
           person. The header settled the same question the same way: it says
           "Sign in" in every configuration. */
        busyLabel={
          awaitingProvider
            ? 'Waiting for sign-in'
            : join.status === 'pending'
              ? 'Confirming'
              : join.status === 'confirmed' || awaitingSeat
                ? 'Joining'
                : 'Preparing'
        }
      >
        {/* Reads as the counterpart to Home's "Create Operation", and names
            the same object the rest of this screen does — the header, the
            status line and "Leave" underneath it. It used to say
            Join Defense, which asked a player to join one noun and leave
            another. What it costs is on the line directly above it, and
            broken down in full under Operation in the details drawer. */}
        Join Operation · {cost === 0 ? 'Free' : formatEth(cost)}
      </Button>
      {/*
        Why the join did not happen, under the control that was pressed.
        The hook has always had this; nothing rendered it, so a refused join
        was indistinguishable from a dead button — and on a public RPC the
        commonest refusal is not the player's fault at all (the write
        simulates before it is signed, so an endpoint answering 403 fails
        the press before a wallet ever opens).
      */}
      {(join.error ?? connectError) ? (
        <p className={styles.error} role="alert">
          {join.error ?? connectError}
        </p>
      ) : null}
    </div>
  )
}
