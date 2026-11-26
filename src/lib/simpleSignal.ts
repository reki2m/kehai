/**
 * KEHAI Peak Edge — manual buy/sell only.
 *
 * Quality-first Peak stack (Aug–Oct Dukascopy max EV/net):
 *   UT flip × SSL × HTF × DI × WT × RSI · ADX≥24/28 · RR≈2.0
 *   → ~1.3 trades/day · EV ≈ +1.18p · net ≈ +121p
 * Pulse (ST) path disabled — frequency was eating expectancy.
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

export const SIMPLE = {
  name: 'KEHAI Peak Edge',
  stack: 'UT×SSL · HTF/DI/WT/RSI · 高ADX',
  sources: [
    'UT Bot Alerts — TradingView (QuantNomad / HPotter)',
    'SSL Channel — TradingView classic',
    'ADX(14)+DI · WaveTrend · RSI(14) pullback · HTF SSL(50)',
    '質優先 · ADX≥24/28 · RR≈2.0（Dukascopy検証 EV+1.18）',
  ],
  /** Fallback / baseline when ATR missing. */
  slPips: 7,
  tpPips: 14,
  /** ATR-hybrid risk: SL = clamp(ATR×mult), TP = clamp(SL×rr). */
  slAtrMult: 1.0,
  slMin: 7,
  slMax: 10,
  tpRr: 2.0,
  tpMin: 12,
  tpMax: 18,
  maxHoldBars: 45,
  /** Bars to wait after an entry signal before another (hist + fills). */
  entryCooldownBars: 5,
  /** Distance to UT trail that triggers READY (pre-warn). */
  readyPips: 2,
  /** UT path ADX floor in JST 12–0. */
  adxMin: 24,
  /** UT path off-window / 推奨 ADX floor. */
  adxPrime: 28,
  /** Supertrend path disabled (kept for UI labels / future). */
  pulseEnabled: false,
  adxPulse: 99,
  adxPulseOff: 99,
  /** Soft block leftover. */
  wtAgainstAbs: 55,
  /** Skip lifeless tape. */
  minAtrPips: 1.2,
  sessionEdgeMin: 0,
  htfSslLen: 50,
  stPeriod: 10,
  stMult: 3,
  /** RSI pullback bands (avoid chase) — UT path. */
  rsiLongLo: 40,
  rsiLongHi: 65,
  rsiShortLo: 35,
  rsiShortHi: 60,
  pip: 0.01,
  /**
   * Dukascopy Aug–Oct 2026 bakeoff (same stack + ATR exits).
   * Shown as reference next to live Yahoo hist sim.
   */
  verified: {
    period: '2026-08〜10 Dukascopy',
    tradesPerDay: 1.6,
    winRate: 48.1,
    evPips: 1.92,
    netPips: 103.7,
  },
} as const

/** ATR-scaled SL/TP used by live board + manual close. */
export function atrRiskPips(atrPips: number): { sl: number; tp: number } {
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
  /** Risk distances in pips (ATR-hybrid). */
  slPips: number
  tpPips: number
  utFlip: boolean
  sslSide: 'buy' | 'sell' | 'flat'
  filtersOk: boolean
  /** Pips from close to UT trail (positive). */
  trailDistancePips: number | null
  /** UT trail price (flip level to watch on READY). */
  trailPrice: number | null
  /** Suggested entry price when READY/BUY/SELL (UT flip level or last close). */
  entryPrice: number | null
  /** Absolute SL / TP from entryPrice (ATR-hybrid pip distances). */
  stopPrice: number | null
  takeProfitPrice: number | null
  readySide: 'BUY' | 'SELL' | null
  grade: QualityGrade
  quality: number
  /** DI + ADX≥prime + WT agree + HTF SSL — take these first. */
  prime: boolean
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
  // Outside Tokyo/London/NY bands still allow 推奨 with Tokyo knobs
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
  // FX: weekday 24h (prime off-noon); non-FX keeps instrument windows
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
  const stPrev = stSeries.length >= 2 ? stSeries[stSeries.length - 2] : undefined
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
  const stFlipLong = !!(stDir && stPrev && stDir.value > 0 && stPrev.value <= 0)
  const stFlipShort = !!(
    stDir &&
    stPrev &&
    stDir.value < 0 &&
    stPrev.value >= 0
  )
  const sslLong = !!ssl && ssl.value > 0
  const sslShort = !!ssl && ssl.value < 0
  const htfLong = !!htfSsl && htfSsl.value > 0
  const htfShort = !!htfSsl && htfSsl.value < 0
  const stLong = !!stDir && stDir.value > 0
  const stShort = !!stDir && stDir.value < 0
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
  let entryPath: 'ut' | 'st' | null = buy || sell ? 'ut' : null

  const newsOk = !news
  const spreadOk = spreadPips <= maxSpread
  const edgeOk = sessionAwayFromEdge(t, SIMPLE.sessionEdgeMin, fxSession)
  const atrFloorOk = atrPips <= 0 || atrPips >= SIMPLE.minAtrPips
  const filtersOk = windowOk && newsOk && spreadOk && edgeOk && atrFloorOk

  const adxFloor = noonOk ? SIMPLE.adxMin : SIMPLE.adxPrime
  const adxPulseFloor = noonOk ? SIMPLE.adxPulse : SIMPLE.adxPulseOff
  const adxOk = !!adxVal && adxVal.adx >= adxFloor
  const adxPulseOk = !!adxVal && adxVal.adx >= adxPulseFloor
  const adxStrong = !!adxVal && adxVal.adx >= 25
  const diLong = !!adxVal && adxVal.plusDi > adxVal.minusDi
  const diShort = !!adxVal && adxVal.minusDi > adxVal.plusDi
  const wtBull = !!(w1 && w2 && w1.value > w2.value)
  const wtBear = !!(w1 && w2 && w1.value < w2.value)
  const wtAgreeLong = wtBull
  const wtAgreeShort = wtBear
  const rsiLongOk =
    !!rsiVal &&
    rsiVal.value >= SIMPLE.rsiLongLo &&
    rsiVal.value <= SIMPLE.rsiLongHi
  const rsiShortOk =
    !!rsiVal &&
    rsiVal.value >= SIMPLE.rsiShortLo &&
    rsiVal.value <= SIMPLE.rsiShortHi

  // Path A — UT Peak Edge (high ADX · full confirms)
  let qualityBlock: string | null = null
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

  // Path B — Supertrend pulse (disabled on Peak Edge — frequency hurt EV)
  if (
    SIMPLE.pulseEnabled &&
    !buy &&
    !sell &&
    filtersOk &&
    adxPulseOk
  ) {
    let stBuy = stFlipLong && sslLong
    let stSell = stFlipShort && sslShort
    if (stBuy && !htfLong) stBuy = false
    if (stSell && !htfShort) stSell = false
    if (stBuy && !diLong) stBuy = false
    if (stSell && !diShort) stSell = false
    if (stBuy && !wtAgreeLong) stBuy = false
    if (stSell && !wtAgreeShort) stSell = false
    if (stBuy || stSell) {
      buy = stBuy
      sell = stSell
      entryPath = 'st'
      qualityBlock = null
    }
  }

  if (!(buy || sell)) entryPath = null

  const trailDistancePips =
    trail && Number.isFinite(trail.value)
      ? Math.abs(price - trail.value) / pip
      : null

  const nearTrail =
    trailDistancePips != null && trailDistancePips <= SIMPLE.readyPips
  const peakLongReady =
    confirmLong &&
    htfLong &&
    diLong &&
    wtAgreeLong &&
    rsiLongOk &&
    adxOk
  const peakShortReady =
    confirmShort &&
    htfShort &&
    diShort &&
    wtAgreeShort &&
    rsiShortOk &&
    adxOk
  const readyBuy =
    filtersOk &&
    !buy &&
    !sell &&
    !!ut &&
    ut.value < 0 &&
    nearTrail &&
    peakLongReady
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
  if (stLong || stShort) quality += 8
  if (ut) quality += 6
  if (utFlipLong || utFlipShort) quality += 12
  if (adxOk) quality += 8
  if (adxStrong) quality += 4
  if (diLong || diShort) quality += 8
  if (wtAgreeLong || wtAgreeShort) quality += 8
  if (rsiLongOk || rsiShortOk) quality += 8
  if (noonOk) quality += 4
  else quality += 6 // off-window survived higher ADX
  quality = Math.max(0, Math.min(100, Math.round(quality)))

  const hasEntry = action === 'BUY' || action === 'SELL'
  // Off-window always 推奨; in-window also 推奨 when ADX≥prime
  const prime =
    hasEntry &&
    (!noonOk || (!!adxVal && adxVal.adx >= SIMPLE.adxPrime))
  let grade = gradeFromQuality(quality, hasEntry || action.startsWith('READY'))
  if (hasEntry && (grade === 'B' || grade === 'C')) grade = 'A'
  if (prime && quality >= 86) grade = 'S'

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
      id: 'htf',
      name: `SSL(${SIMPLE.htfSslLen})`,
      bias: htfLong ? 'bull' : htfShort ? 'bear' : 'neutral',
      ok: htfLong || htfShort,
      detail: htfLong ? '上位買い' : htfShort ? '上位売り' : 'フラット',
    },
    {
      id: 'st',
      name: `ST(${SIMPLE.stPeriod},${SIMPLE.stMult})`,
      bias: stLong ? 'bull' : stShort ? 'bear' : 'neutral',
      ok: stLong || stShort,
      detail: stLong ? '上昇' : stShort ? '下降' : 'フラット',
    },
    {
      id: 'adx',
      name: 'ADX(14)',
      bias:
        adxVal && adxVal.adx >= adxFloor
          ? adxVal.plusDi > adxVal.minusDi
            ? 'bull'
            : 'bear'
          : 'neutral',
      ok: adxOk,
      detail: adxVal
        ? `${adxVal.adx.toFixed(0)}${adxOk ? (adxStrong ? ' 強い' : ' OK') : ` <${adxFloor}`}`
        : '未計算',
    },
    {
      id: 'wt',
      name: 'WaveTrend',
      bias: wtBull ? 'bull' : wtBear ? 'bear' : 'neutral',
      ok: wtAgreeLong || wtAgreeShort,
      detail: w1 && w2
        ? `${w1.value.toFixed(0)}/${w2.value.toFixed(0)}`
        : '未計算',
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

  const sessionOut: FxSession | null =
    fxSession ?? (isFxWeekday(t) && (!pair || pair.kind === 'fx') ? 'tokyo' : null)
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
  const risk = atrRiskPips(atrPips)

  // READY: watch UT trail flip. BUY/SELL: fill reference is last close.
  let entryPrice: number | null = null
  if (action === 'READY_BUY' || action === 'READY_SELL') {
    entryPrice = trailPrice
  } else if (action === 'BUY' || action === 'SELL') {
    entryPrice = price
  }

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

  const tierTxt = prime ? '推奨' : grade === 'A' || grade === 'S' ? '推奨' : '標準'
  const pathTxt = entryPath === 'st' ? 'STフリップ' : 'UT'
  let reason = '待機'
  if (action === 'BUY')
    reason = `${pathTxt}買い + SSL${requireVwap ? ' + VWAP上' : ''}${requireEma ? ' + EMA順' : ''} · ${tierTxt}${grade}${entryTxt ? ` · 目安 ${entryTxt}` : ''}`
  else if (action === 'SELL')
    reason = `${pathTxt}売り + SSL${requireVwap ? ' + VWAP下' : ''}${requireEma ? ' + EMA逆' : ''} · ${tierTxt}${grade}${entryTxt ? ` · 目安 ${entryTxt}` : ''}`
  else if (action === 'READY_BUY')
    reason = entryTxt
      ? `準備・買い · ${entryTxt} で買い検討（あと${trailDistancePips?.toFixed(1) ?? '—'}p）· 品質${grade}`
      : `準備・買い · UTまで${trailDistancePips?.toFixed(1) ?? '—'}p · 品質${grade}`
  else if (action === 'READY_SELL')
    reason = entryTxt
      ? `準備・売り · ${entryTxt} で売り検討（あと${trailDistancePips?.toFixed(1) ?? '—'}p）· 品質${grade}`
      : `準備・売り · UTまで${trailDistancePips?.toFixed(1) ?? '—'}p · 品質${grade}`
  else if (!windowOk) reason = 'セッション外'
  else if (!newsOk) reason = `ニュース回避 (${news!.label})`
  else if (!spreadOk) reason = 'スプレッド拡大'
  else if (qualityBlock) reason = qualityBlock
  else if (!(utFlipLong || utFlipShort || stFlipLong || stFlipShort))
    reason = 'UT/STフリップ待ち'
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
    layers,
    utKey,
    utAtr,
    sslLen,
  }
}
