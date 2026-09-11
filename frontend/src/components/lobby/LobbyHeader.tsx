import { useCallback, useEffect, useRef, useState } from 'react'
import { operationStatusLabel } from '../../game/lobbyPhase'
import type { Lobby } from '../../game/types'
import { shortenHex } from '../../utils/format'
import styles from './LobbyHeader.module.css'

/**
 * Lobby identity (spec §14, §16). The creator's name is what the operation
 * is called; the id — always the creation transaction hash — stays beneath
 * it as the thing that actually identifies it, since names are neither
 * unique nor addressable.
 *
 * Carries the same type treatment as the Home hero's title: one shell, one
 * title style (spec §10).
 */
export function LobbyHeader({ lobby }: { lobby: Lobby }) {
  return (
    <div className={styles.header}>
      <div className={styles.titleRow}>
        <h1 className={styles.name}>{lobby.config.name}</h1>
        {/*
          An operation is something you invite people to — a creator's first
          move after making one is to send the link. It belongs beside the
          name because the name is what they are sending.
        */}
        <ShareLinkButton />
      </div>
      <div className={styles.meta}>
        {/* Name and id are one string, never two elements. */}
        <span className={styles.id} title={lobby.id}>
          Operation {shortenHex(lobby.id)}
        </span>
        <span className={`${styles.status} ${styles[lobby.status.toLowerCase()] ?? ''}`}>
          {operationStatusLabel(lobby)}
        </span>
      </div>
    </div>
  )
}

/** How long the confirmation stays up after a successful copy. */
const COPIED_FEEDBACK_MS = 1800

/**
 * Copies this operation's URL to the clipboard and says so.
 *
 * The confirmation is the whole point: a copy leaves no trace anywhere on
 * screen, so without it the press is indistinguishable from a press that
 * silently failed — and clipboard writes *do* fail, on an insecure origin
 * or when permission is refused. Both outcomes are reported, in the same
 * place, so the button is never ambiguous.
 *
 * `window.location.href` rather than a URL rebuilt from the lobby id: what
 * a player wants to share is the page they are looking at.
 */
function ShareLinkButton() {
  const [feedback, setFeedback] = useState<'copied' | 'failed' | null>(null)
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timeout.current) clearTimeout(timeout.current) }, [])

  const announce = useCallback((next: 'copied' | 'failed') => {
    setFeedback(next)
    if (timeout.current) clearTimeout(timeout.current)
    timeout.current = setTimeout(() => setFeedback(null), COPIED_FEEDBACK_MS)
  }, [])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      announce('copied')
    } catch {
      announce('failed')
    }
  }, [announce])

  return (
    <span className={styles.share}>
      <button
        type="button"
        className={[styles.shareButton, feedback === 'copied' ? styles.shareButtonCopied : '']
          .filter(Boolean)
          .join(' ')}
        onClick={copy}
        aria-label={feedback === 'copied' ? 'Link copied' : 'Copy link to this operation'}
        title={feedback === 'copied' ? 'Link copied' : 'Copy link to this operation'}
      >
        <ShareIcon className={styles.shareIcon} />
        {feedback === 'copied' ? <CopiedMark className={styles.shareCopiedMark} /> : null}
      </button>
      <span
        className={[
          styles.shareToast,
          feedback ? styles.shareToastVisible : '',
          feedback === 'failed' ? styles.shareToastFailed : '',
        ]
          .filter(Boolean)
          .join(' ')}
        role="status"
        aria-live="polite"
      >
        {feedback === 'failed' ? 'Copy failed' : feedback === 'copied' ? 'Link copied' : ''}
      </span>
    </span>
  )
}

/** Tiny confirmation on the share control while the toast is up. */
function CopiedMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 12 12"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="6" cy="6" r="6" fill="currentColor" />
      <path
        d="M3.4 6.2 5.1 8l3.5-4.2"
        fill="none"
        style={{ stroke: 'var(--color-bg)' }}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Share — a node passing to two others, the standard reading of "send this on". */
function ShareIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="18" cy="5" r="2.6" />
      <circle cx="6" cy="12" r="2.6" />
      <circle cx="18" cy="19" r="2.6" />
      <path d="M8.3 10.8 15.7 6.7M8.3 13.2l7.4 4.1" />
    </svg>
  )
}
