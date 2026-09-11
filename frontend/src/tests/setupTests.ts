import { beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'

/**
 * Node's built-in (behind-a-flag) `localStorage` global shadows jsdom's
 * real implementation under Vitest, leaving `window.localStorage` an
 * empty, non-functional object (missing getItem/setItem/etc). Replace it
 * with a small working in-memory Storage so `utils/storage.ts` and any
 * test asserting on persistence behave the same as a real browser.
 */
class MemoryStorage implements Storage {
  private store = new Map<string, string>()

  get length(): number {
    return this.store.size
  }

  clear(): void {
    this.store.clear()
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null
  }

  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value))
  }
}

Object.defineProperty(window, 'localStorage', { value: new MemoryStorage(), writable: true, configurable: true })

/**
 * jsdom doesn't implement `matchMedia` at all. Components that check
 * `prefers-reduced-motion` (SpaceBackground's twinkle scheduler, Earth's
 * rotation) call it unconditionally, so without this stub any test that
 * mounts them throws "window.matchMedia is not a function".
 */
/**
 * jsdom's `document.hasFocus()` is false. The app treats an unfocused
 * window as hidden (two browsers open is otherwise two globes compositing),
 * so without this every test would mount into `data-hidden` and pause.
 */
Object.defineProperty(document, 'hasFocus', {
  configurable: true,
  writable: true,
  value: () => true,
})

Object.defineProperty(window, 'matchMedia', {
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
  writable: true,
  configurable: true,
})

/**
 * EmulatorBlockchainClient now persists its state to localStorage (spec
 * §9) so a page reload doesn't orphan a lobby. Without this, that
 * persistence would leak lobbies/participants across `it()` blocks that
 * construct their own client in the same test file.
 */
beforeEach(() => {
  window.localStorage.clear()
})
