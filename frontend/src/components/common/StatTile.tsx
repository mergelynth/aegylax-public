import type { ReactNode } from 'react'
import styles from './StatTile.module.css'

export function StatTile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.tile}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
    </div>
  )
}
