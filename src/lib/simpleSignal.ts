/**
 * KEHAI Simple — manual buy/sell only.
 *
 * Picked from world TV/blog staples (bakeoff SL7/TP10, slip 0.3):
 *   Trigger: UT Bot Alerts (QuantNomad / HPotter) — most-liked open TV script
 *   Confirm: SSL Channel — TV classic baseline
 *   Sessions: Tokyo / London Mid / NY Mid (session-tuned UT + EMA/VWAP gates)
 *
 * Rules: one position mindset · fixed SL 7 / TP 10 · no auto-trading
 */

import { newsBlackout, estimateSpreadPips } from './filters'
import type { Candle } from './marketData'
import {
  atr,
  ema,
  sessionVwap,
  sslDirection,
  utBotDirection,
} from './indicators'
import type { PairMeta } from './pairs'
import {
  SESSION_PROFILES,
  detectFxSession,
  isInstrumentWindow,
  type FxSession,
} from './apex'

export const SIMPLE = {
  name: 'KEHAI Simple',
  stack: 'UT Bot × SSL',
  sources: [
    'UT Bot Alerts — TradingView (QuantNomad / HPotter)',
    'SSL Channel — TradingView classic',
    'Session windows — Tokyo / London Mid / NY',
  ],
  slPips: 7,
  tpPips: 10,
  maxHoldBars: 45,
  pip: 0.01,
} as const

export type SimpleAction = 'BUY' | 'SELL' | 'WAIT'

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
}

function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1]
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

  const fxSession = !pair || pair.kind === 'fx' ? detectFxSession(t) : null
  if (fxSession && disabledSessions.includes(fxSession)) {
    return {
      action: 'WAIT',
      label: 'WAIT',
      session: fxSession,
      sessionLabel: `${SESSION_PROFILES[fxSession].labelJa}（停止中）`,
      reason: '弱い帯として停止中',
      spreadPips: 0,
      stopDistance: SIMPLE.slPips * pip,
      takeProfitDistance: SIMPLE.tpPips * pip,
      utFlip: false,
      sslSide: 'flat',
      filtersOk: false,
    }
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

  const utSeries = utBotDirection(candles, utKey, utAtr)
  const sslSeries = sslDirection(candles, sslLen)
  const ut = last(utSeries)
  const utPrev = utSeries.length >= 2 ? utSeries[utSeries.length - 2] : undefined
  const ssl = last(sslSeries)
  const vwap = last(sessionVwap(candles))
  const ema21 = last(ema(candles, 21))
  const ema55 = last(ema(candles, 55))

  const utFlipLong = !!(ut && utPrev && ut.value > 0 && utPrev.value <= 0)
  const utFlipShort = !!(ut && utPrev && ut.value < 0 && utPrev.value >= 0)
  const sslLong = !!ssl && ssl.value > 0
  const sslShort = !!ssl && ssl.value < 0
  const emaLong = !requireEma || (!!ema21 && !!ema55 && ema21.value > ema55.value)
  const emaShort = !requireEma || (!!ema21 && !!ema55 && ema21.value < ema55.value)

  let buy = utFlipLong && sslLong && emaLong
  let sell = utFlipShort && sslShort && emaShort
  if (requireVwap && vwap) {
    buy = buy && price >= vwap.value
    sell = sell && price <= vwap.value
  }

  const newsOk = !news
  const spreadOk = spreadPips <= maxSpread
  const filtersOk = windowOk && newsOk && spreadOk

  let action: SimpleAction = 'WAIT'
  if (filtersOk && buy) action = 'BUY'
  else if (filtersOk && sell) action = 'SELL'

  const sessionLabel = profile
    ? `${profile.labelJa} (${profile.jst})`
    : null

  let reason = '待機'
  if (action === 'BUY') reason = `UT買いフリップ + SSL買い${requireVwap ? ' + VWAP上' : ''}${requireEma ? ' + EMA順' : ''}`
  else if (action === 'SELL') reason = `UT売りフリップ + SSL売り${requireVwap ? ' + VWAP下' : ''}${requireEma ? ' + EMA逆' : ''}`
  else if (!windowOk) reason = 'セッション外'
  else if (!newsOk) reason = `ニュース回避 (${news!.label})`
  else if (!spreadOk) reason = 'スプレッド拡大'
  else if (!(utFlipLong || utFlipShort)) reason = 'UTフリップ待ち'
  else if ((utFlipLong && !sslLong) || (utFlipShort && !sslShort)) reason = 'SSL未確認'
  else if ((utFlipLong && !emaLong) || (utFlipShort && !emaShort)) reason = 'EMA不一致'
  else reason = 'VWAP不一致'

  let label = 'WAIT'
  if (action === 'BUY') label = 'BUY'
  else if (action === 'SELL') label = 'SELL'

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
  }
}
