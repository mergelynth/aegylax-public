import { create } from 'zustand'
import { sameSector } from '../game/map'
import type { DefensePoint, LobbyConfig, Sector } from '../game/types'
import { getStorageItem, setStorageItem } from '../utils/storage'

/**
 * UI-only client state (spec §53) — selections and modal visibility.
 * Authoritative game state (balances, winners, prize pools, attack state,
 * participant counts) never lives here; it always comes from the
 * blockchain abstraction via hooks.
 *
 * The Defense Point staging area below is the clearest case of that line:
 * a sector and a point live here for as long as the player is still
 * choosing, and the moment Send Defense fires they become chain state and
 * this copy stops mattering (ТЗ §9).
 */
/**
 * The parts of an operation's terms a caller may hand the Create dialog.
 *
 * Deliberately not `Partial<LobbyConfig>`: that is shallow, so it would
 * demand a whole `participation` block to set one field — and it would also
 * advertise `attack` and `payout`, which are protocol-owned and not the
 * creator's to choose. This names exactly the three groups the form edits.
 */
export interface LobbyConfigPrefill {
  name?: string
  participation?: Partial<LobbyConfig['participation']>
  economics?: Partial<LobbyConfig['economics']>
}

interface UiState {
  /** The sector the player has picked. First click of the two-step pick (ТЗ §8.1-8.2). */
  selectedSector: Sector | null
  /**
   * The Defense Point staged inside `selectedSector`, before submission.
   * At most one per sector by construction — placing again replaces it
   * (ТЗ §8.3).
   */
  stagedDefensePoint: DefensePoint | null
  selectedDroneId: string | null
  isCreateLobbyModalOpen: boolean
  /**
   * Terms to open the Create dialog on, instead of the blank template.
   *
   * The dialog normally opens on `buildDefaultLobbyConfig`, which fills
   * every protocol-derived field and deliberately leaves the name empty —
   * naming the operation is the creator's call. A caller that already knows
   * what the room should be can hand those fields over here.
   *
   * Null is the ordinary case and the reason this is a payload rather than
   * a prop: the dialog is mounted by `AppShell` from this flag, so whoever
   * opens it is never the component that renders it.
   */
  createLobbyPrefill: LobbyConfigPrefill | null
  /**
   * Whether the details drawer is open, **per operation**. Each operation
   * is its own screen with its own reason to want the drawer up or down,
   * so one global flag would make a choice on one of them silently change
   * every other. Missing key means "not decided here yet" — see
   * `selectLobbyPanelOpen`.
   */
  lobbyPanelOpen: LobbyPanelState
  selectSector: (sector: Sector) => void
  clearSelection: () => void
  setStagedDefensePoint: (point: DefensePoint) => void
  setSelectedDroneId: (droneId: string | null) => void
  openCreateLobbyModal: () => void
  /**
   * Opens it on terms somebody already has.
   *
   * A separate action rather than an optional argument to the one above,
   * because that one is passed straight to `onClick` in four places — and
   * an optional first parameter would quietly receive the click event as
   * its prefill.
   */
  openCreateLobbyModalWith: (prefill: LobbyConfigPrefill) => void
  closeCreateLobbyModal: () => void
  setLobbyPanelOpen: (lobbyId: string | null, open: boolean) => void
  toggleLobbyPanel: (lobbyId: string | null) => void
}

const LOBBY_PANEL_STORAGE_KEY = 'lobby-panel-open-by-lobby'

/**
 * How many operations' drawer states to keep. Old entries are dropped
 * oldest-first rather than accumulating forever — a player who opens
 * hundreds of operations should not slowly fill their storage with
 * booleans about ones they will never see again.
 */
const MAX_REMEMBERED_LOBBIES = 50

/** Operation id -> whether its drawer is open. Absent means never decided. */
export type LobbyPanelState = Record<string, boolean>

/**
 * The remembered drawer states, read once at store creation. After that
 * only the setters move them, and the setters are what write back.
 */
export function initialLobbyPanelState(): LobbyPanelState {
  return getStorageItem<LobbyPanelState>(LOBBY_PANEL_STORAGE_KEY) ?? {}
}

/**
 * Whether this operation's drawer is open.
 *
 * First visit on a wide screen: open, so the terms are there before the
 * playfield means anything. First visit on a compact screen: closed, so
 * the planet is not buried under the drawer. After that the choice is
 * remembered per operation.
 */
const COMPACT_LOBBY_PANEL = '(max-width: 720px), (hover: none) and (pointer: coarse)'

export function defaultLobbyPanelOpen(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return !window.matchMedia(COMPACT_LOBBY_PANEL).matches
}

export function selectLobbyPanelOpen(state: Pick<UiState, 'lobbyPanelOpen'>, lobbyId: string | null): boolean {
  if (!lobbyId) return defaultLobbyPanelOpen()
  return state.lobbyPanelOpen[lobbyId] ?? defaultLobbyPanelOpen()
}

/**
 * Records one operation's choice and writes the whole map through.
 *
 * Re-inserting an existing key keeps its original position, so the trim
 * below evicts by *first* decision rather than by most recent use. That is
 * a deliberate simplification: the cap only exists to bound storage, and
 * an exact LRU would need a second structure to track access order.
 */
function rememberLobbyPanel(current: LobbyPanelState, lobbyId: string, open: boolean): LobbyPanelState {
  const entries = Object.entries({ ...current, [lobbyId]: open })
  const next = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_REMEMBERED_LOBBIES)))
  setStorageItem(LOBBY_PANEL_STORAGE_KEY, next)
  return next
}

export const useUiStore = create<UiState>((set) => ({
  selectedSector: null,
  stagedDefensePoint: null,
  selectedDroneId: null,
  isCreateLobbyModalOpen: false,
  createLobbyPrefill: null,
  lobbyPanelOpen: initialLobbyPanelState(),

  /**
   * ТЗ §8.4: choosing a different sector discards the previous sector
   * *and* the point placed in it. Re-selecting the same sector is a no-op
   * rather than a reset, so a stray second click on the sector's own
   * chrome never wipes a point the player already placed.
   */
  selectSector: (sector) =>
    set((state) =>
      sameSector(state.selectedSector, sector)
        ? state
        : { selectedSector: sector, stagedDefensePoint: null },
    ),
  clearSelection: () => set({ selectedSector: null, stagedDefensePoint: null }),
  setStagedDefensePoint: (point) => set({ selectedSector: point.sector, stagedDefensePoint: point }),

  setSelectedDroneId: (droneId) => set({ selectedDroneId: droneId }),
  openCreateLobbyModal: () => set({ isCreateLobbyModalOpen: true, createLobbyPrefill: null }),
  openCreateLobbyModalWith: (prefill) => set({ isCreateLobbyModalOpen: true, createLobbyPrefill: prefill }),
  // The prefill is cleared with the dialog: it describes one opening of it,
  // not a standing preference, and leaving it behind would silently seed the
  // next creator's form with somebody else's terms.
  closeCreateLobbyModal: () => set({ isCreateLobbyModalOpen: false, createLobbyPrefill: null }),
  setLobbyPanelOpen: (lobbyId, open) =>
    set((state) =>
      lobbyId ? { lobbyPanelOpen: rememberLobbyPanel(state.lobbyPanelOpen, lobbyId, open) } : state,
    ),
  toggleLobbyPanel: (lobbyId) =>
    set((state) =>
      lobbyId
        ? {
            lobbyPanelOpen: rememberLobbyPanel(
              state.lobbyPanelOpen,
              lobbyId,
              !selectLobbyPanelOpen(state, lobbyId),
            ),
          }
        : state,
    ),
}))
