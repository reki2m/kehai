import {
  estimateSpreadPips,
  newsBlackout,
} from './filters'
import type { Candle } from './marketData'
import { atr, ema, sessionVwap } from './indicators'
import type { Bias, IndicatorSignal } from './signals'

/**
 * KEHAI Apex — peak 1m scalping stack.
 * Sources: ICT killzone + liquidity sweep/reclaim, session VWAP,
 * London ORB / Asian range break, 15m EMA bias, prop-style filters.
 */
/** Locked from real-M1 grid search (Yahoo train/holdout both ≥0 with VWAP). */
export const APEX_PARAMS = {
  family: 'sweep' as 'sweep' | 'vwap_pb' | 'orb' | 'asian_brk',
  swingLookback: 25,
  minBody: 0.6,
  volMult: 1.0,
  rr: 1.5,
  slBufferPips: 0.4,
  maxSpread: 1.2,
  kz: 'ny' as 'ln' | 'london' | 'ny',
  requireVwap: true,
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

function utcParts(unixSec: number) {
  const d = new Date(unixSec * 1000)
  return {
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    y: d.getUTCFullYear(),
    m: d.getUTCMonth(),
    day: d.getUTCDate(),
  }
}

/** London 07–10 / NY 12:30–16 UTC (ICT-style killzones). */
export function isKillzone(
  unixSec: number,
  mode: 'ln' | 'london' | 'ny' = APEX_PARAMS.kz,
): boolean {
  const { weekday, hour, minute } = utcParts(unixSec)
  if (weekday === 0 || weekday === 6) return false
  const hm = hour * 60 + minute
  const london = hm >= 7 * 60 && hm < 10 * 60
  const ny = hm >= 12 * 60 + 30 && hm < 16 * 60
  if (mode === 'london') return london
  if (mode === 'ny') return ny
  return london || ny
}

function swingLevels(candles: Candle[], lookback: number) {
  const n = candles.length
  if (n < lookback + 1) return { hi: NaN, lo: NaN }
  let hi = -Infinity
  let lo = Infinity
  for (let i = n - 1 - lookback; i < n - 1; i++) {
    hi = Math.max(hi, candles[i].high)
    lo = Math.min(lo, candles[i].low)
  }
  return { hi, lo }
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function orbLevels(candles: Candle[], orbMinutes = 30) {
  const lastC = last(candles)
  if (!lastC) return { hi: NaN, lo: NaN }
  const { y, m, day } = utcParts(lastC.time)
  const start = Date.UTC(y, m, day, 7, 0) / 1000
  const end = Date.UTC(y, m, day, 7, orbMinutes) / 1000
  if (lastC.time < end) return { hi: NaN, lo: NaN }
  let hi = -Infinity
  let lo = Infinity
  let any = false
  for (const c of candles) {
    if (c.time >= start && c.time < end) {
      hi = Math.max(hi, c.high)
      lo = Math.min(lo, c.low)
      any = true
    }
  }
  return any ? { hi, lo } : { hi: NaN, lo: NaN }
}

function asianLevels(candles: Candle[], endH = 7) {
  const lastC = last(candles)
  if (!lastC) return { hi: NaN, lo: NaN }
  const { y, m, day } = utcParts(lastC.time)
  const start = Date.UTC(y, m, day, 0, 0) / 1000
  const end = Date.UTC(y, m, day, endH, 0) / 1000
  if (lastC.time < end) return { hi: NaN, lo: NaN }
  let hi = -Infinity
  let lo = Infinity
  let any = false
  for (const c of candles) {
    if (c.time >= start && c.time < end) {
      hi = Math.max(hi, c.high)
      lo = Math.min(lo, c.low)
      any = true
    }
  }
  return any ? { hi, lo } : { hi: NaN, lo: NaN }
}

export function evaluateApex(candles: Candle[]): ApexSignal {
  const p = APEX_PARAMS
  const cur = last(candles)
  const price = cur?.close ?? 0
  const t = cur?.time ?? 0
  const atrVal = last(atr(candles, 14))?.value ?? 0
  const atrPips = atrVal > 0 ? atrVal / p.pip : undefined
  const spreadPips = estimateSpreadPips(t, atrPips)
  const news = newsBlackout(t)
  const vwap = last(sessionVwap(candles))
  // 15m bias proxy on M1: EMA(21*15) vs EMA(55*15)
  const ema21mtf = last(ema(candles, 105))
  const ema55mtf = last(ema(candles, 275))
  const bias15: Bias =
    ema21mtf && ema55mtf
      ? ema21mtf.value > ema55mtf.value
        ? 'bull'
        : 'bear'
      : 'neutral'

  const kzOk = isKillzone(t, p.kz)
  const newsOk = !news
  const spreadOk = spreadPips <= p.maxSpread

  const bar = cur
  const body = bar ? Math.abs(bar.close - bar.open) : 0
  const rng = bar ? Math.max(bar.high - bar.low, 1e-9) : 1
  const bodyRatio = body / rng
  const dispOk = bodyRatio >= p.minBody

  const vols = candles.slice(-51, -1).map((c) => Math.max(1, c.volume || 1))
  const volMed = median(vols)
  const volNow = Math.max(1, bar?.volume || 1)
  const volOk = volMed <= 0 || volNow >= volMed * p.volMult

  const swing = swingLevels(candles, p.swingLookback)
  const orb = orbLevels(candles)
  const asian = asianLevels(candles)

  let longSetup = false
  let shortSetup = false
  let setup: string | null = null
  let stopLong = 0
  let stopShort = 0

  if (bar && Number.isFinite(swing.hi)) {
    const sweptLow =
      bar.low < swing.lo && bar.close > swing.lo && bar.close > bar.open
    const sweptHigh =
      bar.high > swing.hi && bar.close < swing.hi && bar.close < bar.open
    if (p.family === 'sweep') {
      longSetup = sweptLow && bias15 === 'bull'
      shortSetup = sweptHigh && bias15 === 'bear'
      if (p.requireVwap && vwap) {
        longSetup = longSetup && bar.close >= vwap.value
        shortSetup = shortSetup && bar.close <= vwap.value
      }
      if (longSetup || shortSetup) setup = 'Liquidity Sweep'
      stopLong = Math.min(bar.low, swing.lo) - p.slBufferPips * p.pip
      stopShort = Math.max(bar.high, swing.hi) + p.slBufferPips * p.pip
    }
  }

  if (p.family === 'vwap_pb' && bar && vwap) {
    const touch =
      bar.high >= vwap.value && bar.low <= vwap.value
    longSetup =
      touch && bar.close > vwap.value && bias15 === 'bull' && bar.close > bar.open
    shortSetup =
      touch && bar.close < vwap.value && bias15 === 'bear' && bar.close < bar.open
    if (longSetup || shortSetup) setup = 'VWAP Pullback'
    stopLong = Math.min(bar.low, vwap.value) - p.slBufferPips * p.pip
    stopShort = Math.max(bar.high, vwap.value) + p.slBufferPips * p.pip
  }

  if (p.family === 'orb' && bar && Number.isFinite(orb.hi)) {
    longSetup =
      bar.close > orb.hi && bar.open <= orb.hi && bias15 === 'bull'
    shortSetup =
      bar.close < orb.lo && bar.open >= orb.lo && bias15 === 'bear'
    if (longSetup || shortSetup) setup = 'London ORB'
    stopLong = orb.lo - p.slBufferPips * p.pip
    stopShort = orb.hi + p.slBufferPips * p.pip
  }

  if (p.family === 'asian_brk' && bar && Number.isFinite(asian.hi)) {
    longSetup =
      bar.close > asian.hi && bar.open <= asian.hi && bias15 === 'bull'
    shortSetup =
      bar.close < asian.lo && bar.open >= asian.lo && bias15 === 'bear'
    if (longSetup || shortSetup) setup = 'Asian Range Break'
    stopLong = asian.lo - p.slBufferPips * p.pip
    stopShort = asian.hi + p.slBufferPips * p.pip
  }

  const signals: IndicatorSignal[] = []

  const kzLabel =
    p.kz === 'ny'
      ? 'NY 12:30–16 UTC'
      : p.kz === 'london'
        ? 'London 07–10 UTC'
        : 'London 07–10 / NY 12:30–16 UTC'
  signals.push({
    id: 'killzone',
    name: 'Killzone',
    bias: kzOk ? bias15 : 'neutral',
    strength: kzOk ? 0.95 : 0.15,
    detail: kzOk ? kzLabel : 'キルゾーン外 — 待機',
  })

  signals.push({
    id: 'mtf15',
    name: '15m EMA Bias',
    bias: bias15,
    strength: bias15 === 'neutral' ? 0.2 : 0.9,
    detail:
      bias15 === 'bull'
        ? '上位足買いバイアス'
        : bias15 === 'bear'
          ? '上位足売りバイアス'
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

  signals.push({
    id: 'sweep',
    name: 'Liquidity / Setup',
    bias: longSetup ? 'bull' : shortSetup ? 'bear' : 'neutral',
    strength: longSetup || shortSetup ? 1 : 0.2,
    detail: setup
      ? `${setup} 検知`
      : `Swing ${p.swingLookback} · スイープ待ち`,
  })

  signals.push({
    id: 'displace',
    name: 'Displacement',
    bias: dispOk ? (bar && bar.close >= bar.open ? 'bull' : 'bear') : 'neutral',
    strength: Math.min(1, bodyRatio),
    detail: `実体比 ${(bodyRatio * 100).toFixed(0)}% ${dispOk ? 'OK' : '不足'}`,
  })

  signals.push({
    id: 'volume',
    name: 'Volume Impulse',
    bias: volOk ? bias15 : 'neutral',
    strength: volOk ? 0.85 : 0.2,
    detail: volOk
      ? `出来高 ≥ 中央値×${p.volMult}`
      : '出来高インパルス不足',
  })

  const gates: ApexGate[] = [
    {
      id: 'killzone',
      name: 'Killzone',
      ok: kzOk,
      detail: kzOk ? `${kzLabel} 稼働` : '時間外',
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
      id: 'bias',
      name: '15m Bias',
      ok: bias15 !== 'neutral',
      detail:
        bias15 === 'bull' ? '買い優位' : bias15 === 'bear' ? '売り優位' : 'なし',
    },
    {
      id: 'setup',
      name: 'Setup',
      ok: !!(longSetup || shortSetup),
      detail: setup ?? `${p.family} 未成立`,
    },
    {
      id: 'displace',
      name: 'Displacement',
      ok: dispOk,
      detail: `body ${(bodyRatio * 100).toFixed(0)}%`,
    },
    {
      id: 'volume',
      name: 'Volume',
      ok: volOk,
      detail: volOk ? 'インパルス' : '弱い',
    },
  ]

  const baseOk = kzOk && newsOk && spreadOk && dispOk && volOk
  let action: TradeAction = 'WAIT'
  if (baseOk && longSetup) action = 'LONG'
  else if (baseOk && shortSetup) action = 'SHORT'

  let score = 0
  if (bias15 === 'bull') score += 25
  if (bias15 === 'bear') score -= 25
  if (vwap) score += price >= vwap.value ? 15 : -15
  if (kzOk) score += action === 'WAIT' ? 10 : 20
  if (longSetup) score += 35
  if (shortSetup) score -= 35
  if (dispOk) score += longSetup || (!shortSetup && bias15 === 'bull') ? 10 : -10
  score = Math.max(-100, Math.min(100, Math.round(score)))

  let bias: Bias =
    action === 'LONG' ? 'bull' : action === 'SHORT' ? 'bear' : bias15
  let label = 'APEX 待機'
  if (action === 'LONG') label = `APEX ロング · ${setup}`
  else if (action === 'SHORT') label = `APEX ショート · ${setup}`
  else if (!newsOk) label = `ニュース回避 (${news!.label})`
  else if (!spreadOk) label = 'スプレッド拡大'
  else if (!kzOk) label = 'Killzone外'
  else if (!dispOk || !volOk) label = 'インパルス待ち'
  else if (!(longSetup || shortSetup)) label = 'Setup待ち'

  const stopDistance =
    action === 'LONG'
      ? Math.max(price - stopLong, atrVal * 0.8)
      : action === 'SHORT'
        ? Math.max(stopShort - price, atrVal * 0.8)
        : atrVal * 1.2
  const takeProfitDistance = stopDistance * p.rr

  return {
    score,
    bias,
    label,
    signals,
    action,
    gates,
    atr: atrVal,
    stopDistance,
    takeProfitDistance,
    sessionOpen: kzOk,
    spreadPips,
    newsLabel: news?.label ?? null,
    family: p.family,
    setup,
  }
}
