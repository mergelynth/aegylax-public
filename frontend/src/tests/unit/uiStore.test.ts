import { beforeEach, describe, expect, it } from 'vitest'
import { initialLobbyPanelState, selectLobbyPanelOpen, useUiStore } from '../../stores/uiStore'

const c2 = { column: 2, row: 1 }
const g4 = { column: 6, row: 3 }
const point = { sector: c2, offsetX: 0.3, offsetY: 0.6 }

beforeEach(() => {
  useUiStore.setState({ selectedSector: null, stagedDefensePoint: null })
})

describe('Defense Point staging (ТЗ §7)', () => {
  it('keeps the point when the same sector is picked again', () => {
    const store = useUiStore.getState()
    store.selectSector(c2)
    store.setStagedDefensePoint(point)
    useUiStore.getState().selectSector(c2)
    expect(useUiStore.getState().stagedDefensePoint).toEqual(point)
  })

  it('discards the sector and its point when a different sector is chosen (ТЗ §7.7-7.8)', () => {
    const store = useUiStore.getState()
    store.selectSector(c2)
    store.setStagedDefensePoint(point)
    useUiStore.getState().selectSector(g4)

    expect(useUiStore.getState().selectedSector).toEqual(g4)
    expect(useUiStore.getState().stagedDefensePoint).toBeNull()
  })

  it('replaces the point rather than accumulating, so a sector holds at most one (ТЗ §7.4, §7.6)', () => {
    const store = useUiStore.getState()
    store.selectSector(c2)
    store.setStagedDefensePoint(point)
    useUiStore.getState().setStagedDefensePoint({ sector: c2, offsetX: 0.9, offsetY: 0.1 })
    expect(useUiStore.getState().stagedDefensePoint).toEqual({ sector: c2, offsetX: 0.9, offsetY: 0.1 })
  })

  it('clears both together when the selection is dropped', () => {
    const store = useUiStore.getState()
    store.selectSector(c2)
    store.setStagedDefensePoint(point)
    useUiStore.getState().clearSelection()

    expect(useUiStore.getState().selectedSector).toBeNull()
    expect(useUiStore.getState().stagedDefensePoint).toBeNull()
  })
})

describe('recon (ТЗ §1.1)', () => {
  it('holds no targeting state at all — a probe is not aimed', () => {
    // The store deliberately has nowhere to put a probe target: ТЗ §1.1
    // removed the pick entirely, and a leftover slot for one would be an
    // invitation to reintroduce it.
    expect(useUiStore.getState()).not.toHaveProperty('isReconMode')
    expect(useUiStore.getState()).not.toHaveProperty('reconTargetSector')
  })
})

describe('the details drawer (remembered per operation)', () => {
  const LOBBY_A = '0xaaa'
  const LOBBY_B = '0xbbb'
  const STORAGE_KEY = 'aegylax:lobby-panel-open-by-lobby'

  const isOpen = (lobbyId: string) => selectLobbyPanelOpen(useUiStore.getState(), lobbyId)

  beforeEach(() => {
    window.localStorage.removeItem(STORAGE_KEY)
    useUiStore.setState({ lobbyPanelOpen: {} })
  })

  it('opens on a first visit to an operation nobody has decided about', () => {
    expect(isOpen(LOBBY_A)).toBe(true)
    expect(initialLobbyPanelState()).toEqual({})
  })

  it('stays closed on a first visit when the screen is compact', () => {
    const previous = window.matchMedia
    window.matchMedia = ((query: string) =>
      ({
        matches: true,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      })) as typeof window.matchMedia
    try {
      expect(selectLobbyPanelOpen({ lobbyPanelOpen: {} }, LOBBY_A)).toBe(false)
    } finally {
      window.matchMedia = previous
    }
  })

  it('keeps each operation’s choice to itself', () => {
    useUiStore.getState().toggleLobbyPanel(LOBBY_A)

    expect(isOpen(LOBBY_A)).toBe(false)
    // B was never decided, so it still gets the open default.
    expect(isOpen(LOBBY_B)).toBe(true)

    useUiStore.getState().toggleLobbyPanel(LOBBY_B)
    useUiStore.getState().toggleLobbyPanel(LOBBY_B)
    expect(isOpen(LOBBY_B)).toBe(true)
    // …and reopening B did not reopen A.
    expect(isOpen(LOBBY_A)).toBe(false)
  })

  it('survives a reload, per operation', () => {
    useUiStore.getState().toggleLobbyPanel(LOBBY_A)
    useUiStore.getState().setLobbyPanelOpen(LOBBY_B, true)

    // What a fresh page load would read back.
    const restored = initialLobbyPanelState()
    expect(restored).toEqual({ [LOBBY_A]: false, [LOBBY_B]: true })
    expect(selectLobbyPanelOpen({ lobbyPanelOpen: restored }, LOBBY_A)).toBe(false)
    expect(selectLobbyPanelOpen({ lobbyPanelOpen: restored }, LOBBY_B)).toBe(true)
  })

  it('records an explicit open too — the hero’s Defend button is a choice like any other', () => {
    useUiStore.getState().setLobbyPanelOpen(LOBBY_A, false)
    useUiStore.getState().setLobbyPanelOpen(LOBBY_A, true)
    expect(initialLobbyPanelState()).toEqual({ [LOBBY_A]: true })
  })

  it('does nothing without an operation to attribute the choice to', () => {
    useUiStore.getState().toggleLobbyPanel(null)
    expect(useUiStore.getState().lobbyPanelOpen).toEqual({})
    expect(selectLobbyPanelOpen(useUiStore.getState(), null)).toBe(true)
  })

  it('stops remembering the oldest operations rather than growing forever', () => {
    for (let i = 0; i < 60; i++) useUiStore.getState().setLobbyPanelOpen(`0x${i}`, false)

    const remembered = useUiStore.getState().lobbyPanelOpen
    expect(Object.keys(remembered)).toHaveLength(50)
    expect(remembered['0x0']).toBeUndefined()
    expect(remembered['0x59']).toBe(false)
  })
})
