import { formatLongCountdown } from '../../utils/format'
import { ExplorerLink } from '../common/ExplorerLink'
import styles from './InterceptTimer.module.css'

export interface InterceptTimerProps {
  /** Time until the threat this operation is being built to meet, from `useOperationLaunchCountdown`. */
  msRemaining: number | null
  /** The epoch that threat flies in — always rendered as an estimate. */
  epochId: number | null
  /** First block of that epoch, linked so a creator can check it on the explorer. */
  launchBlock: number | null
}

/**
 * Which threat the operation being configured will go up against, and when
 * it arrives.
 *
 * **The sentence is the point.** This block used to say "ATTACK LAUNCH"
 * over a countdown, which put the creator on the wrong side of their own
 * game: it read as though pressing Launch scheduled an attack, when what it
 * actually does is commit a room of defenders to intercepting one the
 * protocol was always going to send. Nobody here is creating a threat. So
 * the readout is written as what the operation *does* — "this operation
 * intercepts epoch 482" — with the countdown as the arrival time rather
 * than the headline.
 *
 * It is also not "next attack". The protocol's next attack is a fact about
 * the protocol; this is a fact about the operation on the screen, and the
 * two are days apart for any ordinary deadline (see
 * `useOperationLaunchCountdown` for how the three protocol facts compose).
 *
 * The epoch leads and the clock follows, in that order, because that is the
 * order the sentence needs — and because the epoch is the durable half of
 * the answer: the seconds are an estimate off a measured block rate, the
 * epoch is what the contract will actually be told.
 *
 * Chrome-less on purpose. It reads like the console's own status lines —
 * type and light over the panel, no box — rather than the bordered,
 * drifting card it replaces, which competed with the dialog's title for the
 * top of the screen.
 *
 * There is no urgent state and no glow ramp, because neither can happen:
 * the launch cushion keeps at least 90% of an epoch between the deadline
 * and the threat, so this readout has a floor it never approaches zero
 * from. A ramp calibrated on a value that cannot arrive is decoration
 * pretending to be information.
 */
export function InterceptTimer({ msRemaining, epochId, launchBlock }: InterceptTimerProps) {
  const pending = msRemaining === null

  return (
    <div className={styles.block} data-state={pending ? 'pending' : 'scheduled'}>
      <span className={styles.label}>This operation intercepts</span>
      <span className={styles.readout}>
        {/*
          `≈` is load-bearing, exactly as it is on the Operation screen: the
          epoch is derived from a measured block rate, and block time is not
          a protocol guarantee (§20), so a deadline landing near a boundary
          can move this by one.
        */}
        <span className={styles.epoch}>
          {epochId === null ? (
            'Epoch —'
          ) : (
            <ExplorerLink kind="block" value={launchBlock}>{`≈ Epoch ${epochId}`}</ExplorerLink>
          )}
        </span>
        <span className={styles.value}>{pending ? '--:--:--' : formatLongCountdown(msRemaining)}</span>
      </span>
    </div>
  )
}
