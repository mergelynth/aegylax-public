import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { EarthSpaceViewport } from '../components/earth/EarthSpaceViewport'
import { SpaceHero } from '../components/home/SpaceHero'
import { ApocalypseTimer } from '../components/stats/ApocalypseTimer'
import { useUiStore } from '../stores/uiStore'

/** Lands on Home with the Create dialog already open: `/?create=1`. */
export const CREATE_QUERY_PARAM = 'create'

/**
 * Opens the Create dialog when the URL asks for it.
 *
 * There is one caller today — the guided tour's last step, which finishes
 * by handing somebody back to the product at the exact thing it spent
 * fifteen screens explaining. It cannot simply set the store, because
 * leaving the tour is a document load and nothing in memory survives it.
 *
 * The parameter is stripped immediately, and with `replace` so it does not
 * become a history entry. Otherwise Back would land here and reopen the
 * dialog somebody had just closed, and a copied URL would carry the dialog
 * to whoever it was sent to.
 */
function useCreateFromQuery() {
  const [params, setParams] = useSearchParams()
  const openCreateLobbyModal = useUiStore((state) => state.openCreateLobbyModal)

  useEffect(() => {
    if (!params.has(CREATE_QUERY_PARAM)) return

    openCreateLobbyModal()
    const next = new URLSearchParams(params)
    next.delete(CREATE_QUERY_PARAM)
    setParams(next, { replace: true })
  }, [params, setParams, openCreateLobbyModal])
}

/**
 * HOME state of the single main application screen (spec §1-4, §19). Pure
 * space scene — stars + Earth + hero copy only. No sector grid, no stats
 * panel, no technical details here; those live in the Header (spec §6) and
 * inside an Operation (spec §12, §14) respectively. The event-horizon
 * countdown (`ApocalypseTimer`) renders here rather than in the header,
 * positioned over Earth by its own CSS — it's the planet's countdown.
 */
export function HomePage() {
  useCreateFromQuery()

  return (
    <EarthSpaceViewport variant="hero">
      <SpaceHero />
      <ApocalypseTimer />
    </EarthSpaceViewport>
  )
}
