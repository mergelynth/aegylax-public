import type { ReactNode } from 'react'
import styles from './TermsList.module.css'

export interface Term {
  label: string
  value: ReactNode
}

export interface TermsListProps {
  terms: Term[]
  /** Names the block for assistive tech when it has no visible heading. */
  ariaLabel?: string
}

/**
 * A compact label/value read-back of an operation's terms.
 *
 * It reflows from two columns to one on its own, which is what lets the
 * same list sit in a wide panel and in the narrow details drawer.
 */
export function TermsList({ terms, ariaLabel }: TermsListProps) {
  return (
    // The section is what carries the name (a named section is a region an
    // assistive-tech user can jump to); the list inside it is what carries
    // the label/value pairing.
    <section aria-label={ariaLabel}>
      <dl className={styles.list}>
        {terms.map((term) => (
          <div key={term.label} className={styles.row}>
            <dt className={styles.label}>{term.label}</dt>
            <dd className={styles.value}>{term.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
