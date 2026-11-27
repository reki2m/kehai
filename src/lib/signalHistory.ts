/**
 * Replay KEHAI Peak Hunter entries across candle history.
 */

import {
  SESSION_PROFILES,
  detectFxSession,
  isFxWeekday,
  isInstrumentWindow,
  isNoonSignalWindow,
  sessionAwayFromEdge,
} from './apex'
import { estimateSpreadPips, newsBlackout } from './filters'
import {
  adx,
  atr,
  ema,
  rsi,
  sessionVwap,
  sslDirection,
  utBotTrail,
  wavetrend,
} from './indicators'
import type { Candle } from './marketData'
import type { PairMeta } from './pairs'
import { SIMPLE, type EntryTrack } from './simpleSignal'

export interface HistSignal {
  time: number
  side: 'BUY' | 'SELL'
  price: number
  prime?: boolean
  grade?: 'S' | 'A' | 'B' | 'C'
  track?: EntryTrack
  sizeHint?: number
}

export const HIST_FROM_UNIX = Date.UTC(2026, 10, 1) / 1000

function mapByTime<T extends { time: number }>(pts: T[]): Map<number, T> {
  return new Map(pts.map((p) => [p.time, p]))
}

export function listHistoricalSignals(
  candles: Candle[],
  pair?: PairMeta,
  fromUnix: number = HIST_FROM_UNIX,
): HistSignal[] {
  if (candles.length < 80) return []
  const pip = pair?.pip ?? SIMPLE.pip
  const out: HistSignal[] = []

  const profiles = [
    SESSION_PROFILES.tokyo,
    SESSION_PROFILES.london,
    SESSION_PROFILES.ny,
  ] as const

  const utByProfile = new Map<string, Map<number, number>>()
  const sslByLen = new Map<number, Map<number, number>>()

  for (const p of profiles) {
    const key = `${p.utKey}/${p.utAtr}`
    if (!utByProfile.has(key)) {
      const { direction } = utBotTrail(candles, p.utKey, p.utAtr)
      utByProfile.set(
        key,
        new Map(direction.map((d) => [d.time, d.value])),
      )
    }
    if (!sslByLen.has(p.sslLen)) {
      sslByLen.set(
        p.sslLen,
        new Map(sslDirection(candles, p.sslLen).map((d) => [d.time, d.value])),
      )
    }
  }
  if (!sslByLen.has(SIMPLE.htfSslLen)) {
    sslByLen.set(
      SIMPLE.htfSslLen,
      new Map(
        sslDirection(candles, SIMPLE.htfSslLen).map((d) => [d.time, d.value]),
      ),
    )
  }

  const vwapMap = mapByTime(sessionVwap(candles))
  const ema21Map = mapByTime(ema(candles, 21))
  const ema55Map = mapByTime(ema(candles, 55))
  const adxMap = mapByTime(adx(candles, 14))
  const atrMap = mapByTime(atr(candles, 14))
  const rsiMap = mapByTime(rsi(candles, 14))
  const { wt1, wt2 } = wavetrend(candles, 10, 21)
  const wt1Map = mapByTime(wt1)
  const wt2Map = mapByTime(wt2)
  const htfMap = sslByLen.get(SIMPLE.htfSslLen)!

  let lastSignalIndex = -9999

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!
    if (c.time < fromUnix) continue
    if (i - lastSignalIndex < SIMPLE.entryCooldownBars) continue

    const fxSession =
      !pair || pair.kind === 'fx' ? detectFxSession(c.time) : null
    const noonOk =
      !pair || pair.kind === 'fx' ? isNoonSignalWindow(c.time) : true
    const profile = fxSession
      ? SESSION_PROFILES[fxSession]
      : !pair || pair.kind === 'fx'
        ? SESSION_PROFILES.london
        : null
    if (!profile) continue

    const utMap = utByProfile.get(`${profile.utKey}/${profile.utAtr}`)
    const sslMap = sslByLen.get(profile.sslLen)
    if (!utMap || !sslMap) continue

    const prev = candles[i - 1]!
    const ut = utMap.get(c.time)
    const utPrev = utMap.get(prev.time)
    if (ut == null || utPrev == null) continue
    const ssl = sslMap.get(c.time)
    if (ssl == null) continue

    const atrVal = atrMap.get(c.time)?.value ?? 0
    const atrPips = atrVal > 0 ? atrVal / pip : 0
    const spreadPips =
      pair && pair.kind !== 'fx'
        ? Math.min(profile.maxSpread, 0.2)
        : estimateSpreadPips(c.time, atrPips || undefined)

    const news = pair?.kind === 'fx' ? newsBlackout(c.time) : null
    const windowOk =
      pair && pair.kind !== 'fx'
        ? isInstrumentWindow(c.time, pair)
        : isFxWeekday(c.time)
    if (
      !(
        windowOk &&
        !news &&
        spreadPips <= profile.maxSpread &&
        sessionAwayFromEdge(c.time, SIMPLE.sessionEdgeMin, fxSession) &&
        (atrPips <= 0 || atrPips >= SIMPLE.minAtrPips)
      )
    ) {
      continue
    }

    const utFlipLong = ut > 0 && utPrev <= 0
    const utFlipShort = ut < 0 && utPrev >= 0
    const sslLong = ssl > 0
    const sslShort = ssl < 0
    const htf = htfMap.get(c.time)
    const htfLong = htf != null && htf > 0
    const htfShort = htf != null && htf < 0
    const e21 = ema21Map.get(c.time)?.value
    const e55 = ema55Map.get(c.time)?.value
    const emaLong =
      !profile.requireEma || (!!e21 && !!e55 && e21 > e55)
    const emaShort =
      !profile.requireEma || (!!e21 && !!e55 && e21 < e55)

    let confirmLong = sslLong && emaLong
    let confirmShort = sslShort && emaShort
    const vwap = vwapMap.get(c.time)?.value
    if (profile.requireVwap && vwap != null) {
      confirmLong = confirmLong && c.close >= vwap
      confirmShort = confirmShort && c.close <= vwap
    }

    let buy = utFlipLong && confirmLong
    let sell = utFlipShort && confirmShort

    const adxFloor = noonOk ? SIMPLE.adxMin : SIMPLE.adxPrime
    const adxVal = adxMap.get(c.time)
    if (!adxVal || adxVal.adx < adxFloor) {
      buy = false
      sell = false
    }
    const diLong = !!adxVal && adxVal.plusDi > adxVal.minusDi
    const diShort = !!adxVal && adxVal.minusDi > adxVal.plusDi
    if (buy && !htfLong) buy = false
    if (sell && !htfShort) sell = false
    if (buy && !diLong) buy = false
    if (sell && !diShort) sell = false
    const w1 = wt1Map.get(c.time)?.value
    const w2 = wt2Map.get(c.time)?.value
    if (w1 == null || w2 == null) {
      buy = false
      sell = false
    } else {
      if (buy && !(w1 > w2)) buy = false
      if (sell && !(w1 < w2)) sell = false
    }
    const rv = rsiMap.get(c.time)?.value
    if (rv == null) {
      buy = false
      sell = false
    } else {
      if (buy && !(rv >= SIMPLE.rsiLongLo && rv <= SIMPLE.rsiLongHi))
        buy = false
      if (sell && !(rv >= SIMPLE.rsiShortLo && rv <= SIMPLE.rsiShortHi))
        sell = false
    }

    if (!buy && !sell) continue

    out.push({
      time: c.time,
      side: buy ? 'BUY' : 'SELL',
      price: c.close,
      prime: true,
      grade: adxVal && adxVal.adx >= 28 ? 'S' : 'A',
      track: 'honmei',
      sizeHint: 1,
    })
    lastSignalIndex = i
  }

  return out
}

export function mergeHistSignals(
  a: HistSignal[],
  b: HistSignal[],
): HistSignal[] {
  const map = new Map<number, HistSignal>()
  for (const s of a) map.set(s.time, s)
  for (const s of b) map.set(s.time, s)
  return [...map.values()].sort((x, y) => x.time - y.time)
}
