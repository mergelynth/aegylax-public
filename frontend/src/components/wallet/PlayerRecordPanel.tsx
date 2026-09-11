import { motion, type Variants } from 'motion/react'
import { useCountUp } from '../../motion/useCountUp'
import { formatEth } from '../../utils/format'
import {
  hasHistory,
  moneyLostWei,
  moneyWonWei,
  usePlayerRecord,
  weiToEth,
} from '../../hooks/usePlayerRecord'
import styles from './PlayerRecordPanel.module.css'

/**
 * The player, shown to themselves: games played and won, money in and out.
 *
 * It lives inside the wallet panel because that is already the control that
 * means "you". Four tiles, two facts — how often, and how the money went.
 */
export function PlayerRecordPanel({ address }: { address: `0x${string}` }) {
  const { status, record, syncing } = usePlayerRecord(address)

  if (status === 'idle' || status === 'unavailable') return null

  if (status === 'loading' || !record) {
    return (
      <section className={styles.record}>
        <h3 className={styles.heading}>Your record</h3>
        <p className={styles.note}>Reading the log…</p>
      </section>
    )
  }

  const wonEth = weiToEth(moneyWonWei(record).toString())
  const lostEth = weiToEth(moneyLostWei(record).toString())

  return (
    <section className={styles.record}>
      <h3 className={styles.heading}>Your record</h3>

      {hasHistory(record) ? (
        <motion.div className={styles.bento} variants={BENTO} initial="hidden" animate="shown">
          <motion.div className={styles.tile} variants={TILE}>
            <span className={styles.label}>Played</span>
            <span className={styles.figure}>
              <Figure value={record.roundsPlayed} />
            </span>
          </motion.div>

          <motion.div className={styles.tile} variants={TILE}>
            <span className={styles.label}>Won</span>
            <span className={`${styles.figure} ${record.interceptions > 0 ? styles.lit : ''}`}>
              <Figure value={record.interceptions} />
            </span>
          </motion.div>

          <motion.div className={styles.tile} variants={TILE}>
            <span className={styles.label}>Winnings</span>
            <span className={`${styles.figure} ${styles.money} ${wonEth > 0 ? styles.lit : ''}`}>
              {formatEth(wonEth, 4)}
            </span>
          </motion.div>

          <motion.div className={styles.tile} variants={TILE}>
            <span className={styles.label}>Lost</span>
            <span className={`${styles.figure} ${styles.money} ${lostEth > 0 ? styles.lost : ''}`}>
              {formatEth(lostEth, 4)}
            </span>
          </motion.div>

          {record.recentRounds.length > 0 ? (
            <motion.div className={`${styles.tile} ${styles.wide} ${styles.formTile}`} variants={TILE}>
              <FormStrip rounds={record.recentRounds} />
            </motion.div>
          ) : null}
        </motion.div>
      ) : (
        <p className={styles.note}>
          {syncing
            ? 'Still reading the chain — anything you have played will appear here in a moment.'
            : 'Nothing yet. Join an operation and your record starts here.'}
        </p>
      )}
    </section>
  )
}

const BENTO: Variants = {
  hidden: {},
  shown: { transition: { staggerChildren: 0.055, delayChildren: 0.03 } },
}

const TILE: Variants = {
  hidden: { opacity: 0, y: 8 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.34, ease: [0.16, 0.84, 0.3, 1] } },
}

const STRIP: Variants = {
  hidden: {},
  shown: { transition: { delayChildren: 0.16, staggerChildren: 0.035 } },
}

const MARK: Variants = {
  hidden: { opacity: 0, scaleY: 0.3 },
  shown: { opacity: 1, scaleY: 1, transition: { duration: 0.26, ease: 'easeOut' } },
}

function Figure({ value }: { value: number }) {
  return <>{useCountUp(value, true)}</>
}

function FormStrip({ rounds }: { rounds: boolean[] }) {
  return (
    <motion.span
      className={styles.form}
      role="img"
      aria-label={`Last ${rounds.length} rounds: ${rounds.map((won) => (won ? 'won' : 'lost')).join(', ')}`}
      variants={STRIP}
    >
      {rounds.map((won, index) => (
        <motion.span key={index} className={`${styles.mark} ${won ? styles.markWon : ''}`} variants={MARK} />
      ))}
    </motion.span>
  )
}
