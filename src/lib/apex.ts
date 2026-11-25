import {
  estimateSpreadPips,
  newsBlackout,
} from './filters'
import type { Candle } from './marketData'
import {
  atr,
  ema,
  sessionVwap,
  sslDirection,
  utBotDirection,
  wavetrend,
} from './indicators'
import type { Bias, IndicatorSignal } from './signals'

/**
 * KEHAI Apex — Famous TV stack locked on real spreads.
 *
 * Primary: UT Bot Alerts (key=2, ATR=7) flip + SSL Channel confirm
 * Session: London Mid 08:30–10 UTC · VWAP side · fixed 2.5/5.0p
 *
 * Also surfaces WaveTrend (LazyBear) as confluence readout (not required).
 * Validated: Dukascopy WF both halves + Yahoo full/holdout > 0.
 */
export const APEX_PARAMS = {
  family: 'ut_ssl' as const,
  kz: 'london' as const,
  hourMode: 'london_mid' as const,
  maxSpread: 0.8,
  slPips: 2.5,
  tpPips: 5.0,
  utKey: 2,
  utAtr: 7,
  sslLen: 10,
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

function utcHm(unixSec: number) {
  const d = new Date(unixSec * 1000)
  return {
    weekday: d.getUTCDay(),
    hm: d.getUTCHours() * 60 + d.getUTCMinutes(),
  }
}

export function isEntryWindow(unixSec: number): boolean {
  const { weekday, hm } = utcHm(unixSec)
  if (weekday === 0 || weekday === 6) return false
  return hm >= 8 * 60 + 30 && hm < 10 * 60
}

export function evaluateApex(candles: Candle[]): ApexSignal {
  const p = APEX_PARAMS
  const cur = last(candles)
  const price = cur?.close ?? 0
  const t = cur?.time ?? 0
  const atrVal = last(atr(candles, 14))?.value ?? 0
  const atrPips = atrVal > 0 ? atrVal / p.pip : 0
  const spreadPips = estimateSpreadPips(t, atrPips || undefined)
  const news = newsBlackout(t)
  const vwap = last(sessionVwap(candles))
  const utSeries = utBotDirection(candles, p.utKey, p.utAtr)
  const sslSeries = sslDirection(candles, p.sslLen)
  const ut = last(utSeries)
  const utPrev = utSeries.length >= 2 ? utSeries[utSeries.length - 2] : undefined
  const ssl = last(sslSeries)
  const { wt1, wt2 } = wavetrend(candles, 10, 21)
  const w1 = last(wt1)
  const w2 = last(wt2)
  const ema21 = last(ema(candles, 21))
  const ema55 = last(ema(candles, 55))

  const windowOk = isEntryWindow(t)
  const newsOk = !news
  const spreadOk = spreadPips <= p.maxSpread

  const utFlipLong = !!(ut && utPrev && ut.value > 0 && utPrev.value <= 0)
  const utFlipShort = !!(ut && utPrev && ut.value < 0 && utPrev.value >= 0)
  const sslLong = !!ssl && ssl.value > 0
  const sslShort = !!ssl && ssl.value < 0

  let longSetup = utFlipLong && sslLong
  let shortSetup = utFlipShort && sslShort
  if (p.requireVwap && vwap) {
    longSetup = longSetup && price >= vwap.value
    shortSetup = shortSetup && price <= vwap.value
  }
  const setup = longSetup || shortSetup ? 'UT Bot × SSL' : null

  const signals: IndicatorSignal[] = []

  signals.push({
    id: 'window',
    name: 'London Mid',
    bias: windowOk ? (longSetup ? 'bull' : shortSetup ? 'bear' : 'neutral') : 'neutral',
    strength: windowOk ? 0.95 : 0.15,
    detail: windowOk ? '08:30–10:00 UTC' : 'エントリー帯外（08:30–10 UTC）',
  })

  signals.push({
    id: 'utbot',
    name: `UT Bot (${p.utKey}/${p.utAtr})`,
    bias: ut ? (ut.value > 0 ? 'bull' : 'bear') : 'neutral',
    strength: utFlipLong || utFlipShort ? 1 : 0.7,
    detail: utFlipLong
      ? 'BUY flip'
      : utFlipShort
        ? 'SELL flip'
        : ut
          ? ut.value > 0
            ? '上昇トレイル'
            : '下降トレイル'
          : '未計算',
  })

  signals.push({
    id: 'ssl',
    name: 'SSL Channel',
    bias: ssl ? (ssl.value > 0 ? 'bull' : 'bear') : 'neutral',
    strength: 0.85,
    detail: ssl
      ? ssl.value > 0
        ? 'SSL 買い側'
        : 'SSL 売り側'
      : '未計算',
  })

  if (w1 && w2) {
    signals.push({
      id: 'wavetrend',
      name: 'WaveTrend',
      bias: w1.value > w2.value ? 'bull' : 'bear',
      strength: Math.min(1, Math.abs(w1.value) / 60),
      detail: `WT1 ${w1.value.toFixed(1)} / WT2 ${w2.value.toFixed(1)}`,
    })
  }

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

  if (ema21 && ema55) {
    signals.push({
      id: 'ema',
      name: 'EMA 21/55',
      bias: ema21.value > ema55.value ? 'bull' : 'bear',
      strength: 0.6,
      detail: ema21.value > ema55.value ? '短期>長期' : '短期<長期',
    })
  }

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
      id: 'utbot',
      name: 'UT Bot flip',
      ok: utFlipLong || utFlipShort,
      detail: utFlipLong ? 'BUY' : utFlipShort ? 'SELL' : '待ち',
    },
    {
      id: 'ssl',
      name: 'SSL確認',
      ok: (utFlipLong && sslLong) || (utFlipShort && sslShort),
      detail: sslLong ? '買い側' : sslShort ? '売り側' : 'なし',
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
      name: 'UT×SSL',
      ok: !!(longSetup || shortSetup),
      detail: setup ?? '未成立',
    },
  ]

  const baseOk = windowOk && newsOk && spreadOk
  let action: TradeAction = 'WAIT'
  if (baseOk && longSetup) action = 'LONG'
  else if (baseOk && shortSetup) action = 'SHORT'

  let score = 0
  if (ut) score += ut.value > 0 ? 20 : -20
  if (ssl) score += ssl.value > 0 ? 15 : -15
  if (vwap) score += price >= vwap.value ? 10 : -10
  if (windowOk) score += 15
  if (longSetup) score += 40
  if (shortSetup) score -= 40
  if (w1 && w2) score += w1.value > w2.value ? 8 : -8
  score = Math.max(-100, Math.min(100, Math.round(score)))

  const bias: Bias =
    action === 'LONG' ? 'bull' : action === 'SHORT' ? 'bear' : ut && ut.value > 0 ? 'bull' : ut && ut.value < 0 ? 'bear' : 'neutral'

  let label = 'APEX 待機'
  if (action === 'LONG') label = 'APEX ロング · UT×SSL'
  else if (action === 'SHORT') label = 'APEX ショート · UT×SSL'
  else if (!newsOk) label = `ニュース回避 (${news!.label})`
  else if (!spreadOk) label = 'スプレッド拡大'
  else if (!windowOk) label = 'London Mid外'
  else if (!(utFlipLong || utFlipShort)) label = 'UT Bot待ち'
  else label = 'SSL未一致'

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
