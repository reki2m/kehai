/**
 * Trading costs & news filters for KEHAI Edge.
 * High-impact USD/JPY windows (NFP / CPI / FOMC / BoJ) — UTC.
 */

export interface NewsWindow {
  start: number // unix sec
  end: number
  label: string
}

/** Approximate / published high-impact windows 2024–2026 (UTC). */
export const HIGH_IMPACT_NEWS: NewsWindow[] = [
  // --- helper pattern: NFP first Fridays ~12:30–14:30 UTC (covers EST/EDT) ---
  ...nfpFridays(2024, 2026),
  // US CPI (selected published dates, ±45m around 12:30/13:30 UTC)
  ...cpiWindows(),
  // FOMC decision + presser blocks
  ...fomcWindows(),
  // BoJ MPM announcement windows (Tokyo midday, variable)
  ...bojWindows(),
]

function nfpFridays(y0: number, y1: number): NewsWindow[] {
  const out: NewsWindow[] = []
  for (let y = y0; y <= y1; y++) {
    for (let m = 0; m < 12; m++) {
      // first Friday
      const d = new Date(Date.UTC(y, m, 1))
      while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() + 1)
      const start = Date.UTC(y, m, d.getUTCDate(), 12, 0) / 1000
      out.push({ start, end: start + 2.5 * 3600, label: '米雇用統計' })
    }
  }
  return out
}

function cpiWindows(): NewsWindow[] {
  // Subset of known/typical mid-month CPI dates (ET 08:30 → UTC 12:30/13:30)
  const days = [
    // 2024
    '2024-01-11', '2024-02-13', '2024-03-12', '2024-04-10', '2024-05-15', '2024-06-12',
    '2024-07-11', '2024-08-14', '2024-09-11', '2024-10-10', '2024-11-13', '2024-12-11',
    // 2025 (BLS schedule)
    '2025-01-15', '2025-02-12', '2025-03-12', '2025-04-10', '2025-05-13', '2025-06-11',
    '2025-07-15', '2025-08-12', '2025-09-11', '2025-10-24', '2025-11-13', '2025-12-18',
    // 2026 (approx mid-month Wed/Thu)
    '2026-01-14', '2026-02-11', '2026-03-11', '2026-04-10', '2026-05-13', '2026-06-10',
    '2026-07-14', '2026-08-12', '2026-09-11', '2026-10-14', '2026-11-12', '2026-12-10',
  ]
  return days.map((iso) => {
    const [y, m, d] = iso.split('-').map(Number)
    const start = Date.UTC(y, m - 1, d, 12, 0) / 1000
    return { start, end: start + 2 * 3600, label: '米CPI' }
  })
}

function fomcWindows(): NewsWindow[] {
  const days = [
    // 2024
    '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18',
    '2024-11-07', '2024-12-18',
    // 2025
    '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17',
    '2025-10-29', '2025-12-10',
    // 2026 (Clearank)
    '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16',
    '2026-10-28', '2026-12-16',
  ]
  return days.map((iso) => {
    const [y, m, d] = iso.split('-').map(Number)
    const start = Date.UTC(y, m - 1, d, 17, 30) / 1000
    return { start, end: start + 3 * 3600, label: 'FOMC' }
  })
}

function bojWindows(): NewsWindow[] {
  const days = [
    '2024-01-23', '2024-03-19', '2024-04-26', '2024-06-14', '2024-07-31', '2024-09-20',
    '2024-10-31', '2024-12-19',
    '2025-01-24', '2025-03-19', '2025-05-01', '2025-06-17', '2025-07-31', '2025-09-19',
    '2025-10-30', '2025-12-19',
    '2026-01-23', '2026-03-19', '2026-04-28', '2026-06-18', '2026-07-31', '2026-09-18',
    '2026-10-30', '2026-12-18',
  ]
  return days.map((iso) => {
    const [y, m, d] = iso.split('-').map(Number)
    const start = Date.UTC(y, m - 1, d, 2, 0) / 1000
    return { start, end: start + 6 * 3600, label: '日銀' }
  })
}

export function newsBlackout(unixSec: number): NewsWindow | null {
  for (const w of HIGH_IMPACT_NEWS) {
    if (unixSec >= w.start && unixSec < w.end) return w
  }
  return null
}

/** User broker USDJPY scalp spread (pips). */
export const BROKER_SPREAD_PIPS = 0.2

/**
 * Estimated USDJPY spread in pips.
 * Default = broker 0.2; widen only on news / thin ATR.
 */
export function estimateSpreadPips(unixSec: number, atrPips?: number): number {
  let spread = BROKER_SPREAD_PIPS
  if (newsBlackout(unixSec)) spread = Math.max(spread, 1.5)
  if (atrPips !== undefined && atrPips < 1.2) spread = Math.max(spread, 0.35)
  return spread
}

/** Skip entry when spread too wide for scalping. */
export const MAX_ENTRY_SPREAD_PIPS = 0.35
