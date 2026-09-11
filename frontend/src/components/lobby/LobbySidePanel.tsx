import type { ReactNode } from 'react'
import styles from './LobbySidePanel.module.css'

export interface LobbySidePanelProps {
  open: boolean
  onToggle: () => void
  children: ReactNode
}

/**
 * Everything about an operation that isn't the scene itself: status,
 * controls, probes, participants, economics, activity. It slides in from
 * the side rather than stacking under the map, so the Operation screen
 * stays the same full-bleed space scene as Home (spec §10) instead of
 * turning back into a column of cards.
 *
 * The handle stays on screen in both states — it is the only way back to
 * the panel once it's closed, and it must never travel off the viewport
 * with it. It sits to the left of the body inside the same flex row, so
 * translating the row by exactly the body's width parks the body off screen
 * and leaves the handle at the edge.
 */
export function LobbySidePanel({ open, onToggle, children }: LobbySidePanelProps) {
  return (
    <div className={`${styles.panel} ${open ? styles.open : ''}`}>
      <button
        type="button"
        className={styles.handle}
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="operation-details"
      >
        <span className={styles.handleLabel}>Operation Details</span>
        {/*
          Which way pressing this moves the drawer, not which state it is in.
          The panel travels in from the right, so opening it pulls content
          leftwards and closing it pushes content back out to the right —
          the chevron points along that motion. Outside the vertical label
          on purpose: `writing-mode: vertical-rl` would rotate the glyph with
          the text and turn a left chevron into an upward one.
        */}
        <ChevronIcon className={`${styles.handleChevron} ${open ? styles.chevronOpen : ''}`} />
      </button>
      <aside
        id="operation-details"
        className={styles.body}
        data-guide="lobby-panel"
        aria-label="Operation details"
        inert={!open}
      >
        <div className={styles.content}>{children}</div>
      </aside>
    </div>
  )
}

/** A single chevron, pointing left; the open state flips it with a transform. */
function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M15 5.5 8.5 12l6.5 6.5" />
    </svg>
  )
}

/**
 * A titled block inside the panel. The title uses the product's label role
 * (see `--text-label` in globals.css), the same one the Defense Setup
 * fields use — a section name and a field name are the same kind of thing.
 */
export function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {children}
    </section>
  )
}
