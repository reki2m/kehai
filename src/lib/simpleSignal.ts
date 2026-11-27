/**
 * KEHAI Day Desk — manual day-trading companion.
 *
 * Not "trade less to win more". Two tracks on the same desk:
 *   本命 (Peak) — ADX≥24/28 · RR≈2.0 · size 1.0 · ~1.6/日 · EV≈+1.9p
 *   デイ (Active) — ADX≥16/20 UT or ST pulse · RR≈1.45 · size 0.5
 *                 · fills the day to ~8–10/日 combined on USDJPY
 * READY keeps the trader engaged between fills.
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
  name: 'KEHAI Day Desk',
  stack: '本命 Peak + デイ手数',
  sources: [
    'UT Bot Alerts — TradingView (QuantNomad / HPotter)',
    'SSL Channel — TradingView classic',
    '本命: 高ADX×RR2 · デイ: UT/ST手数×半サイズ',
    'デイトレは手数とサイズで設計する（回数を減らして勝率を盛らない）',
  ],
  /** Fallback when ATR missing (本命). */
  slPips: 7,
  tpPips: 14,
  /** 本命 risk */
  slAtrMult: 1.0,
  slMin: 7,
  slMax: 10,
  tpRr: 2.0,
  tpMin: 12,
  tpMax: 18,
  /** デイ risk — tighter hold / modest RR */
  daySlAtrMult: 1.1,
  daySlMin: 6,
  daySlMax: 10,
  dayTpRr: 1.45,
  dayTpMin: 9,
  dayTpMax: 14,
  maxHoldBars: 45,
  dayMaxHoldBars: 30,
  entryCooldownBars: 5,
  readyPips: 2,
  /** 本命 ADX */
  adxMin: 24,
  adxPrime: 28,
  /** デイ UT ADX */
  dayAdxMin: 16,
  dayAdxOff: 20,
  /** デイ ST pulse */
  pulseEnabled: true,
  adxPulse: 15,
  adxPulseOff: 19,
  /** Suggested lot fraction */
  honmeiSize: 1,
  daySize: 0.5,
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
  verified: {
    period: '2026-08〜10 Dukascopy · 本命',
    tradesPerDay: 1.6,
    winRate: 48.1,
    evPips: 1.92,
    netPips: 103.7,
  },
  /**
   * Combined desk on USDJPY (Dukascopy Aug–Oct, live-path + size weights).
   * Raw EV slightly red; size-weighted net stays green because デイ is ×0.5.
   */
  dayDesk: {
    tradesPerDay: 9.5,
    honmeiPerDay: 0.7,
    dayPerDay: 8.8,
    weightedNetPips: 19.2,
    note: '本命×1 · デイ×0.5 · 加重ネット+',
  },
} as const

/** ATR-scaled SL/TP — track selects risk table. */
export function atrRiskPips(
  atrPips: number,
  track: EntryTrack = 'honmei',
): { sl: number; tp: number } {
  const day = track === 'day'
  const slAtr = day ? SIMPLE.daySlAtrMult : SIMPLE.slAtrMult
  const slMin = day ? SIMPLE.daySlMin : SIMPLE.slMin
  const slMax = day ? SIMPLE.daySlMax : SIMPLE.slMax
  const rr = day ? SIMPLE.dayTpRr : SIMPLE.tpRr
  const tpMin = day ? SIMPLE.dayTpMin : SIMPLE.tpMin
  const tpMax = day ? SIMPLE.dayTpMax : SIMPLE.tpMax
  const fbSl = day ? SIMPLE.daySlMin : SIMPLE.slPips
  const fbTp = day ? SIMPLE.dayTpMin : SIMPLE.tpPips
  if (!(atrPips > 0)) return { sl: fbSl, tp: fbTp }
  const sl =
    Math.round(Math.max(slMin, Math.min(slMax, atrPips * slAtr)) * 10) / 10
  const tp =
    Math.round(Math.max(tpMin, Math.min(tpMax, sl * rr)) * 10) / 10
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
  /** 本命 or high-ADX 推奨 */
  prime: boolean
  /** Which desk track fired (null when WAIT/READY-only). */
  track: EntryTrack | null
  /** Suggested size vs 本命=1 */
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

  const honmeiFloor = noonOk ? SIMPLE.adxMin : SIMPLE.adxPrime
  const dayUtFloor = noonOk ? SIMPLE.dayAdxMin : SIMPLE.dayAdxOff
  const dayStFloor = noonOk ? SIMPLE.adxPulse : SIMPLE.adxPulseOff
  const adxHonmeiOk = !!adxVal && adxVal.adx >= honmeiFloor
  const adxDayUtOk = !!adxVal && adxVal.adx >= dayUtFloor
  const adxDayStOk = !!adxVal && adxVal.adx >= dayStFloor
  const adxStrong = !!adxVal && adxVal.adx >= SIMPLE.adxPrime
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

  let buy = false
  let sell = false
  let entryPath: 'ut' | 'st' | null = null
  let track: EntryTrack | null = null
  let qualityBlock: string | null = null

  const peakConfirms = (long: boolean) =>
    long
      ? confirmLong &&
        htfLong &&
        diLong &&
        wtAgreeLong &&
        rsiLongOk
      : confirmShort &&
        htfShort &&
        diShort &&
        wtAgreeShort &&
        rsiShortOk

  // ——— 本命 Peak ———
  if (filtersOk && adxHonmeiOk) {
    if (utFlipLong && peakConfirms(true)) {
      buy = true
      entryPath = 'ut'
      track = 'honmei'
    } else if (utFlipShort && peakConfirms(false)) {
      sell = true
      entryPath = 'ut'
      track = 'honmei'
    }
  }

  // ——— デイ手数 (UT then ST) ———
  if (!buy && !sell && filtersOk && SIMPLE.pulseEnabled) {
    if (adxDayUtOk) {
      if (utFlipLong && peakConfirms(true)) {
        buy = true
        entryPath = 'ut'
        track = 'day'
      } else if (utFlipShort && peakConfirms(false)) {
        sell = true
        entryPath = 'ut'
        track = 'day'
      }
    }
    if (!buy && !sell && adxDayStOk) {
      let stBuy = stFlipLong && sslLong && htfLong && diLong && wtAgreeLong
      let stSell =
        stFlipShort && sslShort && htfShort && diShort && wtAgreeShort
      if (stBuy || stSell) {
        buy = stBuy
        sell = stSell
        entryPath = 'st'
        track = 'day'
      }
    }
  }

  if ((utFlipLong || utFlipShort) && !buy && !sell) {
    if (!edgeOk) qualityBlock = 'セッション端（見送り）'
    else if (!atrFloorOk) qualityBlock = `ATR薄い ${atrPips.toFixed(1)}p`
    else if (!adxDayUtOk && !adxHonmeiOk)
      qualityBlock = `ADX弱い ${adxVal?.adx.toFixed(0) ?? '—'}（デイ要≥${dayUtFloor}）`
    else if (!peakConfirms(utFlipLong)) qualityBlock = '確認レイヤー不足'
  }

  const trailDistancePips =
    trail && Number.isFinite(trail.value)
      ? Math.abs(price - trail.value) / pip
      : null

  const nearTrail =
    trailDistancePips != null && trailDistancePips <= SIMPLE.readyPips
  // READY watches 本命-quality approach (keeps desk alive)
  const peakLongReady =
    confirmLong &&
    htfLong &&
    diLong &&
    wtAgreeLong &&
    rsiLongOk &&
    adxHonmeiOk
  const peakShortReady =
    confirmShort &&
    htfShort &&
    diShort &&
    wtAgreeShort &&
    rsiShortOk &&
    adxHonmeiOk
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
  if (stLong || stShort) quality += 6
  if (ut) quality += 6
  if (utFlipLong || utFlipShort) quality += 12
  if (adxHonmeiOk) quality += 10
  else if (adxDayUtOk) quality += 5
  if (adxStrong) quality += 4
  if (diLong || diShort) quality += 8
  if (wtAgreeLong || wtAgreeShort) quality += 8
  if (rsiLongOk || rsiShortOk) quality += 8
  if (track === 'honmei') quality += 8
  if (noonOk) quality += 4
  else quality += 6
  quality = Math.max(0, Math.min(100, Math.round(quality)))

  const hasEntry = action === 'BUY' || action === 'SELL'
  const prime = hasEntry && track === 'honmei'
  let grade = gradeFromQuality(quality, hasEntry || action.startsWith('READY'))
  if (track === 'honmei' && hasEntry && (grade === 'B' || grade === 'C'))
    grade = 'A'
  if (track === 'honmei' && prime && quality >= 86) grade = 'S'
  if (track === 'day' && hasEntry) {
    if (grade === 'S') grade = 'A'
    if (grade === 'A' && quality < 80) grade = 'B'
  }

  const sizeHint =
    track === 'day' ? SIMPLE.daySize : SIMPLE.honmeiSize

  const layers: IndicatorLayer[] = [
    {
      id: 'track',
      name: 'Desk',
      bias: track === 'honmei' ? 'bull' : track === 'day' ? 'bear' : 'neutral',
      ok: track != null || readyBuy || readySell,
      detail:
        track === 'honmei'
          ? `本命 ×${SIMPLE.honmeiSize}`
          : track === 'day'
            ? `デイ ×${SIMPLE.daySize}`
            : readyBuy || readySell
              ? 'READY監視'
              : '待機',
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
        adxVal && adxVal.adx >= dayUtFloor
          ? adxVal.plusDi > adxVal.minusDi
            ? 'bull'
            : 'bear'
          : 'neutral',
      ok: adxHonmeiOk || adxDayUtOk,
      detail: adxVal
        ? `${adxVal.adx.toFixed(0)}${
            adxHonmeiOk ? ' 本命' : adxDayUtOk ? ' デイ' : ` <${dayUtFloor}`
          }`
        : '未計算',
    },
    {
      id: 'wt',
      name: 'WaveTrend',
      bias: wtBull ? 'bull' : wtBear ? 'bear' : 'neutral',
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
  const risk = atrRiskPips(atrPips, track ?? 'honmei')

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

  const trackTxt =
    track === 'honmei' ? '本命' : track === 'day' ? 'デイ' : ''
  const pathTxt = entryPath === 'st' ? 'ST' : 'UT'
  let reason = '待機'
  if (action === 'BUY')
    reason = `${trackTxt}${pathTxt}買い · サイズ×${sizeHint}${entryTxt ? ` · ${entryTxt}` : ''}`
  else if (action === 'SELL')
    reason = `${trackTxt}${pathTxt}売り · サイズ×${sizeHint}${entryTxt ? ` · ${entryTxt}` : ''}`
  else if (action === 'READY_BUY')
    reason = entryTxt
      ? `本命準備・買い · ${entryTxt}（あと${trailDistancePips?.toFixed(1) ?? '—'}p）`
      : `本命準備・買い · UTまで${trailDistancePips?.toFixed(1) ?? '—'}p`
  else if (action === 'READY_SELL')
    reason = entryTxt
      ? `本命準備・売り · ${entryTxt}（あと${trailDistancePips?.toFixed(1) ?? '—'}p）`
      : `本命準備・売り · UTまで${trailDistancePips?.toFixed(1) ?? '—'}p`
  else if (!windowOk) reason = 'セッション外'
  else if (!newsOk) reason = `ニュース回避 (${news!.label})`
  else if (!spreadOk) reason = 'スプレッド拡大'
  else if (qualityBlock) reason = qualityBlock
  else if (!(utFlipLong || utFlipShort || stFlipLong || stFlipShort))
    reason = 'フリップ待ち · READY監視中'
  else reason = '確認待ち'

  const label =
    action === 'BUY'
      ? track === 'honmei'
        ? 'BUY本命'
        : 'BUYデイ'
      : action === 'SELL'
        ? track === 'honmei'
          ? 'SELL本命'
          : 'SELLデイ'
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
    sizeHint: hasEntry ? sizeHint : SIMPLE.honmeiSize,
    layers,
    utKey,
    utAtr,
    sslLen,
  }
}
