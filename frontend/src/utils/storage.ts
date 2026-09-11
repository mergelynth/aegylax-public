const PREFIX = 'aegylax:'

/**
 * Thin localStorage wrapper used for emulator identity/participation
 * persistence (spec §9). This is the only place that touches
 * `window.localStorage` directly.
 */
export function getStorageItem<T>(key: string): T | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(PREFIX + key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

export function setStorageItem<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value))
  } catch {
    // Best-effort persistence — ignore quota/availability errors.
  }
}

export function removeStorageItem(key: string): void {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(PREFIX + key)
}
