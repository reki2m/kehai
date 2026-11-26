/**
 * KEHAI Simple Pro — manual buy/sell only.
 *
 * Core (bakeoff winner): UT Bot flip × SSL Channel confirm
 * Quality stack (soft gates + grade):
 *   ADX regime · WaveTrend momentum · session EMA/VWAP
 *
 * Rules: one position mindset · fixed SL 7 / TP 10 · no auto-trading
 * READY: SSL/EMA/VWAP already aligned + price within readyPips of UT trail
 */

import { newsBlackout, estimateSpreadPips } from './filters'
import type { Candle } from './marketData'
import {
  adx,
  atr,
  ema,
  sessionVwap,
  sslDirection,
  utBotTrail,
  wavetrend,
} from './indicators'
import type { PairMeta } from './pairs'
import {
  SESSION_PROFILES,
  detectFxSession,
  isInstrumentWindow,
  type FxSession,
} from './apex'

export const SIMPLE = {
  name: 'KEHAI Simple Pro',
  stack: 'UT×SSL + ADX/WT',
  sources: [
    'UT Bot Alerts — TradingView (QuantNomad / HPotter)',
    'SSL Channel — TradingView classic',
    'ADX(14) regime · WaveTrend (LazyBear)',
    'Session windows — Tokyo / London Mid / NY',
  ],
  slPips: 7,
  tpPips: 10,
  maxHoldBars: 45,
  /** Distance to UT trail that triggers READY (pre-warn). */
  readyPips: 2,
  /** Soft floor: below this ADX, treat as dead range (no new entries). */
  adxMin: 18,
  /** Soft block when WaveTrend is strongly against the flip. */
  wtAgainstAbs: 50,
  pip: 0.01,
} as const

export type SimpleAction = 'BUY' | 'SELL' | 'READY_BUY' | 'READY_SELL' | 'WAIT'
export type QualityGrade = 'S' | 'A' | 'B' | 'C' | '—'

export interface IndicatorLayer {
  id: string
  name: string
  bias: 'bull' | 'bear' | 'neutral'
  ok: boolean
  detail: string
}

export interface SimpleSignal {
  action: SimpleAction
  label: string
  session: FxSession | null
  sessionLabel: string | null
  reason: string
  spreadPips: number
  stopDistance: number
  takeProfitDistance: number
  utFlip: boolean
  sslSide: 'buy' | 'sell' | 'flat'
  filtersOk: boolean
  /** Pips from close to UT trail (positive). */
  trailDistancePips: number | null
  readySide: 'BUY' | 'SELL' | null
  grade: QualityGrade
  quality: number
  layers: IndicatorLayer[]
  utKey: number
  utAtr: number
  sslLen: number
}

function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1]
}

function gradeFromQuality(q: number, hasEntry: boolean): QualityGrade {
  if (!hasEntry) return '—'
  if (q >= 88) return 'S'
  if (q >= 72) return 'A'
  if (q >= 55) return 'B'
  return 'C'
}

export function evaluateSimple(
  candles: Candle[],
  pair?: PairMeta,
  disabledSessions: FxSession[] = [],
): SimpleSignal {
  const pip = pair?.pip ?? SIMPLE.pip
  const cur = last(candles)
  const price = cur?.close ?? 0
  const t = cur?.time ?? 0

  const empty = (
    partial: Partial<SimpleSignal> & Pick<SimpleSignal, 'action' | 'label' | 'reason'>,
  ): SimpleSignal => ({
    session: null,
    sessionLabel: null,
    spreadPips: 0,
    stopDistance: SIMPLE.slPips * pip,
    takeProfitDistance: SIMPLE.tpPips * pip,
    utFlip: false,
    sslSide: 'flat',
    filtersOk: false,
    trailDistancePips: null,
    readySide: null,
    grade: '—',
    quality: 0,
    layers: [],
    utKey: 2,
    utAtr: 7,
    sslLen: 10,
    ...partial,
  })

  const fxSession = !pair || pair.kind === 'fx' ? detectFxSession(t) : null
  if (fxSession && disabledSessions.includes(fxSession)) {
    return empty({
      action: 'WAIT',
      label: 'WAIT',
      session: fxSession,
      sessionLabel: `${SESSION_PROFILES[fxSession].labelJa}（停止中）`,
      reason: '弱い帯として停止中',
    })
  }
  const profile = fxSession ? SESSION_PROFILES[fxSession] : null

  const utKey = profile?.utKey ?? 2
  const utAtr = profile?.utAtr ?? 7
  const sslLen = profile?.sslLen ?? 10
  const requireVwap = profile?.requireVwap ?? false
  const requireEma = profile?.requireEma ?? false
  const maxSpread = profile?.maxSpread ?? 0.45

  const atrVal = last(atr(candles, 14))?.value ?? 0
  const atrPips = atrVal > 0 ? atrVal / pip : 0
  const spreadPips =
    pair && pair.kind !== 'fx'
      ? Math.min(maxSpread, 0.2)
      : estimateSpreadPips(t, atrPips || undefined)

  const news = pair?.kind === 'fx' ? newsBlackout(t) : null
  const windowOk =
    pair && pair.kind !== 'fx' ? isInstrumentWindow(t, pair) : fxSession != null

  const { direction: utSeries, trail: trailSeries } = utBotTrail(
    candles,
    utKey,
    utAtr,
  )
  const ut = last(utSeries)
  const utPrev = utSeries.length >= 2 ? utSeries[utSeries.length - 2] : undefined
  const trail = last(trailSeries)
  const ssl = last(sslDirection(candles, sslLen))
  const vwap = last(sessionVwap(candles))
  const ema21 = last(ema(candles, 21))
  const ema55 = last(ema(candles, 55))
  const adxVal = last(adx(candles, 14))
  const { wt1, wt2 } = wavetrend(candles, 10, 21)
  const w1 = last(wt1)
  const w2 = last(wt2)

  const utFlipLong = !!(ut && utPrev && ut.value > 0 && utPrev.value <= 0)
  const utFlipShort = !!(ut && utPrev && ut.value < 0 && utPrev.value >= 0)
  const sslLong = !!ssl && ssl.value > 0
  const sslShort = !!ssl && ssl.value < 0
  const emaLong = !requireEma || (!!ema21 && !!ema55 && ema21.value > ema55.value)
  const emaShort = !requireEma || (!!ema21 && !!ema55 && ema21.value < ema55.value)

  let confirmLong = sslLong && emaLong
  let confirmShort = sslShort && emaShort
  if (requireVwap && vwap) {
    confirmLong = confirmLong && price >= vwap.value
    confirmShort = confirmShort && price <= vwap.value
  }

  let buy = utFlipLong && confirmLong
  let sell = utFlipShort && confirmShort

  const newsOk = !news
  const spreadOk = spreadPips <= maxSpread
  const filtersOk = windowOk && newsOk && spreadOk

  const adxOk = !adxVal || adxVal.adx >= SIMPLE.adxMin
  const adxStrong = !!adxVal && adxVal.adx >= 25
  const wtBull = !!(w1 && w2 && w1.value > w2.value)
  const wtBear = !!(w1 && w2 && w1.value < w2.value)
  const wtAbs = w1 ? Math.abs(w1.value) : 0
  const wtStrongAgainstLong =
    wtBear && wtAbs >= SIMPLE.wtAgainstAbs
  const wtStrongAgainstShort =
    wtBull && wtAbs >= SIMPLE.wtAgainstAbs
  const wtAgreeLong = wtBull
  const wtAgreeShort = wtBear

  // Soft quality gates — keep UT×SSL core, cut dead/against moves
  let qualityBlock: string | null = null
  if ((buy || sell) && !adxOk) {
    qualityBlock = `ADX弱い ${adxVal?.adx.toFixed(0) ?? '—'}（レンジ）`
    buy = false
    sell = false
  } else if (buy && wtStrongAgainstLong) {
    qualityBlock = `WaveTrend強く逆行 ${w1!.value.toFixed(0)}`
    buy = false
  } else if (sell && wtStrongAgainstShort) {
    qualityBlock = `WaveTrend強く逆行 ${w1!.value.toFixed(0)}`
    sell = false
  }

  const trailDistancePips =
    trail && Number.isFinite(trail.value)
      ? Math.abs(price - trail.value) / pip
      : null

  // READY: confirms already set, UT not flipped yet, price near trail
  const nearTrail =
    trailDistancePips != null && trailDistancePips <= SIMPLE.readyPips
  const readyBuy =
    filtersOk &&
    adxOk &&
    !buy &&
    !sell &&
    confirmLong &&
    !!ut &&
    ut.value < 0 &&
    nearTrail &&
    !wtStrongAgainstLong
  const readySell =
    filtersOk &&
    adxOk &&
    !buy &&
    !sell &&
    confirmShort &&
    !!ut &&
    ut.value > 0 &&
    nearTrail &&
    !wtStrongAgainstShort

  let action: SimpleAction = 'WAIT'
  if (filtersOk && buy) action = 'BUY'
  else if (filtersOk && sell) action = 'SELL'
  else if (readyBuy) action = 'READY_BUY'
  else if (readySell) action = 'READY_SELL'

  // Quality score 0–100
  let quality = 0
  if (windowOk) quality += 12
  if (newsOk) quality += 8
  if (spreadOk) quality += 8
  if (sslLong || sslShort) quality += 14
  if (ut) quality += 10
  if (utFlipLong || utFlipShort) quality += 18
  if ((buy && confirmLong) || (sell && confirmShort)) quality += 10
  if (adxOk) quality += 8
  if (adxStrong) quality += 6
  if ((buy || readyBuy) && wtAgreeLong) quality += 10
  else if ((sell || readySell) && wtAgreeShort) quality += 10
  else if (w1 && w2) quality += 2
  if (requireVwap && vwap) {
    if ((buy || readyBuy) && price >= vwap.value) quality += 6
    if ((sell || readySell) && price <= vwap.value) quality += 6
  }
  if (requireEma && ema21 && ema55) {
    if ((buy || readyBuy) && ema21.value > ema55.value) quality += 6
    if ((sell || readySell) && ema21.value < ema55.value) quality += 6
  }
  quality = Math.max(0, Math.min(100, Math.round(quality)))

  const hasEntry = action === 'BUY' || action === 'SELL'
  const grade = gradeFromQuality(quality, hasEntry || action.startsWith('READY'))

  const layers: IndicatorLayer[] = [
    {
      id: 'ut',
      name: `UT ${utKey}/${utAtr}`,
      bias: ut ? (ut.value > 0 ? 'bull' : 'bear') : 'neutral',
      ok: !!(utFlipLong || utFlipShort || nearTrail),
      detail: utFlipLong
        ? '買いフリップ'
        : utFlipShort
          ? '売りフリップ'
          : ut
            ? ut.value > 0
              ? '上昇トレイル'
              : '下降トレイル'
            : '未計算',
    },
    {
      id: 'ssl',
      name: `SSL(${sslLen})`,
      bias: sslLong ? 'bull' : sslShort ? 'bear' : 'neutral',
      ok: sslLong || sslShort,
      detail: sslLong ? '買い側' : sslShort ? '売り側' : 'フラット',
    },
    {
      id: 'adx',
      name: 'ADX(14)',
      bias:
        adxVal && adxVal.adx >= SIMPLE.adxMin
          ? adxVal.plusDi > adxVal.minusDi
            ? 'bull'
            : 'bear'
          : 'neutral',
      ok: adxOk,
      detail: adxVal
        ? `${adxVal.adx.toFixed(0)}${adxOk ? (adxStrong ? ' 強い' : ' OK') : ' 弱い'}`
        : '未計算',
    },
    {
      id: 'wt',
      name: 'WaveTrend',
      bias: wtBull ? 'bull' : wtBear ? 'bear' : 'neutral',
      ok: !!(w1 && w2),
      detail: w1 && w2
        ? `${w1.value.toFixed(0)}/${w2.value.toFixed(0)}`
        : '未計算',
    },
  ]
  if (requireVwap || vwap) {
    layers.push({
      id: 'vwap',
      name: 'VWAP',
      bias: vwap ? (price >= vwap.value ? 'bull' : 'bear') : 'neutral',
      ok: !!vwap && (!requireVwap || (confirmLong || confirmShort || !(buy || sell))),
      detail: vwap
        ? price >= vwap.value
          ? `上 ${vwap.value.toFixed(3)}`
          : `下 ${vwap.value.toFixed(3)}`
        : '未計算',
    })
  }
  if (requireEma || (ema21 && ema55)) {
    layers.push({
      id: 'ema',
      name: 'EMA21/55',
      bias:
        ema21 && ema55
          ? ema21.value > ema55.value
            ? 'bull'
            : 'bear'
          : 'neutral',
      ok: !!ema21 && !!ema55,
      detail:
        ema21 && ema55
          ? ema21.value > ema55.value
            ? '短期>長期'
            : '短期<長期'
          : '未計算',
    })
  }

  const sessionLabel = profile
    ? `${profile.labelJa} (${profile.jst})`
    : null

  let reason = '待機'
  if (action === 'BUY')
    reason = `UT買い + SSL${requireVwap ? ' + VWAP上' : ''}${requireEma ? ' + EMA順' : ''} · 品質${grade}`
  else if (action === 'SELL')
    reason = `UT売り + SSL${requireVwap ? ' + VWAP下' : ''}${requireEma ? ' + EMA逆' : ''} · 品質${grade}`
  else if (action === 'READY_BUY')
    reason = `準備・買い · UTまで${trailDistancePips?.toFixed(1) ?? '—'}p · 品質${grade}`
  else if (action === 'READY_SELL')
    reason = `準備・売り · UTまで${trailDistancePips?.toFixed(1) ?? '—'}p · 品質${grade}`
  else if (!windowOk) reason = 'セッション外'
  else if (!newsOk) reason = `ニュース回避 (${news!.label})`
  else if (!spreadOk) reason = 'スプレッド拡大'
  else if (qualityBlock) reason = qualityBlock
  else if (!(utFlipLong || utFlipShort)) reason = 'UTフリップ待ち'
  else if ((utFlipLong && !sslLong) || (utFlipShort && !sslShort)) reason = 'SSL未確認'
  else if ((utFlipLong && !emaLong) || (utFlipShort && !emaShort)) reason = 'EMA不一致'
  else reason = 'VWAP不一致'

  const label =
    action === 'BUY'
      ? 'BUY'
      : action === 'SELL'
        ? 'SELL'
        : action === 'READY_BUY'
          ? 'READY↑'
          : action === 'READY_SELL'
            ? 'READY↓'
            : 'WAIT'

  return {
    action,
    label,
    session: fxSession,
    sessionLabel,
    reason,
    spreadPips,
    stopDistance: SIMPLE.slPips * pip,
    takeProfitDistance: SIMPLE.tpPips * pip,
    utFlip: utFlipLong || utFlipShort,
    sslSide: sslLong ? 'buy' : sslShort ? 'sell' : 'flat',
    filtersOk,
    trailDistancePips,
    readySide: readyBuy ? 'BUY' : readySell ? 'SELL' : null,
    grade,
    quality,
    layers,
    utKey,
    utAtr,
    sslLen,
  }
}
