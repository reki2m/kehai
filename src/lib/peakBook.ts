/**
 * Peak Hunter book — Peak quality on every FX pair.
 * Target +30 pips/day; expected ~45 after correlation haircut.
 */

import { evaluateSimple, SIMPLE } from './simpleSignal'
import { fetchLiveCandles } from './liveRates'
import { getPair, PAIRS, type PairId } from './pairs'
import type { FxSession } from './apex'

export const BOOK_PAIR_IDS: PairId[] = PAIRS.filter((p) => p.kind === 'fx').map(
  (p) => p.id,
)

export interface BookSignal {
  pairId: PairId
  label: string
  side: 'BUY' | 'SELL'
  grade: string
  prime: boolean
  track: 'honmei' | 'day' | null
  sizeHint: number
  quality: number
  entryPrice: number | null
  stopPrice: number | null
  takeProfitPrice: number | null
  slPips: number
  tpPips: number
  reason: string
  sessionLabel: string | null
  at: number
}

export interface BookScanResult {
  signals: BookSignal[]
  scanned: number
  errors: Partial<Record<PairId, string>>
  at: number
}

/** Hunter book expected pace (uses correlation-haircut daily, not raw×pairs). */
export function expectedBookPace(): {
  tradesPerDay: number
  evPips: number
  dailyEdge: number
  pairs: number
} {
  const pairs = BOOK_PAIR_IDS.length
  return {
    tradesPerDay: SIMPLE.hunter.tradesPerDay,
    evPips: SIMPLE.verified.evPips,
    dailyEdge: SIMPLE.hunter.dailyPipsExpected,
    pairs,
  }
}

/**
 * Fetch live M1 for each FX pair and evaluate Peak Hunter.
 * Only surfaces actionable BUY/SELL (READY stays on the focused board).
 */
export async function scanPeakBook(
  disabledSessions: FxSession[] = [],
): Promise<BookScanResult> {
  const errors: Partial<Record<PairId, string>> = {}
  const signals: BookSignal[] = []
  const at = Math.floor(Date.now() / 1000)

  await Promise.all(
    BOOK_PAIR_IDS.map(async (id) => {
      try {
        const live = await fetchLiveCandles(id, '1m')
        if (live.candles.length < 80) {
          errors[id] = '足不足'
          return
        }
        const pair = getPair(id)
        const window =
          live.candles.length > 500
            ? live.candles.slice(-500)
            : live.candles
        const sig = evaluateSimple(window, pair, disabledSessions)
        if (sig.action !== 'BUY' && sig.action !== 'SELL') return
        signals.push({
          pairId: id,
          label: pair.label,
          side: sig.action,
          grade: sig.grade,
          prime: sig.prime,
          track: sig.track,
          sizeHint: sig.sizeHint,
          quality: sig.quality,
          entryPrice: sig.entryPrice,
          stopPrice: sig.stopPrice,
          takeProfitPrice: sig.takeProfitPrice,
          slPips: sig.slPips,
          tpPips: sig.tpPips,
          reason: sig.reason,
          sessionLabel: sig.sessionLabel,
          at,
        })
      } catch (e) {
        errors[id] = e instanceof Error ? e.message : '取得失敗'
      }
    }),
  )

  signals.sort((a, b) => {
    if (a.prime !== b.prime) return a.prime ? -1 : 1
    return b.quality - a.quality
  })

  return {
    signals,
    scanned: BOOK_PAIR_IDS.length,
    errors,
    at,
  }
}
