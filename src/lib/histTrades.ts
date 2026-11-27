/**
 * Simulate closed trades from historical entry signals + M1 candles.
 * Same ATR risk / max-hold / one-position rules as the live board.
 */

import { atr } from './indicators'
import type { Candle } from './marketData'
import type { PairMeta } from './pairs'
import { atrRiskPips, SIMPLE } from './simpleSignal'
import type { HistSignal } from './signalHistory'

export type HistExitReason = 'TP' | 'SL' | 'TIME' | 'GAP'

export interface HistTrade {
  entryTime: number
  exitTime: number
  side: 'BUY' | 'SELL'
  entry: number
  exit: number
  slPips: number
  tpPips: number
  pnlPips: number
  /** Size-weighted pips (デイ×0.5). */
  weightedPips: number
  reason: HistExitReason
  prime?: boolean
  grade?: HistSignal['grade']
  track?: HistSignal['track']
  sizeHint?: number
}

export interface HistTradeSummary {
  trades: HistTrade[]
  n: number
  wins: number
  losses: number
  winRate: number
  netPips: number
  /** Size-weighted net (本命1 · デイ0.5). */
  weightedNetPips: number
  evPips: number
  avgWin: number
  avgLoss: number
  /** Weekday trading days covered (JST). */
  days: number
  tradesPerDay: number
  honmeiN: number
  dayN: number
}

const SPREAD_PIPS = 0.2

function jstDay(t: number): string {
  return new Date(t * 1000).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Tokyo',
  })
}

/**
 * Walk candles with one position at a time. Entries come from hist signals
 * (already cooldown-filtered). Exit: ATR SL/TP, maxHoldBars, or session gap.
 */
export function simulateHistTrades(
  candles: Candle[],
  signals: HistSignal[],
  pair?: PairMeta,
): HistTradeSummary {
  const pip = pair?.pip ?? SIMPLE.pip
  const atrMap = new Map(atr(candles, 14).map((d) => [d.time, d.value]))
  const byTime = new Map(candles.map((c, i) => [c.time, i]))
  const sorted = [...signals].sort((a, b) => a.time - b.time)

  const trades: HistTrade[] = []
  let busyUntil = -1

  for (const sig of sorted) {
    const si = byTime.get(sig.time)
    if (si == null) continue
    if (si <= busyUntil) continue
    if (si + 1 >= candles.length) continue

    const atrVal = atrMap.get(sig.time) ?? 0
    const atrPips = atrVal > 0 ? atrVal / pip : 0
    const track = sig.track ?? (sig.prime ? 'honmei' : 'day')
    const sizeHint =
      sig.sizeHint ??
      (track === 'honmei' ? SIMPLE.honmeiSize : SIMPLE.daySize)
    const { sl, tp } = atrRiskPips(atrPips, track)
    const maxHold =
      track === 'day' ? SIMPLE.dayMaxHoldBars : SIMPLE.maxHoldBars
    const next = candles[si + 1]!
    const long = sig.side === 'BUY'
    const entry = long
      ? next.open + SPREAD_PIPS * pip * 0.5
      : next.open - SPREAD_PIPS * pip * 0.5
    const stop = long ? entry - sl * pip : entry + sl * pip
    const target = long ? entry + tp * pip : entry - tp * pip

    let exit = next.close
    let exitTime = next.time
    let reason: HistExitReason = 'TIME'
    let closed = false

    for (let j = si + 1; j < candles.length; j++) {
      const c = candles[j]!
      const prev = candles[j - 1]!
      const held = j - (si + 1)
      const gap = c.time - prev.time > 120
      const hitSl = long ? c.low <= stop : c.high >= stop
      const hitTp = long ? c.high >= target : c.low <= target

      if (gap) {
        exit = prev.close
        exitTime = prev.time
        reason = 'GAP'
        closed = true
        busyUntil = j - 1
        break
      }
      if (hitSl) {
        exit = stop
        exitTime = c.time
        reason = 'SL'
        closed = true
        busyUntil = j
        break
      }
      if (hitTp) {
        exit = target
        exitTime = c.time
        reason = 'TP'
        closed = true
        busyUntil = j
        break
      }
      if (held >= maxHold) {
        exit = c.close
        exitTime = c.time
        reason = 'TIME'
        closed = true
        busyUntil = j
        break
      }
    }

    if (!closed) {
      const last = candles[candles.length - 1]!
      exit = last.close
      exitTime = last.time
      reason = 'TIME'
      busyUntil = candles.length - 1
    }

    const raw = long ? (exit - entry) / pip : (entry - exit) / pip
    const pnlPips = Math.round((raw - SPREAD_PIPS) * 10) / 10
    const weightedPips = Math.round(pnlPips * sizeHint * 10) / 10
    trades.push({
      entryTime: next.time,
      exitTime,
      side: sig.side,
      entry,
      exit,
      slPips: sl,
      tpPips: tp,
      pnlPips,
      weightedPips,
      reason,
      prime: sig.prime,
      grade: sig.grade,
      track,
      sizeHint,
    })
  }

  const n = trades.length
  const wins = trades.filter((t) => t.pnlPips > 0).length
  const losses = n - wins
  const netPips =
    Math.round(trades.reduce((s, t) => s + t.pnlPips, 0) * 10) / 10
  const weightedNetPips =
    Math.round(trades.reduce((s, t) => s + t.weightedPips, 0) * 10) / 10
  const winList = trades.filter((t) => t.pnlPips > 0)
  const lossList = trades.filter((t) => t.pnlPips <= 0)
  const days = new Set(trades.map((t) => jstDay(t.entryTime))).size
  const dayCount = Math.max(1, days)

  return {
    trades,
    n,
    wins,
    losses,
    winRate: n ? Math.round((wins / n) * 1000) / 10 : 0,
    netPips,
    weightedNetPips,
    evPips: n ? Math.round((netPips / n) * 100) / 100 : 0,
    avgWin: winList.length
      ? Math.round(
          (winList.reduce((s, t) => s + t.pnlPips, 0) / winList.length) * 10,
        ) / 10
      : 0,
    avgLoss: lossList.length
      ? Math.round(
          (lossList.reduce((s, t) => s + t.pnlPips, 0) / lossList.length) * 10,
        ) / 10
      : 0,
    days: dayCount,
    tradesPerDay: Math.round((n / dayCount) * 10) / 10,
    honmeiN: trades.filter((t) => t.track === 'honmei').length,
    dayN: trades.filter((t) => t.track === 'day').length,
  }
}
