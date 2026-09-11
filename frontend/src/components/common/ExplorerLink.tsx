import type { ReactNode } from 'react'
import { getAddressUrl, getBlockUrl, getTxUrl, shortHash } from '../../utils/explorer'
import styles from './ExplorerLink.module.css'

/**
 * A value that can be looked up on the active network's explorer (ТЗ §12).
 *
 * One component for all three kinds of reference, because the decision it
 * makes is the same every time and is not a decision a caller should have
 * to repeat: if the active deployment has an explorer, this is a link; if
 * it does not — emulator mode, or a local node — it is plain text. A dead
 * link that says "view on explorer" and goes nowhere is worse than no link,
 * and the network is what decides which case you are in, not the component
 * using it.
 *
 * The URL itself always comes from `utils/explorer`, which reads the base
 * from the deployment manifest, so switching networks moves every link in
 * the app at once.
 */
export function ExplorerLink({
  kind,
  value,
  children,
  short = true,
  className,
}: {
  kind: 'tx' | 'block' | 'address'
  value: string | number | null | undefined
  children?: ReactNode
  /** Abbreviate a hash to `0x1234…cdef`. Ignored when `children` is given. */
  short?: boolean
  className?: string
}) {
  if (value === null || value === undefined || value === '') return <span className={className}>—</span>

  const href =
    kind === 'tx'
      ? getTxUrl(String(value))
      : kind === 'block'
        ? getBlockUrl(Number(value))
        : getAddressUrl(String(value))

  const label = children ?? (kind === 'block' ? String(value) : short ? shortHash(String(value)) : String(value))

  if (!href) {
    return <span className={[styles.plain, className].filter(Boolean).join(' ')}>{label}</span>
  }

  return (
    <a
      className={[styles.link, className].filter(Boolean).join(' ')}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={`View ${kind} on the block explorer`}
    >
      {label}
    </a>
  )
}
