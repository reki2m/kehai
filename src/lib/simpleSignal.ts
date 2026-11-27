/**
 * KEHAI Peak Hunter — manual companion aimed at ~30 pips/day.
 *
 * Single-pair Peak (SL10/TP20) ≈ +6 pips/day on Dukascopy USDJPY.
 * That alone cannot hit 30. The product is Peak quality × a 10-pair FX book:
 *   ~1.6 fills/pair/day × EV≈+3.8 × 10 ≈ +60 raw · ~+45 after correlation haircut.
 * Target: +30 pips/day average.
 *
 * Entry (per pair): UT flip × SSL × HTF × DI × WT × RSI · ADX≥24/28
 * Risk: fixed SL10 / TP20 (best daily-edge M1 bakeoff variant)
 * No soft “デイ手数” filler — frequency comes from pairs, not junk gates.
 */

import { newsBlackout, estimateSpreadPips } from './filters'
import type { Candle } from './marketData'
import {
  adx,
  atr,
  ema,
  rsi,
  sessionVwap,
  sslDirection,
  supertrendDirection,
  utBotTrail,
  wavetrend,
} from './indicators'
import type { PairMeta } from './pairs'
import {
  SESSION_PROFILES,
  detectFxSession,
  isFxWeekday,
  isInstrumentWindow,
  isNoonSignalWindow,
  sessionAwayFromEdge,
  type FxSession,
} from './apex'

export type EntryTrack = 'honmei' | 'day'

export const SIMPLE = {
  name: 'KEHAI Peak Hunter',
  stack: 'Peak × 10FXブック · 日次+30p狙い',
  sources: [
    'UT Bot Alerts — TradingView (QuantNomad / HPotter)',
    'SSL Channel — TradingView classic',
    'ADX(14)+DI · WaveTrend · RSI(14) · HTF SSL(50)',
    '単ペア日次+6p → 10ペアで日次+30p帯（相関ヘアカット後）',
  ],
  slPips: 10,
  tpPips: 20,
  /** Prefer fixed 10/20 (bakeoff best daily). ATR used as fallback clamp. */
  useFixedRisk: true,
  slAtrMult: 1.0,
  slMin: 10,
  slMax: 10,
  tpRr: 2.0,
  tpMin: 20,
  tpMax: 20,
  daySlAtrMult: 1.0,
  daySlMin: 10,
  daySlMax: 10,
  dayTpRr: 2.0,
  dayTpMin: 20,
  dayTpMax: 20,
  maxHoldBars: 60,
  dayMaxHoldBars: 60,
  entryCooldownBars: 5,
  readyPips: 2,
  adxMin: 24,
  adxPrime: 28,
  dayAdxMin: 24,
  dayAdxOff: 28,
  pulseEnabled: false,
  adxPulse: 99,
  adxPulseOff: 99,
  honmeiSize: 1,
  daySize: 1,
  wtAgainstAbs: 55,
  minAtrPips: 1.2,
  sessionEdgeMin: 0,
  htfSslLen: 50,
  stPeriod: 10,
  stMult: 3,
  rsiLongLo: 40,
  rsiLongHi: 65,
  rsiShortLo: 35,
  rsiShortHi: 60,
  pip: 0.01,
  /** Per-pair Dukascopy live-path Peak · SL10/TP20. */
  verified: {
    period: '2026-08〜10 Dukascopy · USDJPY単ペア',
    tradesPerDay: 1.6,
    winRate: 55.6,
    evPips: 3.81,
    netPips: 205.7,
    dailyPips: 6.06,
  },
  /** Book target: 10 pairs × per-pair daily (correlation haircut applied). */
  hunter: {
    pairs: 10,
    tradesPerDay: 16,
    dailyPipsTarget: 30,
    dailyPipsExpected: 45,
    note: '単ペア+6p ×10 ≈+60 · 相関で髪を切って+45目安 · 目標+30',
  },
  dayDesk: {
    tradesPerDay: 16,
    honmeiPerDay: 1.6,
    dayPerDay: 0,
    weightedNetPips: 205.7,
    note: 'Hunter book · デイ手数なし',
  },
} as const

export function atrRiskPips(
  atrPips: number,
  _track: EntryTrack = 'honmei',
): { sl: number; tp: number } {
  if (SIMPLE.useFixedRisk) {
    return { sl: SIMPLE.slPips, tp: SIMPLE.tpPips }
  }
  if (!(atrPips > 0)) return { sl: SIMPLE.slPips, tp: SIMPLE.tpPips }
  const sl =
    Math.round(
      Math.max(
        SIMPLE.slMin,
        Math.min(SIMPLE.slMax, atrPips * SIMPLE.slAtrMult),
      ) * 10,
    ) / 10
  const tp =
    Math.round(
      Math.max(SIMPLE.tpMin, Math.min(SIMPLE.tpMax, sl * SIMPLE.tpRr)) * 10,
    ) / 10
  return { sl, tp }
}

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
  slPips: number
  tpPips: number
  utFlip: boolean
  sslSide: 'buy' | 'sell' | 'flat'
  filtersOk: boolean
  trailDistancePips: number | null
  trailPrice: number | null
  entryPrice: number | null
  stopPrice: number | null
  takeProfitPrice: number | null
  readySide: 'BUY' | 'SELL' | null
  grade: QualityGrade
  quality: number
  prime: boolean
  track: EntryTrack | null
  sizeHint: number
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
    partial: Partial<SimpleSignal> &
      Pick<SimpleSignal, 'action' | 'label' | 'reason'>,
  ): SimpleSignal => ({
    session: null,
    sessionLabel: null,
    spreadPips: 0,
    stopDistance: SIMPLE.slPips * pip,
    takeProfitDistance: SIMPLE.tpPips * pip,
    slPips: SIMPLE.slPips,
    tpPips: SIMPLE.tpPips,
    utFlip: false,
    sslSide: 'flat',
    filtersOk: false,
    trailDistancePips: null,
    trailPrice: null,
    entryPrice: null,
    stopPrice: null,
    takeProfitPrice: null,
    readySide: null,
    grade: '—',
    quality: 0,
    prime: false,
    track: null,
    sizeHint: SIMPLE.honmeiSize,
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

  const profile = fxSession
    ? SESSION_PROFILES[fxSession]
    : pair?.kind === 'fx' || !pair
      ? SESSION_PROFILES.tokyo
      : null
  const noonOk = !pair || pair.kind === 'fx' ? isNoonSignalWindow(t) : true

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
    pair && pair.kind !== 'fx'
      ? isInstrumentWindow(t, pair)
      : isFxWeekday(t)

  const { direction: utSeries, trail: trailSeries } = utBotTrail(
    candles,
    utKey,
    utAtr,
  )
  const ut = last(utSeries)
  const utPrev = utSeries.length >= 2 ? utSeries[utSeries.length - 2] : undefined
  const trail = last(trailSeries)
  const ssl = last(sslDirection(candles, sslLen))
  const htfSsl = last(sslDirection(candles, SIMPLE.htfSslLen))
  const stSeries = supertrendDirection(
    candles,
    SIMPLE.stPeriod,
    SIMPLE.stMult,
  )
  const stDir = last(stSeries)
  const vwap = last(sessionVwap(candles))
  const ema21 = last(ema(candles, 21))
  const ema55 = last(ema(candles, 55))
  const adxVal = last(adx(candles, 14))
  const rsiVal = last(rsi(candles, 14))
  const { wt1, wt2 } = wavetrend(candles, 10, 21)
  const w1 = last(wt1)
  const w2 = last(wt2)

  const utFlipLong = !!(ut && utPrev && ut.value > 0 && utPrev.value <= 0)
  const utFlipShort = !!(ut && utPrev && ut.value < 0 && utPrev.value >= 0)
  const sslLong = !!ssl && ssl.value > 0
  const sslShort = !!ssl && ssl.value < 0
  const htfLong = !!htfSsl && htfSsl.value > 0
  const htfShort = !!htfSsl && htfSsl.value < 0
  const stLong = !!stDir && stDir.value > 0
  const stShort = !!stDir && stDir.value < 0
  const emaLong =
    !requireEma || (!!ema21 && !!ema55 && ema21.value > ema55.value)
  const emaShort =
    !requireEma || (!!ema21 && !!ema55 && ema21.value < ema55.value)

  let confirmLong = sslLong && emaLong
  let confirmShort = sslShort && emaShort
  if (requireVwap && vwap) {
    confirmLong = confirmLong && price >= vwap.value
    confirmShort = confirmShort && price <= vwap.value
  }

  const newsOk = !news
  const spreadOk = spreadPips <= maxSpread
  const edgeOk = sessionAwayFromEdge(t, SIMPLE.sessionEdgeMin, fxSession)
  const atrFloorOk = atrPips <= 0 || atrPips >= SIMPLE.minAtrPips
  const filtersOk = windowOk && newsOk && spreadOk && edgeOk && atrFloorOk

  const adxFloor = noonOk ? SIMPLE.adxMin : SIMPLE.adxPrime
  const adxOk = !!adxVal && adxVal.adx >= adxFloor
  const adxStrong = !!adxVal && adxVal.adx >= SIMPLE.adxPrime
  const diLong = !!adxVal && adxVal.plusDi > adxVal.minusDi
  const diShort = !!adxVal && adxVal.minusDi > adxVal.plusDi
  const wtAgreeLong = !!(w1 && w2 && w1.value > w2.value)
  const wtAgreeShort = !!(w1 && w2 && w1.value < w2.value)
  const rsiLongOk =
    !!rsiVal &&
    rsiVal.value >= SIMPLE.rsiLongLo &&
    rsiVal.value <= SIMPLE.rsiLongHi
  const rsiShortOk =
    !!rsiVal &&
    rsiVal.value >= SIMPLE.rsiShortLo &&
    rsiVal.value <= SIMPLE.rsiShortHi

  let buy = utFlipLong && confirmLong
  let sell = utFlipShort && confirmShort
  let qualityBlock: string | null = null
  let track: EntryTrack | null = null

  if ((buy || sell) && !edgeOk) {
    qualityBlock = 'セッション端（見送り）'
    buy = false
    sell = false
  } else if ((buy || sell) && !atrFloorOk) {
    qualityBlock = `ATR薄い ${atrPips.toFixed(1)}p`
    buy = false
    sell = false
  } else if ((buy || sell) && !adxOk) {
    qualityBlock = `ADX弱い ${adxVal?.adx.toFixed(0) ?? '—'}（要≥${adxFloor}）`
    buy = false
    sell = false
  } else if (buy && !htfLong) {
    qualityBlock = '上位SSL不一致'
    buy = false
  } else if (sell && !htfShort) {
    qualityBlock = '上位SSL不一致'
    sell = false
  } else if (buy && !diLong) {
    qualityBlock = 'DI方向不一致'
    buy = false
  } else if (sell && !diShort) {
    qualityBlock = 'DI方向不一致'
    sell = false
  } else if (buy && !wtAgreeLong) {
    qualityBlock = 'WaveTrend不一致'
    buy = false
  } else if (sell && !wtAgreeShort) {
    qualityBlock = 'WaveTrend不一致'
    sell = false
  } else if (buy && !rsiLongOk) {
    qualityBlock = `RSI追撃回避 ${rsiVal?.value.toFixed(0) ?? '—'}`
    buy = false
  } else if (sell && !rsiShortOk) {
    qualityBlock = `RSI追撃回避 ${rsiVal?.value.toFixed(0) ?? '—'}`
    sell = false
  }

  if (buy || sell) track = 'honmei'

  const trailDistancePips =
    trail && Number.isFinite(trail.value)
      ? Math.abs(price - trail.value) / pip
      : null
  const nearTrail =
    trailDistancePips != null && trailDistancePips <= SIMPLE.readyPips
  const peakLongReady =
    confirmLong && htfLong && diLong && wtAgreeLong && rsiLongOk && adxOk
  const peakShortReady =
    confirmShort && htfShort && diShort && wtAgreeShort && rsiShortOk && adxOk
  const readyBuy =
    filtersOk && !buy && !sell && !!ut && ut.value < 0 && nearTrail && peakLongReady
  const readySell =
    filtersOk &&
    !buy &&
    !sell &&
    !!ut &&
    ut.value > 0 &&
    nearTrail &&
    peakShortReady

  let action: SimpleAction = 'WAIT'
  if (filtersOk && buy) action = 'BUY'
  else if (filtersOk && sell) action = 'SELL'
  else if (readyBuy) action = 'READY_BUY'
  else if (readySell) action = 'READY_SELL'

  let quality = 0
  if (windowOk) quality += 8
  if (newsOk) quality += 4
  if (spreadOk) quality += 4
  if (atrFloorOk) quality += 6
  if (sslLong || sslShort) quality += 8
  if (htfLong || htfShort) quality += 8
  if (stLong || stShort) quality += 6
  if (ut) quality += 6
  if (utFlipLong || utFlipShort) quality += 12
  if (adxOk) quality += 10
  if (adxStrong) quality += 4
  if (diLong || diShort) quality += 8
  if (wtAgreeLong || wtAgreeShort) quality += 8
  if (rsiLongOk || rsiShortOk) quality += 8
  if (noonOk) quality += 4
  else quality += 6
  quality = Math.max(0, Math.min(100, Math.round(quality)))

  const hasEntry = action === 'BUY' || action === 'SELL'
  const prime = hasEntry
  let grade = gradeFromQuality(quality, hasEntry || action.startsWith('READY'))
  if (hasEntry && (grade === 'B' || grade === 'C')) grade = 'A'
  if (prime && quality >= 86) grade = 'S'

  const layers: IndicatorLayer[] = [
    {
      id: 'hunter',
      name: 'Hunter',
      bias: hasEntry ? 'bull' : 'neutral',
      ok: hasEntry || readyBuy || readySell,
      detail: hasEntry
        ? `Peak · SL${SIMPLE.slPips}/TP${SIMPLE.tpPips}`
        : readyBuy || readySell
          ? 'READY'
          : `ブック${SIMPLE.hunter.pairs}FX · 日次+${SIMPLE.hunter.dailyPipsTarget}p狙い`,
    },
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
      id: 'htf',
      name: `SSL(${SIMPLE.htfSslLen})`,
      bias: htfLong ? 'bull' : htfShort ? 'bear' : 'neutral',
      ok: htfLong || htfShort,
      detail: htfLong ? '上位買い' : htfShort ? '上位売り' : 'フラット',
    },
    {
      id: 'adx',
      name: 'ADX(14)',
      bias: adxOk
        ? adxVal!.plusDi > adxVal!.minusDi
          ? 'bull'
          : 'bear'
        : 'neutral',
      ok: adxOk,
      detail: adxVal
        ? `${adxVal.adx.toFixed(0)}${adxOk ? ' OK' : ` <${adxFloor}`}`
        : '未計算',
    },
    {
      id: 'wt',
      name: 'WaveTrend',
      bias: wtAgreeLong ? 'bull' : wtAgreeShort ? 'bear' : 'neutral',
      ok: wtAgreeLong || wtAgreeShort,
      detail:
        w1 && w2 ? `${w1.value.toFixed(0)}/${w2.value.toFixed(0)}` : '未計算',
    },
    {
      id: 'rsi',
      name: 'RSI(14)',
      bias:
        rsiVal && rsiVal.value >= 55
          ? 'bull'
          : rsiVal && rsiVal.value <= 45
            ? 'bear'
            : 'neutral',
      ok: rsiLongOk || rsiShortOk,
      detail: rsiVal ? rsiVal.value.toFixed(0) : '未計算',
    },
  ]

  const sessionOut: FxSession | null =
    fxSession ??
    (isFxWeekday(t) && (!pair || pair.kind === 'fx') ? 'tokyo' : null)
  const sessionLabel = noonOk
    ? '通常枠 (12:00–0:00 JST)'
    : fxSession
      ? `${SESSION_PROFILES[fxSession].labelJa} · 推奨のみ`
      : sessionOut
        ? '推奨枠 (平日いつでも)'
        : null

  const digits = pair?.digits ?? 3
  const trailPrice =
    trail && Number.isFinite(trail.value) ? trail.value : null
  const risk = atrRiskPips(atrPips, 'honmei')

  let entryPrice: number | null = null
  if (action === 'READY_BUY' || action === 'READY_SELL') entryPrice = trailPrice
  else if (action === 'BUY' || action === 'SELL') entryPrice = price

  let stopPrice: number | null = null
  let takeProfitPrice: number | null = null
  if (entryPrice != null) {
    const longSide = action === 'BUY' || action === 'READY_BUY'
    stopPrice = longSide
      ? entryPrice - risk.sl * pip
      : entryPrice + risk.sl * pip
    takeProfitPrice = longSide
      ? entryPrice + risk.tp * pip
      : entryPrice - risk.tp * pip
  }

  const fmt = (n: number | null) =>
    n != null && Number.isFinite(n) ? n.toFixed(digits) : null
  const entryTxt = fmt(entryPrice)

  let reason = '待機'
  if (action === 'BUY')
    reason = `Peak買い · SL${risk.sl}/TP${risk.tp}${entryTxt ? ` · ${entryTxt}` : ''}`
  else if (action === 'SELL')
    reason = `Peak売り · SL${risk.sl}/TP${risk.tp}${entryTxt ? ` · ${entryTxt}` : ''}`
  else if (action === 'READY_BUY')
    reason = entryTxt
      ? `準備・買い · ${entryTxt}（あと${trailDistancePips?.toFixed(1) ?? '—'}p）`
      : `準備・買い · UTまで${trailDistancePips?.toFixed(1) ?? '—'}p`
  else if (action === 'READY_SELL')
    reason = entryTxt
      ? `準備・売り · ${entryTxt}（あと${trailDistancePips?.toFixed(1) ?? '—'}p）`
      : `準備・売り · UTまで${trailDistancePips?.toFixed(1) ?? '—'}p`
  else if (!windowOk) reason = 'セッション外'
  else if (!newsOk) reason = `ニュース回避 (${news!.label})`
  else if (!spreadOk) reason = 'スプレッド拡大'
  else if (qualityBlock) reason = qualityBlock
  else if (!(utFlipLong || utFlipShort)) reason = 'UTフリップ待ち'
  else reason = '確認待ち'

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
    session: sessionOut,
    sessionLabel,
    reason,
    spreadPips,
    stopDistance: risk.sl * pip,
    takeProfitDistance: risk.tp * pip,
    slPips: risk.sl,
    tpPips: risk.tp,
    utFlip: utFlipLong || utFlipShort,
    sslSide: sslLong ? 'buy' : sslShort ? 'sell' : 'flat',
    filtersOk,
    trailDistancePips,
    trailPrice,
    entryPrice,
    stopPrice,
    takeProfitPrice,
    readySide: readyBuy ? 'BUY' : readySell ? 'SELL' : null,
    grade,
    quality,
    prime,
    track: hasEntry ? track : null,
    sizeHint: SIMPLE.honmeiSize,
    layers,
    utKey,
    utAtr,
    sslLen,
  }
}
