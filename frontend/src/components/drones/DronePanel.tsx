import { useIncrease } from '../../motion/useIncrease'
import type { Lobby, Participant } from '../../game/types'
import { formatEth } from '../../utils/format'
import { Button } from '../common/Button'
import styles from './DronePanel.module.css'

export interface DronePanelProps {
  lobby: Lobby
  participant: Participant | null
  onBuyDrone: () => void
  isPurchasing: boolean
  /**
   * Why buying is closed right now, or null when it is open.
   *
   * A reason rather than a boolean, for the same reason the Recon and
   * Defense controls take one: "the attack has launched" and "you already
   * have the maximum" are different facts, and a button that only goes grey
   * makes the player guess which.
   */
  blockedReason: string | null
  /** A purchase that failed, reported next to the control that caused it. */
  error?: string | null
  /**
   * `hero` is the pulsing CTA above Leave, while applications are open.
   * `drawer` is the compact row in the details panel — the one that stays
   * reachable after the round has started and the hero has gone, for as
   * long as the attack itself has not launched.
   */
  layout?: 'hero' | 'drawer'
}

/**
 * Buy another Recon Probe (spec §30, §34).
 *
 * Two surfaces, one action. The hero sits above Leave while the operation
 * is still taking applications. The drawer row is what remains after the
 * round has started and the hero has gone — probes are still equipment
 * until the attack launches, and a count buried nowhere is a purchase
 * nobody can make. The button breathes the same ring as Home's Create
 * Operation on the hero, for as long as a purchase can still land.
 *
 * "Recon Probe" is the protocol's user-facing name for the unit the domain
 * model still calls a drone (`LobbyConfig.drones`).
 */
export function DronePanel({
  lobby,
  participant,
  onBuyDrone,
  isPurchasing,
  blockedReason,
  error,
  layout = 'hero',
}: DronePanelProps) {
  const freeCount = lobby.config.drones.freeCount
  const purchased = participant?.purchasedDrones ?? 0
  const ownedTotal = freeCount + purchased
  const remaining = Math.max(0, ownedTotal - (participant?.probeIds.length ?? 0))
  const maxCount = lobby.config.drones.maxCount
  /*
   * A purchase settling on chain. The button says "Purchasing…" for as long
   * as the write is in flight and then goes back to its resting label — and
   * until this existed, that was the only sign anything had happened: the
   * probe you paid for arrived as a digit that was one higher than the digit
   * before it, in a line nobody was looking at. The count now lights when the
   * allotment grows, which is the moment the money turned into a probe.
   */
  const arrived = useIncrease(ownedTotal)
  const price = formatEth(lobby.config.drones.price)
  const action = isPurchasing ? 'Purchasing…' : `Buy probe ${price}`
  const canBuy = blockedReason === null && !isPurchasing
  const blockedId = `recon-purchase-blocked-${layout}`

  if (layout === 'drawer') {
    return (
      <div className={styles.row}>
        <div className={styles.counts}>
          <span className={styles.title}>Your probes</span>
          <span key={arrived} className={`${styles.reading} ${arrived > 0 ? styles.counted : ''}`}>
            {remaining} ready · {ownedTotal}/{maxCount}
          </span>
          <span className={styles.sub}>
            {freeCount} free{purchased > 0 ? ` + ${purchased} bought` : ''}
          </span>
        </div>
        <Button
          size="small"
          variant="primary"
          className={styles.drawerBuy}
          onClick={onBuyDrone}
          disabled={blockedReason !== null}
          activity={isPurchasing ? 'busy' : 'idle'}
          busyLabel="Purchasing…"
          title={blockedReason ?? undefined}
          aria-describedby={blockedReason ? blockedId : undefined}
        >
          {action}
        </Button>
        {blockedReason ? (
          <span id={blockedId} className={styles.drawerBlocked} role="note">
            {blockedReason}
          </span>
        ) : null}
        {error ? (
          <span className={styles.drawerError} role="alert">
            {error}
          </span>
        ) : null}
      </div>
    )
  }

  const count = (
    <span className={`${styles.chip} ${arrived > 0 ? styles.counted : ''}`} key={arrived}>
      <span className={styles.have}>{remaining}</span>
      <span className={styles.cap}>/{maxCount}</span>
    </span>
  )

  return (
    <div className={styles.wrap} data-guide="buy-probe">
      <Button
        variant="primary"
        className={styles.buyButton}
        data-invite={canBuy ? 'on' : 'off'}
        onClick={onBuyDrone}
        disabled={blockedReason !== null}
        activity={isPurchasing ? 'busy' : 'idle'}
        busyLabel={
          <>
            {count}
            {action}
          </>
        }
        aria-label={`${action}, ${remaining} ready`}
        // The reason is the button's own accessible description rather than
        // a line of text under a control that is usually enabled, which
        // reads as an error the player has done something to cause.
        title={blockedReason ?? undefined}
        aria-describedby={blockedReason ? blockedId : undefined}
      >
        {count}
        {action}
      </Button>
      {blockedReason ? (
        <span id={blockedId} className={styles.blocked} role="note">
          {blockedReason}
        </span>
      ) : null}
      {error ? (
        <span className={styles.error} role="alert">
          {error}
        </span>
      ) : null}
    </div>
  )
}
