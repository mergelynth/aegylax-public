export function shortenHex(value: string, chars = 4): string {
  if (value.length <= chars * 2 + 2) return value
  return `${value.slice(0, chars + 2)}…${value.slice(-chars)}`
}

/**
 * An ETH amount, rounded for reading — but never rounded to nothing.
 *
 * The rounding is what makes a column of prices legible, and it has one
 * failure mode that matters: an amount small enough to vanish at
 * `maxDecimals` came back as "0 ETH". That is not a display detail when the
 * string sits on a Claim button or a prize tile — it tells somebody the
 * operation owes them nothing while the protocol is holding real money for
 * them, and it makes a genuinely empty amount indistinguishable from a tiny
 * one. So anything non-zero that would round away is shown with enough
 * precision to stay non-zero instead.
 */
export function formatEth(amount: number, maxDecimals = 4): string {
  return formatGameAmount(amount, 'ETH', maxDecimals)
}

/**
 * An amount labelled with the game's currency ticker (ETH today, USDC
 * later). Same rounding rules as `formatEth`: never round a real amount to
 * a displayed zero.
 */
export function formatGameAmount(amount: number, ticker: string, maxDecimals = 4): string {
  const decimals = amount !== 0 && Math.abs(amount) < 0.5 / 10 ** maxDecimals ? significantDecimals(amount) : maxDecimals
  const fixed = amount.toFixed(decimals)
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
  return `${trimmed} ${ticker}`
}

/** The numeric half of `formatGameAmount`, for layouts that paint the ticker separately. */
export function formatGameFigure(amount: number, maxDecimals = 4): string {
  const decimals = amount !== 0 && Math.abs(amount) < 0.5 / 10 ** maxDecimals ? significantDecimals(amount) : maxDecimals
  const fixed = amount.toFixed(decimals)
  return trimZeros(fixed)
}

/**
 * A figure that must stay compact — the settlement capsule, where a fifth
 * decimal would crowd the globe. Unlike `formatGameFigure` this never
 * expands past `maxDecimals`, even for dust.
 */
export function formatClaimFigure(amount: number, maxDecimals = 4): string {
  return trimZeros(amount.toFixed(maxDecimals))
}

export function formatClaimEth(amount: number, maxDecimals = 4): string {
  return `${formatClaimFigure(amount, maxDecimals)} ETH`
}

function trimZeros(fixed: string): string {
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

/** Decimals needed for the first significant digit of a sub-threshold amount, capped at wei. */
function significantDecimals(amount: number): number {
  return Math.min(18, Math.ceil(-Math.log10(Math.abs(amount))))
}

export function formatPercent(value: number): string {
  return `${value}%`
}

export function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return '00:00:00'
  const totalSeconds = Math.floor(msRemaining / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

export function formatBlockNumber(blockNumber: number | null): string {
  return blockNumber === null ? '—' : `#${blockNumber.toLocaleString()}`
}

export interface ApocalypseCountdown {
  years: number
  days: number
  time: string
}

/** Years/days-first breakdown for the Apocalypse Timer (spec §15) — reuses `formatCountdown` for the HH:MM:SS remainder. */
export function formatApocalypseCountdown(msRemaining: number): ApocalypseCountdown {
  if (msRemaining <= 0) return { years: 0, days: 0, time: '00:00:00' }
  const oneDayMs = 24 * 60 * 60 * 1000
  const totalDays = Math.floor(msRemaining / oneDayMs)
  const years = Math.floor(totalDays / 365)
  const days = totalDays % 365
  return { years, days, time: formatCountdown(msRemaining % oneDayMs) }
}

/**
 * One-line countdown that scales to whatever is left: "3y 145d 04:46:07",
 * "145d 04:46:07", or just "04:46:07". Shares the years/days breakdown
 * with the Apocalypse Timer so both read identically.
 */
export function formatLongCountdown(msRemaining: number): string {
  const { years, days, time } = formatApocalypseCountdown(msRemaining)
  if (years > 0) return `${years}y ${days}d ${time}`
  if (days > 0) return `${days}d ${time}`
  return time
}

const MONTH_ABBREVIATIONS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/**
 * A moment, split the way the deadline control draws it: `02 SEP 2026` and
 * `11:12`.
 *
 * Assembled rather than delegated to `toLocaleString`, for the same reason
 * ETH amounts are: the browser's locale would reorder the parts and
 * translate the month, and this string sits inside a fixed sci-fi layout
 * whose alignment assumes three letters and four digits. Local time
 * throughout, matching the `datetime-local` input it is drawn over.
 */
export function formatDeadlineParts(ms: number): { date: string; time: string } {
  // An unset or unparseable moment reads as absent, not as "NaN undefined NaN".
  if (!Number.isFinite(ms)) return { date: '—', time: '--:--' }
  const at = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    date: `${pad(at.getDate())} ${MONTH_ABBREVIATIONS[at.getMonth()]} ${at.getFullYear()}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  }
}

/** The same moment on one line, for the launch summary: `02 SEP · 11:12`. */
export function formatDeadlineShort(ms: number): string {
  const { date, time } = formatDeadlineParts(ms)
  return `${date.split(' ').slice(0, 2).join(' ')} · ${time}`
}
