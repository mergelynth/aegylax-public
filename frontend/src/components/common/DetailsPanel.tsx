import type { ReactNode } from 'react'
import styles from './DetailsPanel.module.css'

export interface DetailsPanelProps {
  title?: string
  children: ReactNode
}

/**
 * Collapsed-by-default technical/debug panel. Block numbers, tx hashes,
 * epoch internals, seeds, and other implementation detail belong here, not
 * in the main game UI — a regular player never needs to open it.
 */
export function DetailsPanel({ title = 'Details', children }: DetailsPanelProps) {
  return (
    <details className={styles.panel}>
      <summary className={styles.summary}>{title}</summary>
      <div className={styles.content}>{children}</div>
    </details>
  )
}
