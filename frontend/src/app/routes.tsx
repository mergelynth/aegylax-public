import { lazy, Suspense, useEffect } from 'react'
import { Outlet, Route, Routes } from 'react-router-dom'
import { AppShell } from '../components/layout/AppShell'
import { HomePage } from '../pages/HomePage'

/**
 * Home is the only screen that has to exist before anything is pressed, so
 * it is the only one in the entry bundle.
 *
 * The other three are `lazy`, and the reason is arithmetic rather than
 * taste: an operation screen carries the sector grid, the command centre
 * and the reveal, and a visitor landing on the hero pays for all of it
 * before the heading can paint. They are fetched on the first navigation —
 * and, in practice, before it (see `usePrefetchRoutes`).
 */
const DocsPage = lazy(async () => ({ default: (await import('../pages/DocsPage')).DocsPage }))
const OperationsPage = lazy(async () => ({ default: (await import('../pages/OperationsPage')).OperationsPage }))
const LobbyPage = lazy(async () => ({ default: (await import('../pages/LobbyPage')).LobbyPage }))
const RailPreviewPage = import.meta.env.DEV
  ? lazy(async () => ({ default: (await import('../pages/dev/RailPreviewPage')).RailPreviewPage }))
  : null
const ReconPreviewPage = import.meta.env.DEV
  ? lazy(async () => ({ default: (await import('../pages/dev/ReconPreviewPage')).ReconPreviewPage }))
  : null

/**
 * The other screens, fetched while nobody is waiting for them.
 *
 * A code split that a navigation has to wait for trades a slow first paint
 * for a blank moment on every click, which is the wrong half of the deal.
 * `requestIdleCallback` closes it: the browser has finished the entrance
 * animation and is doing nothing, and the two or three chunks land before
 * anybody has decided where to go. If the API is missing (Safari before
 * 17), a short timeout stands in — the cost of being wrong here is one
 * prefetch that happens 400ms later than it might have.
 *
 * Deliberately not on hover: the primary way into an operation is a link in
 * the hero, and a pointer is not a promise. Idle time is.
 */
function usePrefetchRoutes() {
  useEffect(() => {
    const prefetch = () => {
      void import('../pages/DocsPage')
      void import('../pages/OperationsPage')
      void import('../pages/LobbyPage')
    }

    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(prefetch, { timeout: 3000 })
      return () => window.cancelIdleCallback?.(handle)
    }

    const timer = window.setTimeout(prefetch, 1200)
    return () => window.clearTimeout(timer)
  }, [])
}

function Layout() {
  usePrefetchRoutes()

  return (
    <AppShell>
      {/*
        The boundary is here rather than around the whole shell: the header,
        the wallet and the protocol status are the same on every screen and
        must not blink when one of them is swapped. `null` rather than a
        spinner — the chunks are a few tens of kilobytes on the same origin,
        and a flash of loading state costs more than it explains.
      */}
      <Suspense fallback={null}>
        <Outlet />
      </Suspense>
    </AppShell>
  )
}

/**
 * One shell (spec §10): home, how-to-play, the directory, and the operation
 * screen. `/operations` is the way in for somebody who has not been handed a
 * link — see `OperationDirectory`.
 *
 * `/guide` is not here at all. The guided tour is a second application root
 * with a router of its own — see `App` — because it has to give the real
 * screens a history that is not the window's, and React Router allows
 * exactly one Router per tree.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="/operations" element={<OperationsPage />} />
        <Route path="/lobby/:id" element={<LobbyPage />} />
        {RailPreviewPage ? <Route path="/dev/rail" element={<RailPreviewPage />} /> : null}
        {ReconPreviewPage ? <Route path="/dev/recon" element={<ReconPreviewPage />} /> : null}
        <Route path="*" element={<HomePage />} />
      </Route>
    </Routes>
  )
}
