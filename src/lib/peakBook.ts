/**
 * Day Desk scanner across FX pairs.
 * Surfaces live 本命/デイ BUY·SELL so the desk stays active.
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

/** Single-pair Day Desk pace (本命+デイ). Book is optional multi-pair scan. */
export function expectedBookPace(): {
  tradesPerDay: number
  evPips: number
  dailyEdge: number
  pairs: number
} {
  return {
    tradesPerDay: SIMPLE.dayDesk.tradesPerDay,
    evPips: SIMPLE.verified.evPips,
    dailyEdge:
      Math.round(
        SIMPLE.dayDesk.honmeiPerDay * SIMPLE.verified.evPips * 100,
      ) / 100,
    pairs: BOOK_PAIR_IDS.length,
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
