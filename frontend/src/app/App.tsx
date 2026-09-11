import { GuideApp, isGuidePath } from '../guide/GuideApp'
import { AppProviders } from './providers/AppProviders'
import { AppRoutes } from './routes'

/**
 * The application, or the tour of it.
 *
 * These are two roots rather than two routes, and the reason is structural:
 * the tour renders the real screens against a sandbox chain and has to give
 * them a router of their own, so that the address bar stays on `/guide`
 * while they navigate between the hero, the directory and a room. React
 * Router permits exactly one Router in a tree, so the tour cannot live
 * inside `AppProviders`' `BrowserRouter` — it has to replace it.
 *
 * The branch is read from `window.location` once, at mount, which is what
 * makes it safe: entering and leaving the tour are document loads (see
 * `GuideApp`), never client-side navigations, so there is no moment where
 * this decision is stale.
 */
export function App() {
  if (isGuidePath()) return <GuideApp />

  return (
    <AppProviders>
      <AppRoutes />
    </AppProviders>
  )
}
