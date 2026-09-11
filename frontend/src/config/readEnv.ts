/**
 * The primitive ENV readers shared by every config module.
 *
 * They live apart from `env.ts` for one reason: `config/auth.ts` needs the
 * same defaulting rules, and importing them from `env.ts` — which imports
 * the auth parser in turn — would make the two modules circular.
 */

export function readString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed ? trimmed : fallback
}

export function readOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function readNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function readOptionalNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Accepts the usual spellings of a flag; anything else falls back. */
export function readBoolean(value: string | undefined, fallback: boolean): boolean {
  const trimmed = value?.trim().toLowerCase()
  if (trimmed === undefined || trimmed === '') return fallback
  if (trimmed === 'true' || trimmed === '1' || trimmed === 'yes' || trimmed === 'on') return true
  if (trimmed === 'false' || trimmed === '0' || trimmed === 'no' || trimmed === 'off') return false
  return fallback
}

export function readTimestamp(value: string | undefined, fallbackIso: string): number {
  const trimmed = value?.trim()
  const parsed = Date.parse(trimmed ? trimmed : fallbackIso)
  return Number.isFinite(parsed) ? parsed : Date.parse(fallbackIso)
}

/**
 * Reads a comma-separated list, keeping only the entries the caller
 * recognises. An unknown entry is dropped rather than fatal: a typo in a
 * login method should cost that one method, not the whole sign-in screen.
 */
export function readEnumList<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: readonly T[],
): { values: T[]; unknown: string[] } {
  const raw = value?.trim()
  if (!raw) return { values: [...fallback], unknown: [] }

  const seen = new Set<T>()
  const unknown: string[] = []
  for (const entry of raw.split(',')) {
    const candidate = entry.trim().toLowerCase()
    if (!candidate) continue
    const match = allowed.find((option) => option === candidate)
    if (match) seen.add(match)
    else unknown.push(candidate)
  }

  return { values: seen.size > 0 ? [...seen] : [...fallback], unknown }
}
