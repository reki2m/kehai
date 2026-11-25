/**
 * KEHAI Simple — manual buy/sell only.
 *
 * Picked from world TV/blog staples (bakeoff SL7/TP10, slip 0.3):
 *   Trigger: UT Bot Alerts (QuantNomad / HPotter) — most-liked open TV script
 *   Confirm: SSL Channel — TV classic baseline
 *   Sessions: Tokyo / London Mid / NY Mid (session-tuned UT + EMA/VWAP gates)
 *
 * Rules: one position mindset · fixed SL 7 / TP 10 · no auto-trading
 * READY: SSL/EMA/VWAP already aligned + price within readyPips of UT trail
 */

import { newsBlackout, estimateSpreadPips } from './filters'
import type { Candle } from './marketData'
import {
  atr,
  ema,
  sessionVwap,
  sslDirection,
  utBotTrail,
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
  /** Distance to UT trail that triggers READY (pre-warn). */
  readyPips: 2,
  pip: 0.01,
} as const

export type SimpleAction = 'BUY' | 'SELL' | 'READY_BUY' | 'READY_SELL' | 'WAIT'

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

  const trailDistancePips =
    trail && Number.isFinite(trail.value)
      ? Math.abs(price - trail.value) / pip
      : null

  // READY: confirms already set, UT not flipped yet, price near trail
  const nearTrail =
    trailDistancePips != null && trailDistancePips <= SIMPLE.readyPips
  const readyBuy =
    filtersOk &&
    !buy &&
    !sell &&
    confirmLong &&
    !!ut &&
    ut.value < 0 &&
    nearTrail
  const readySell =
    filtersOk &&
    !buy &&
    !sell &&
    confirmShort &&
    !!ut &&
    ut.value > 0 &&
    nearTrail

  let action: SimpleAction = 'WAIT'
  if (filtersOk && buy) action = 'BUY'
  else if (filtersOk && sell) action = 'SELL'
  else if (readyBuy) action = 'READY_BUY'
  else if (readySell) action = 'READY_SELL'

  const sessionLabel = profile
    ? `${profile.labelJa} (${profile.jst})`
    : null

  let reason = '待機'
  if (action === 'BUY')
    reason = `UT買いフリップ + SSL買い${requireVwap ? ' + VWAP上' : ''}${requireEma ? ' + EMA順' : ''}`
  else if (action === 'SELL')
    reason = `UT売りフリップ + SSL売り${requireVwap ? ' + VWAP下' : ''}${requireEma ? ' + EMA逆' : ''}`
  else if (action === 'READY_BUY')
    reason = `準備・買い寄り · UTまであと${trailDistancePips?.toFixed(1) ?? '—'}p（エントリーはフリップ後）`
  else if (action === 'READY_SELL')
    reason = `準備・売り寄り · UTまであと${trailDistancePips?.toFixed(1) ?? '—'}p（エントリーはフリップ後）`
  else if (!windowOk) reason = 'セッション外'
  else if (!newsOk) reason = `ニュース回避 (${news!.label})`
  else if (!spreadOk) reason = 'スプレッド拡大'
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
  }
}
