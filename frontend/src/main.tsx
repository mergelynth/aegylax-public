import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { startBootSequence } from './app/bootSequence'
import { startVisibilityTracking } from './app/pageVisibility'
import './app/globals.css'
// The motion system (entrance + interaction) — see the file's own header.
import './app/motion.css'

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Root element #root not found')

/*
 * ТЗ §15 — arm the page-load entrance, before the first render rather than
 * after it, so the opening frame of the sequence is the first thing painted
 * instead of a flash of the finished screen.
 *
 * This file is the whole of "a document load": it runs on a reload, a hard
 * refresh and a fresh tab, and on nothing else — a client-side route change
 * never reaches it. That is what keeps Home -> How to Play -> Home from
 * replaying the sequence.
 */
startBootSequence()

/*
 * And arm the other document-level switch: whether anybody is looking.
 *
 * Before the first render for the same reason the entrance is — a document
 * that loads straight into a background tab must not play its whole opening
 * sequence to nobody. See `app/pageVisibility`.
 */
startVisibilityTracking()

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
