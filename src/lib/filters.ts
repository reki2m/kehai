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
      out.push({ start, end: start + 2.5 * 3600, label: 'NFP' })
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
    return { start, end: start + 2 * 3600, label: 'US CPI' }
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
    return { start, end: start + 6 * 3600, label: 'BoJ' }
  })
}

export function newsBlackout(unixSec: number): NewsWindow | null {
  for (const w of HIGH_IMPACT_NEWS) {
    if (unixSec >= w.start && unixSec < w.end) return w
  }
  return null
}

/**
 * Estimated USDJPY spread in pips by UTC hour + news.
 * Real Dukascopy mean ~0.6–1.2; spikes near rollover / news.
 */
export function estimateSpreadPips(unixSec: number, atrPips?: number): number {
  const hour = new Date(unixSec * 1000).getUTCHours()
  let spread = 0.7
  // Tokyo open quiet → London/NY more liquid
  if (hour >= 0 && hour < 7) spread = 1.1
  if (hour >= 21 || hour < 1) spread = 1.6 // rollover
  if (hour >= 7 && hour < 16) spread = 0.6
  if (hour >= 12 && hour < 17) spread = 0.55 // London–NY overlap
  if (newsBlackout(unixSec)) spread = Math.max(spread, 2.5)
  if (atrPips !== undefined && atrPips < 1.5) spread += 0.2 // thin range
  return spread
}

/** Skip entry when spread too wide for scalping. */
export const MAX_ENTRY_SPREAD_PIPS = 1.4
