import type { ReactNode } from 'react'
import styles from './HowToPlay.module.css'

export interface StepCardProps {
  id: string
  index: string
  title: string
  /** One short line. If it needs two, it belongs in Advanced rules. */
  lead: string
  /** The mechanic that needs more room — FIND, on this page. */
  featured?: boolean
  children: ReactNode
}

export function StepCard({ id, index, title, lead, featured = false, children }: StepCardProps) {
  return (
    <section id={id} className={featured ? `${styles.step} ${styles.featured}` : styles.step}>
      <header className={styles.stepHead}>
        <span className={styles.stepIndex} aria-hidden="true">
          {index} —
        </span>
        <h3 className={styles.stepTitle}>{title}</h3>
      </header>
      <p className={styles.stepLead}>{lead}</p>
      {children}
    </section>
  )
}
