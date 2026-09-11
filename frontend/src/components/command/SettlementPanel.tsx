import { useEffect, useRef, useState } from 'react'
import { animate } from 'motion/react'
import { BusySweep } from '../../motion/BusySweep'
import { prefersReducedMotion } from '../../motion/prefersReducedMotion'
import { formatClaimEth, formatClaimFigure } from '../../utils/format'
import { CommandHudChrome } from './CommandHudOrbit'
import { COMMAND_HUD_SKIN } from './hudSkin'
import styles from './CommandCenter.module.css'

/**
 * The named pieces a claim can be made of.
 *
 * `key` says which of the two settlement paths paid it; this says what is
 * actually in the sum, which is not the same question and was being
 * answered wrongly. A creator who watched their own operation get through
 * is owed the Creator Fee and nothing else — same `reward` key as a
 * winner's prize share, a completely different thing to call it. The rail
 * printed REWARD over 0.0001 ETH on a round the wallet had just lost.
 *
 *   prize  a winner's share of the pool
 *   fee    the Creator Fee, for filling the operation
 *   entry  a defender's stake, returned by a round that never ran
 *   pool   the prize pool a creator funded, returned the same way
 */
export type ClaimPart = 'prize' | 'fee' | 'entry' | 'pool'

/**
 * One thing the protocol owes this wallet, and the button that takes it.
 *
 * There are two of them and they are deliberately the same shape: a claim
 * from a round that ran (the prize pool, and for the author the Creator
 * Fee in the same sum — ТЗ §17, §14.6), and a refund from an operation
 * that never ran (§18). The button is always Claim / Claimed; what the
 * figure is lives next to the amount, not on the control.
 */
export interface ClaimItem {
  key: 'reward' | 'refund'
  /** What the sum is made of, in the order it should be named. */
  parts: ClaimPart[]
  /** Why this figure is owed — sits beside the amount, not on the button. */
  note: string
  amount: number
  claimed: boolean
  busy: boolean
  error: string | null
  onClaim: () => void
}

/**
 * The three states the Claim control itself can be in.
 *
 * `ready` — pressable. `awaiting` — the wallet is open or the write is in
 * flight, so a second press must not go out. `claimed` — already paid, and
 * permanently inert. Those are three looks on one button, not two disabled
 * states that happen to share a cursor.
 */
export type ClaimControlStatus = 'ready' | 'awaiting' | 'claimed'

/**
 * What is left to collect, when the operation is over.
 *
 * Same glass capsule as the Command Center, seated in the same slot on the
 * planet. Copy on the left, the figure on the right, Claim underneath. A
 * wallet or RPC failure sits above the glass — the same line Command Center
 * uses — and nowhere else.
 */
export function SettlementPanel({ claims }: { claims: ClaimItem[] }) {
  if (claims.length === 0) return null

  const failed = claims.find((claim) => claim.error)

  return (
    <section
      className={[styles.console, styles.rewardConsole, styles[COMMAND_HUD_SKIN]].join(' ')}
      aria-label="Payouts"
      data-hud={COMMAND_HUD_SKIN}
    >
      <CommandHudChrome />
      {failed?.error ? (
        <p className={[styles.notice, styles.noticeError].join(' ')} role="alert">
          {failed.error}
        </p>
      ) : null}
      <div className={styles.rewardBody}>
        {claims.map((claim) => (
          <ClaimRow key={claim.key} claim={claim} />
        ))}
      </div>
    </section>
  )
}

function ClaimRow({ claim }: { claim: ClaimItem }) {
  /*
   * Lock on the same press, before the parent has had a chance to mark
   * `busy`. Opening a wallet is slow enough that a second click otherwise
   * goes out while the control still looks live — and `busy` itself used
   * to drop the moment the write returned, a couple of seconds before the
   * lobby re-read landed as paid.
   */
  const [pressed, setPressed] = useState(false)
  const parentTookOver = useRef(false)

  useEffect(() => {
    if (claim.claimed) {
      parentTookOver.current = false
      setPressed(false)
      return
    }
    if (claim.busy) {
      parentTookOver.current = true
      return
    }
    if (parentTookOver.current || claim.error) {
      parentTookOver.current = false
      setPressed(false)
    }
  }, [claim.busy, claim.claimed, claim.error])

  const status: ClaimControlStatus = claim.claimed ? 'claimed' : claim.busy || pressed ? 'awaiting' : 'ready'

  return (
    <div className={[styles.rewardRow, status === 'claimed' ? styles.rewardSealed : ''].filter(Boolean).join(' ')}>
      <div className={styles.rewardTop}>
        <span className={styles.rewardNote} title={claim.note}>
          {claim.note}
        </span>
        <strong className={styles.rewardValue} aria-label={formatClaimEth(claim.amount)}>
          <ClaimFigure amount={claim.amount} />
          {' '}
          <span className={styles.rewardTicker}>ETH</span>
        </strong>
      </div>
      <span
        className={[
          styles.claimWrap,
          status === 'claimed' ? styles.claimSealed : '',
          status === 'awaiting' ? styles.claimAwaiting : '',
          status === 'ready' ? styles.claimPending : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <button
          type="button"
          className={styles.claimButton}
          onClick={() => {
            if (status !== 'ready') return
            setPressed(true)
            claim.onClaim()
          }}
          disabled={status !== 'ready'}
          aria-busy={status === 'awaiting'}
          title={status === 'claimed' ? 'This has already been paid out' : claim.note}
        >
          {status === 'claimed' ? 'Claimed' : 'Claim'}
          {/*
            The payout is being settled. This state used to be a dimmed
            button and a `cursor: progress` — the least visible wait in the
            product on the one control that spends the longest waiting. It
            waits the way everything else does now.
          */}
          {status === 'awaiting' ? <BusySweep /> : null}
        </button>
      </span>
    </div>
  )
}

/**
 * The figure, counted out the first time this wallet is shown what it is
 * owed.
 *
 * The panel appears when an operation resolves, and until this existed the
 * amount was simply *there* — the loudest number the product ever shows a
 * player, arriving with less ceremony than the epoch counter in the header.
 * Seven tenths of a second of the protocol adding it up is the whole effect,
 * and it is over before anybody who came to press Claim has reached the
 * button.
 *
 * Motion's `animate` rather than `motion/useCountUp`, and the difference is
 * not stylistic: that hook rounds to whole numbers, because everything it was
 * written for — epochs, operations, interceptions — is a count. This is
 * money, and 0.12 ETH rounded to an integer is a roll from zero to zero.
 *
 * Latched to the first non-zero amount. A claim's figure can be re-read from
 * the chain while the panel is open, and a number that runs up from zero
 * every time a poll returns the same value is a slot machine.
 */
function ClaimFigure({ amount }: { amount: number }) {
  const [shown, setShown] = useState(amount)
  const spent = useRef(false)

  useEffect(() => {
    if (spent.current || amount <= 0 || prefersReducedMotion()) {
      setShown(amount)
      return
    }

    spent.current = true
    const roll = animate(0, amount, {
      duration: 0.72,
      ease: [0.16, 0.84, 0.3, 1],
      onUpdate: setShown,
    })
    return () => roll.stop()
  }, [amount])

  return <span className={styles.rewardFigure}>{formatClaimFigure(shown)}</span>
}
