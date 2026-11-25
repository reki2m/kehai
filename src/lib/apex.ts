import {
  estimateSpreadPips,
  newsBlackout,
} from './filters'
import type { Candle } from './marketData'
import { atr, ema, rsi, sessionVwap } from './indicators'
import type { Bias, IndicatorSignal } from './signals'

/**
 * KEHAI Apex WinEdge Freq — 1m scalp with higher trade rate.
 *
 * Locked under: Dukascopy real spread WF both halves > 0,
 * Yahoo full + holdout > 0 (session-spread model).
 * ~2.9 trades/day on Duka session days (was ~1.5 on prior mid-strict lock).
 */
export const APEX_PARAMS = {
  family: 'micro_mom' as const,
  kz: 'london' as const,
  hourMode: 'london_mid' as const, // 08:30–10:00 UTC
  maxSpread: 0.8,
  slPips: 3.0,
  tpPips: 6.0,
  minAtrPips: 1.0,
  maxAtrPips: 12.0,
  minMovePips: 3.0,
  requireVwap: true,
  requireBias: false,
  rsiFilter: true,
  pip: 0.01,
} as const

export type TradeAction = 'LONG' | 'SHORT' | 'WAIT'

export interface ApexGate {
  id: string
  name: string
  ok: boolean
  detail: string
}

export interface ApexSignal {
  score: number
  bias: Bias
  label: string
  signals: IndicatorSignal[]
  action: TradeAction
  gates: ApexGate[]
  atr: number
  stopDistance: number
  takeProfitDistance: number
  sessionOpen: boolean
  spreadPips: number
  newsLabel: string | null
  family: string
  setup: string | null
}

function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1]
}

function utcHm(unixSec: number) {
  const d = new Date(unixSec * 1000)
  return {
    weekday: d.getUTCDay(),
    hm: d.getUTCHours() * 60 + d.getUTCMinutes(),
  }
}

/** Entry window: London mid 08:30–10:00 UTC. */
export function isEntryWindow(unixSec: number): boolean {
  const { weekday, hm } = utcHm(unixSec)
  if (weekday === 0 || weekday === 6) return false
  return hm >= 8 * 60 + 30 && hm < 10 * 60
}

export function isKillzone(unixSec: number): boolean {
  const { weekday, hm } = utcHm(unixSec)
  if (weekday === 0 || weekday === 6) return false
  return hm >= 7 * 60 && hm < 10 * 60
}

export function evaluateApex(candles: Candle[]): ApexSignal {
  const p = APEX_PARAMS
  const cur = last(candles)
  const prev = candles.length >= 2 ? candles[candles.length - 2] : undefined
  const price = cur?.close ?? 0
  const t = cur?.time ?? 0
  const atrVal = last(atr(candles, 14))?.value ?? 0
  const atrPips = atrVal > 0 ? atrVal / p.pip : 0
  const spreadPips = estimateSpreadPips(t, atrPips || undefined)
  const news = newsBlackout(t)
  const vwap = last(sessionVwap(candles))
  const ema21mtf = last(ema(candles, 105))
  const ema55mtf = last(ema(candles, 275))
  const rsi7 = last(rsi(candles, 7))
  const bias15: Bias =
    ema21mtf && ema55mtf
      ? ema21mtf.value > ema55mtf.value
        ? 'bull'
        : 'bear'
      : 'neutral'

  const windowOk = isEntryWindow(t)
  const newsOk = !news
  const spreadOk = spreadPips <= p.maxSpread
  const atrOk = atrPips >= p.minAtrPips && atrPips <= p.maxAtrPips

  let longSetup = false
  let shortSetup = false
  let setup: string | null = null
  let movePips = 0

  if (cur && prev && candles.length >= 4) {
    const c3 = candles[candles.length - 4]
    movePips = Math.abs(cur.close - c3.close) / p.pip
    const upBurst =
      cur.close > c3.close && cur.close > cur.open && prev.close > prev.open
    const dnBurst =
      cur.close < c3.close && cur.close < cur.open && prev.close < prev.open
    const moveOk = movePips >= p.minMovePips
    longSetup = !!(upBurst && moveOk)
    shortSetup = !!(dnBurst && moveOk)
    if (p.requireVwap && vwap) {
      longSetup = longSetup && cur.close > vwap.value
      shortSetup = shortSetup && cur.close < vwap.value
    }
    if (p.requireBias) {
      longSetup = longSetup && bias15 === 'bull'
      shortSetup = shortSetup && bias15 === 'bear'
    }
    if (p.rsiFilter && rsi7) {
      longSetup = longSetup && rsi7.value > 50
      shortSetup = shortSetup && rsi7.value < 50
    }
    if (longSetup || shortSetup) setup = 'Micro Momentum'
  }

  const signals: IndicatorSignal[] = []

  signals.push({
    id: 'window',
    name: 'London Mid',
    bias: windowOk ? (longSetup ? 'bull' : shortSetup ? 'bear' : bias15) : 'neutral',
    strength: windowOk ? 0.95 : 0.15,
    detail: windowOk
      ? '08:30–10:00 UTC · 高頻度帯'
      : 'エントリー帯外（08:30–10 UTC）',
  })

  signals.push({
    id: 'mtf15',
    name: '15m EMA Bias',
    bias: bias15,
    strength: bias15 === 'neutral' ? 0.2 : 0.75,
    detail:
      bias15 === 'bull'
        ? '上位足買い（参考・必須外）'
        : bias15 === 'bear'
          ? '上位足売り（参考・必須外）'
          : 'バイアス未確定',
  })

  if (vwap) {
    signals.push({
      id: 'vwap',
      name: 'Session VWAP',
      bias: price >= vwap.value ? 'bull' : 'bear',
      strength: Math.min(
        1,
        Math.abs(price - vwap.value) / (atrVal || price * 0.0005),
      ),
      detail:
        price >= vwap.value
          ? `VWAP上 ${vwap.value.toFixed(3)}`
          : `VWAP下 ${vwap.value.toFixed(3)}`,
    })
  }

  if (rsi7) {
    signals.push({
      id: 'rsi7',
      name: 'RSI(7)',
      bias: rsi7.value > 55 ? 'bull' : rsi7.value < 45 ? 'bear' : 'neutral',
      strength: Math.min(1, Math.abs(rsi7.value - 50) / 30),
      detail: `RSI ${rsi7.value.toFixed(1)}`,
    })
  }

  signals.push({
    id: 'micro',
    name: 'Micro Momentum',
    bias: longSetup ? 'bull' : shortSetup ? 'bear' : 'neutral',
    strength:
      longSetup || shortSetup ? 1 : Math.min(1, movePips / p.minMovePips),
    detail:
      longSetup || shortSetup
        ? `3本バースト ${movePips.toFixed(1)}p`
        : `バースト待ち（要≥${p.minMovePips}p）`,
  })

  signals.push({
    id: 'atr',
    name: 'ATR Band',
    bias: atrOk ? bias15 : 'neutral',
    strength: atrOk ? 0.8 : 0.2,
    detail: atrOk
      ? `ATR ${atrPips.toFixed(1)}p ∈ [${p.minAtrPips},${p.maxAtrPips}]`
      : `ATR ${atrPips.toFixed(1)}p 帯外`,
  })

  const gates: ApexGate[] = [
    {
      id: 'window',
      name: 'London Mid',
      ok: windowOk,
      detail: windowOk ? '08:30–10 UTC' : '時間外',
    },
    {
      id: 'news',
      name: 'ニュース帯',
      ok: newsOk,
      detail: newsOk ? '高インパクトなし' : `回避: ${news!.label}`,
    },
    {
      id: 'spread',
      name: 'スプレッド',
      ok: spreadOk,
      detail: `${spreadPips.toFixed(2)} ≤ ${p.maxSpread}`,
    },
    {
      id: 'atr',
      name: 'ATR帯',
      ok: atrOk,
      detail: `${atrPips.toFixed(1)}p`,
    },
    {
      id: 'vwap',
      name: 'VWAP側',
      ok: !!vwap,
      detail: vwap
        ? price >= vwap.value
          ? '価格≥VWAP'
          : '価格<VWAP'
        : '未計算',
    },
    {
      id: 'setup',
      name: 'Micro Mom',
      ok: !!(longSetup || shortSetup),
      detail: setup ?? `move ${movePips.toFixed(1)}p`,
    },
  ]

  const baseOk = windowOk && newsOk && spreadOk && atrOk
  let action: TradeAction = 'WAIT'
  if (baseOk && longSetup) action = 'LONG'
  else if (baseOk && shortSetup) action = 'SHORT'

  let score = 0
  if (vwap) score += price >= vwap.value ? 15 : -15
  if (windowOk) score += 20
  if (longSetup) score += 45
  if (shortSetup) score -= 45
  if (atrOk) score += 10
  if (rsi7) score += rsi7.value > 50 ? 10 : rsi7.value < 50 ? -10 : 0
  score = Math.max(-100, Math.min(100, Math.round(score)))

  const bias: Bias =
    action === 'LONG' ? 'bull' : action === 'SHORT' ? 'bear' : bias15
  let label = 'APEX 待機'
  if (action === 'LONG') label = 'APEX ロング · Micro Mom'
  else if (action === 'SHORT') label = 'APEX ショート · Micro Mom'
  else if (!newsOk) label = `ニュース回避 (${news!.label})`
  else if (!spreadOk) label = 'スプレッド拡大'
  else if (!windowOk) label = 'London Mid外'
  else if (!atrOk) label = 'ATR帯外'
  else if (!(longSetup || shortSetup)) label = 'バースト待ち'

  return {
    score,
    bias,
    label,
    signals,
    action,
    gates,
    atr: atrVal,
    stopDistance: p.slPips * p.pip,
    takeProfitDistance: p.tpPips * p.pip,
    sessionOpen: windowOk,
    spreadPips,
    newsLabel: news?.label ?? null,
    family: p.family,
    setup,
  }
}
