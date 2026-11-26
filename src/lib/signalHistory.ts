/**
 * Replay KEHAI Simple Pro entries across candle history (from a unix cutoff).
 * Same core as evaluateSimple: UT flip × SSL + session EMA/VWAP + ADX/WT gates.
 */

import {
  SESSION_PROFILES,
  detectFxSession,
  isInstrumentWindow,
} from './apex'
import { estimateSpreadPips, newsBlackout } from './filters'
import {
  adx,
  atr,
  ema,
  sessionVwap,
  sslDirection,
  utBotTrail,
  wavetrend,
} from './indicators'
import type { Candle } from './marketData'
import type { PairMeta } from './pairs'
import { SIMPLE } from './simpleSignal'

export interface HistSignal {
  time: number
  side: 'BUY' | 'SELL'
  price: number
}

/** 2026-11-01 00:00 UTC — chart markers from November onward. */
export const HIST_FROM_UNIX = Date.UTC(2026, 10, 1) / 1000

function mapByTime<T extends { time: number }>(pts: T[]): Map<number, T> {
  return new Map(pts.map((p) => [p.time, p]))
}

/**
 * One-pass historical entries. Uses per-bar session knobs (Tokyo/London/NY).
 */
export function listHistoricalSignals(
  candles: Candle[],
  pair?: PairMeta,
  fromUnix: number = HIST_FROM_UNIX,
): HistSignal[] {
  if (candles.length < 80) return []
  const pip = pair?.pip ?? SIMPLE.pip
  const out: HistSignal[] = []

  // Precompute with a mid session default; per-bar we re-read direction at that bar's knobs.
  // UT/SSL lengths differ by session — compute the three profiles once.
  const profiles = [
    SESSION_PROFILES.tokyo,
    SESSION_PROFILES.london,
    SESSION_PROFILES.ny,
  ] as const

  const utByProfile = new Map<
    string,
    { dir: Map<number, number>; trail: Map<number, number> }
  >()
  const sslByLen = new Map<number, Map<number, number>>()

  for (const p of profiles) {
    const key = `${p.utKey}/${p.utAtr}`
    if (!utByProfile.has(key)) {
      const { direction, trail } = utBotTrail(candles, p.utKey, p.utAtr)
      utByProfile.set(key, {
        dir: new Map(direction.map((d) => [d.time, d.value])),
        trail: new Map(trail.map((d) => [d.time, d.value])),
      })
    }
    if (!sslByLen.has(p.sslLen)) {
      sslByLen.set(
        p.sslLen,
        new Map(sslDirection(candles, p.sslLen).map((d) => [d.time, d.value])),
      )
    }
  }

  const vwapMap = mapByTime(sessionVwap(candles))
  const ema21Map = mapByTime(ema(candles, 21))
  const ema55Map = mapByTime(ema(candles, 55))
  const adxMap = mapByTime(adx(candles, 14))
  const atrMap = mapByTime(atr(candles, 14))
  const { wt1, wt2 } = wavetrend(candles, 10, 21)
  const wt1Map = mapByTime(wt1)
  const wt2Map = mapByTime(wt2)

  let lastSignalIndex = -999

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    if (c.time < fromUnix) continue
    if (i - lastSignalIndex < 2) continue

    const fxSession =
      !pair || pair.kind === 'fx' ? detectFxSession(c.time) : null
    const profile = fxSession ? SESSION_PROFILES[fxSession] : null
    if (!profile && (!pair || pair.kind === 'fx')) continue

    const utKey = profile?.utKey ?? 2
    const utAtr = profile?.utAtr ?? 7
    const sslLen = profile?.sslLen ?? 10
    const requireVwap = profile?.requireVwap ?? false
    const requireEma = profile?.requireEma ?? false
    const maxSpread = profile?.maxSpread ?? 0.45

    const utPack = utByProfile.get(`${utKey}/${utAtr}`)
    const sslMap = sslByLen.get(sslLen)
    if (!utPack || !sslMap) continue

    const prev = candles[i - 1]
    const ut = utPack.dir.get(c.time)
    const utPrev = utPack.dir.get(prev.time)
    if (ut == null || utPrev == null) continue

    const ssl = sslMap.get(c.time)
    if (ssl == null) continue

    const price = c.close
    const atrVal = atrMap.get(c.time)?.value ?? 0
    const atrPips = atrVal > 0 ? atrVal / pip : 0
    const spreadPips =
      pair && pair.kind !== 'fx'
        ? Math.min(maxSpread, 0.2)
        : estimateSpreadPips(c.time, atrPips || undefined)

    const news = pair?.kind === 'fx' ? newsBlackout(c.time) : null
    const windowOk =
      pair && pair.kind !== 'fx'
        ? isInstrumentWindow(c.time, pair)
        : fxSession != null
    const newsOk = !news
    const spreadOk = spreadPips <= maxSpread
    if (!(windowOk && newsOk && spreadOk)) continue

    const utFlipLong = ut > 0 && utPrev <= 0
    const utFlipShort = ut < 0 && utPrev >= 0
    if (!utFlipLong && !utFlipShort) continue

    const sslLong = ssl > 0
    const sslShort = ssl < 0
    const e21 = ema21Map.get(c.time)?.value
    const e55 = ema55Map.get(c.time)?.value
    const emaLong = !requireEma || (!!e21 && !!e55 && e21 > e55)
    const emaShort = !requireEma || (!!e21 && !!e55 && e21 < e55)

    let confirmLong = sslLong && emaLong
    let confirmShort = sslShort && emaShort
    const vwap = vwapMap.get(c.time)?.value
    if (requireVwap && vwap != null) {
      confirmLong = confirmLong && price >= vwap
      confirmShort = confirmShort && price <= vwap
    }

    let buy = utFlipLong && confirmLong
    let sell = utFlipShort && confirmShort

    const adxVal = adxMap.get(c.time)
    const adxOk = !adxVal || adxVal.adx >= SIMPLE.adxMin
    if ((buy || sell) && !adxOk) {
      buy = false
      sell = false
    }

    const w1 = wt1Map.get(c.time)?.value
    const w2 = wt2Map.get(c.time)?.value
    if (w1 != null && w2 != null) {
      const wtAbs = Math.abs(w1)
      if (buy && w1 < w2 && wtAbs >= SIMPLE.wtAgainstAbs) buy = false
      if (sell && w1 > w2 && wtAbs >= SIMPLE.wtAgainstAbs) sell = false
    }

    if (buy) {
      out.push({ time: c.time, side: 'BUY', price })
      lastSignalIndex = i
    } else if (sell) {
      out.push({ time: c.time, side: 'SELL', price })
      lastSignalIndex = i
    }
  }

  return out
}

/** Merge marker lists by time (prefer live/recent). */
export function mergeHistSignals(
  a: HistSignal[],
  b: HistSignal[],
): HistSignal[] {
  const map = new Map<number, HistSignal>()
  for (const s of a) map.set(s.time, s)
  for (const s of b) map.set(s.time, s)
  return [...map.values()].sort((x, y) => x.time - y.time)
}
