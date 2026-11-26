/**
 * Peak Edge Book — same quality gates on every FX pair.
 * USDJPY Peak Edge ≈1.6/日 → 6FX book ≈9–10/日, EV kept at Peak Edge level.
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

/** Expected book pace from USDJPY Peak Edge × FX pair count. */
export function expectedBookPace(): {
  tradesPerDay: number
  evPips: number
  dailyEdge: number
  pairs: number
} {
  const pairs = BOOK_PAIR_IDS.length
  const tpd = Math.round(SIMPLE.verified.tradesPerDay * pairs * 10) / 10
  const daily =
    Math.round(SIMPLE.verified.tradesPerDay * SIMPLE.verified.evPips * pairs * 100) /
    100
  return {
    tradesPerDay: tpd,
    evPips: SIMPLE.verified.evPips,
    dailyEdge: daily,
    pairs,
  }
}

/**
 * Fetch live M1 for each FX pair and evaluate Peak Edge.
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
