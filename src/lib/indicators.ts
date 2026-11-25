import type { Candle } from './marketData'

export interface LinePoint {
  time: number
  value: number
}

export interface MacdPoint {
  time: number
  macd: number
  signal: number
  histogram: number
}

export interface BandPoint {
  time: number
  upper: number
  middle: number
  lower: number
}

function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close)
}

export function sma(candles: Candle[], period: number): LinePoint[] {
  const c = closes(candles)
  const out: LinePoint[] = []
  for (let i = period - 1; i < c.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += c[j]
    out.push({ time: candles[i].time, value: sum / period })
  }
  return out
}

export function ema(candles: Candle[], period: number): LinePoint[] {
  const c = closes(candles)
  if (c.length < period) return []
  const k = 2 / (period + 1)
  const out: LinePoint[] = []
  let prev = 0
  for (let i = 0; i < period; i++) prev += c[i]
  prev /= period
  out.push({ time: candles[period - 1].time, value: prev })
  for (let i = period; i < c.length; i++) {
    prev = c[i] * k + prev * (1 - k)
    out.push({ time: candles[i].time, value: prev })
  }
  return out
}

export function rsi(candles: Candle[], period = 14): LinePoint[] {
  const c = closes(candles)
  if (c.length <= period) return []
  const out: LinePoint[] = []
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = c[i] - c[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  gain /= period
  loss /= period
  const rs0 = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  out.push({ time: candles[period].time, value: rs0 })

  for (let i = period + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1]
    const g = d > 0 ? d : 0
    const l = d < 0 ? -d : 0
    gain = (gain * (period - 1) + g) / period
    loss = (loss * (period - 1) + l) / period
    const value = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
    out.push({ time: candles[i].time, value })
  }
  return out
}

export function macd(
  candles: Candle[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdPoint[] {
  const fastE = ema(candles, fast)
  const slowE = ema(candles, slow)
  if (slowE.length === 0) return []

  const macdLine: LinePoint[] = []
  const slowMap = new Map(slowE.map((p) => [p.time, p.value]))
  for (const p of fastE) {
    const s = slowMap.get(p.time)
    if (s !== undefined) macdLine.push({ time: p.time, value: p.value - s })
  }

  if (macdLine.length < signalPeriod) return []
  const k = 2 / (signalPeriod + 1)
  let sig = 0
  for (let i = 0; i < signalPeriod; i++) sig += macdLine[i].value
  sig /= signalPeriod

  const out: MacdPoint[] = []
  out.push({
    time: macdLine[signalPeriod - 1].time,
    macd: macdLine[signalPeriod - 1].value,
    signal: sig,
    histogram: macdLine[signalPeriod - 1].value - sig,
  })

  for (let i = signalPeriod; i < macdLine.length; i++) {
    sig = macdLine[i].value * k + sig * (1 - k)
    out.push({
      time: macdLine[i].time,
      macd: macdLine[i].value,
      signal: sig,
      histogram: macdLine[i].value - sig,
    })
  }
  return out
}

export function bollinger(
  candles: Candle[],
  period = 20,
  mult = 2,
): BandPoint[] {
  const c = closes(candles)
  const out: BandPoint[] = []
  for (let i = period - 1; i < c.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += c[j]
    const mid = sum / period
    let variance = 0
    for (let j = i - period + 1; j <= i; j++) {
      const d = c[j] - mid
      variance += d * d
    }
    const sd = Math.sqrt(variance / period)
    out.push({
      time: candles[i].time,
      upper: mid + mult * sd,
      middle: mid,
      lower: mid - mult * sd,
    })
  }
  return out
}

export function stochastic(
  candles: Candle[],
  period = 14,
  smooth = 3,
): { k: LinePoint[]; d: LinePoint[] } {
  const raw: LinePoint[] = []
  for (let i = period - 1; i < candles.length; i++) {
    let highest = -Infinity
    let lowest = Infinity
    for (let j = i - period + 1; j <= i; j++) {
      highest = Math.max(highest, candles[j].high)
      lowest = Math.min(lowest, candles[j].low)
    }
    const range = highest - lowest || 1
    const value = ((candles[i].close - lowest) / range) * 100
    raw.push({ time: candles[i].time, value })
  }

  const k = smoothLine(raw, smooth)
  const d = smoothLine(k, smooth)
  return { k, d }
}

function smoothLine(src: LinePoint[], period: number): LinePoint[] {
  const out: LinePoint[] = []
  for (let i = period - 1; i < src.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += src[j].value
    out.push({ time: src[i].time, value: sum / period })
  }
  return out
}

export function atr(candles: Candle[], period = 14): LinePoint[] {
  if (candles.length <= period) return []
  const trs: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    const prev = candles[i - 1]
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - prev.close),
        Math.abs(c.low - prev.close),
      ),
    )
  }
  const out: LinePoint[] = []
  let prev = 0
  for (let i = 0; i < period; i++) prev += trs[i]
  prev /= period
  out.push({ time: candles[period].time, value: prev })
  for (let i = period; i < trs.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period
    out.push({ time: candles[i + 1].time, value: prev })
  }
  return out
}

export interface AdxPoint {
  time: number
  adx: number
  plusDi: number
  minusDi: number
}

export function adx(candles: Candle[], period = 14): AdxPoint[] {
  if (candles.length <= period + 1) return []
  const plusDm: number[] = [0]
  const minusDm: number[] = [0]
  const tr: number[] = [0]
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high
    const down = candles[i - 1].low - candles[i].low
    plusDm.push(up > down && up > 0 ? up : 0)
    minusDm.push(down > up && down > 0 ? down : 0)
    tr.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - candles[i - 1].close),
        Math.abs(candles[i].low - candles[i - 1].close),
      ),
    )
  }

  let atrW = 0
  let plus = 0
  let minus = 0
  for (let i = 1; i <= period; i++) {
    atrW += tr[i]
    plus += plusDm[i]
    minus += minusDm[i]
  }

  const out: AdxPoint[] = []
  const dxSeries: number[] = []
  for (let i = period; i < candles.length; i++) {
    if (i > period) {
      atrW = atrW - atrW / period + tr[i]
      plus = plus - plus / period + plusDm[i]
      minus = minus - minus / period + minusDm[i]
    }
    const pdi = atrW > 0 ? (100 * plus) / atrW : 0
    const mdi = atrW > 0 ? (100 * minus) / atrW : 0
    const dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0
    dxSeries.push(dx)
    if (dxSeries.length < period) continue
    let adxVal: number
    if (dxSeries.length === period) {
      adxVal = dxSeries.reduce((a, b) => a + b, 0) / period
    } else {
      const prev = out[out.length - 1].adx
      adxVal = (prev * (period - 1) + dx) / period
    }
    out.push({
      time: candles[i].time,
      adx: adxVal,
      plusDi: pdi,
      minusDi: mdi,
    })
  }
  return out
}

/** Session VWAP (TradingView / LuxAlgo style) — resets each UTC day. */
export function sessionVwap(candles: Candle[]): LinePoint[] {
  const out: LinePoint[] = []
  let dayKey = ''
  let pv = 0
  let vol = 0
  for (const c of candles) {
    const d = new Date(c.time * 1000)
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
    if (key !== dayKey) {
      dayKey = key
      pv = 0
      vol = 0
    }
    const typical = (c.high + c.low + c.close) / 3
    const v = Math.max(1, c.volume || 1)
    pv += typical * v
    vol += v
    out.push({ time: c.time, value: pv / vol })
  }
  return out
}

/** True when Bollinger is inside Keltner (TradingView Squeeze style). */
export function bollingerSqueeze(
  candles: Candle[],
  bbPeriod = 20,
  bbMult = 2,
  kcMult = 1.5,
): { time: number; squeeze: boolean }[] {
  const bb = bollinger(candles, bbPeriod, bbMult)
  const a = atr(candles, bbPeriod)
  const atrMap = new Map(a.map((p) => [p.time, p.value]))
  const emaMid = ema(candles, bbPeriod)
  const midMap = new Map(emaMid.map((p) => [p.time, p.value]))
  const out: { time: number; squeeze: boolean }[] = []
  for (const b of bb) {
    const atrV = atrMap.get(b.time)
    const mid = midMap.get(b.time) ?? b.middle
    if (atrV === undefined) continue
    const kcUpper = mid + kcMult * atrV
    const kcLower = mid - kcMult * atrV
    out.push({
      time: b.time,
      squeeze: b.upper <= kcUpper && b.lower >= kcLower,
    })
  }
  return out
}

/** ATR Supertrend direction: +1 uptrend, -1 downtrend */
export function supertrendDirection(
  candles: Candle[],
  period = 10,
  mult = 2,
): LinePoint[] {
  const atrPts = atr(candles, period)
  if (atrPts.length === 0) return []
  const atrMap = new Map(atrPts.map((p) => [p.time, p.value]))
  const out: LinePoint[] = []
  let prevSt = 0
  let prevDir = 1

  for (let i = 0; i < candles.length; i++) {
    const a = atrMap.get(candles[i].time)
    if (a === undefined) continue
    const hl2 = (candles[i].high + candles[i].low) / 2
    let upper = hl2 + mult * a
    let lower = hl2 - mult * a
    let dir = prevDir
    let st = prevSt

    if (out.length === 0) {
      st = lower
      dir = 1
    } else if (prevDir >= 0) {
      lower = Math.max(lower, prevSt)
      if (candles[i].close < lower) {
        dir = -1
        st = upper
      } else {
        dir = 1
        st = lower
      }
    } else {
      upper = Math.min(upper, prevSt)
      if (candles[i].close > upper) {
        dir = 1
        st = lower
      } else {
        dir = -1
        st = upper
      }
    }
    out.push({ time: candles[i].time, value: dir })
    prevSt = st
    prevDir = dir
  }
  return out
}

/** UT Bot Alerts style ATR trailing direction (+1 / -1). TV: HPotter / QuantNomad. */
export function utBotDirection(
  candles: Candle[],
  key = 2,
  atrPeriod = 10,
): LinePoint[] {
  return utBotTrail(candles, key, atrPeriod).direction
}

/** UT Bot trail line + direction (for proximity / READY warnings). */
export function utBotTrail(
  candles: Candle[],
  key = 2,
  atrPeriod = 10,
): { direction: LinePoint[]; trail: LinePoint[] } {
  const atrPts = atr(candles, atrPeriod)
  if (atrPts.length === 0) return { direction: [], trail: [] }
  const atrMap = new Map(atrPts.map((p) => [p.time, p.value]))
  const direction: LinePoint[] = []
  const trailPts: LinePoint[] = []
  let prevTrail = NaN
  for (let i = 0; i < candles.length; i++) {
    const a = atrMap.get(candles[i].time)
    if (a === undefined) continue
    const c = candles[i].close
    const nloss = key * a
    let trail: number
    if (!Number.isFinite(prevTrail)) {
      trail = c - nloss
    } else if (c > prevTrail && candles[i - 1]?.close > prevTrail) {
      trail = Math.max(prevTrail, c - nloss)
    } else if (c < prevTrail && candles[i - 1]?.close < prevTrail) {
      trail = Math.min(prevTrail, c + nloss)
    } else if (c > prevTrail) {
      trail = c - nloss
    } else {
      trail = c + nloss
    }
    direction.push({ time: candles[i].time, value: c > trail ? 1 : -1 })
    trailPts.push({ time: candles[i].time, value: trail })
    prevTrail = trail
  }
  return { direction, trail: trailPts }
}

/** LazyBear WaveTrend — returns wt1 series; pair with wavetrendSignal for wt2. */
export function wavetrend(
  candles: Candle[],
  channel = 10,
  average = 21,
): { wt1: LinePoint[]; wt2: LinePoint[] } {
  if (candles.length < channel + average) return { wt1: [], wt2: [] }
  const ap = candles.map((c) => (c.high + c.low + c.close) / 3)
  // ESA of AP
  const kCh = 2 / (channel + 1)
  let esa = ap.slice(0, channel).reduce((s, v) => s + v, 0) / channel
  const esaArr: number[] = new Array(candles.length).fill(NaN)
  esaArr[channel - 1] = esa
  for (let i = channel; i < candles.length; i++) {
    esa = ap[i] * kCh + esa * (1 - kCh)
    esaArr[i] = esa
  }
  const absDev = ap.map((v, i) =>
    Number.isFinite(esaArr[i]) ? Math.abs(v - esaArr[i]) : NaN,
  )
  let d = absDev.slice(0, channel).reduce((s, v) => s + (v || 0), 0) / channel
  const dArr: number[] = new Array(candles.length).fill(NaN)
  dArr[channel - 1] = d
  for (let i = channel; i < candles.length; i++) {
    d = absDev[i] * kCh + d * (1 - kCh)
    dArr[i] = d
  }
  const ci = ap.map((v, i) =>
    Number.isFinite(esaArr[i]) && dArr[i] > 0
      ? (v - esaArr[i]) / (0.015 * dArr[i])
      : 0,
  )
  const kAvg = 2 / (average + 1)
  let wt = ci.slice(0, average).reduce((s, v) => s + v, 0) / average
  const wt1: LinePoint[] = []
  const wt1Vals: number[] = new Array(candles.length).fill(NaN)
  wt1Vals[average - 1] = wt
  wt1.push({ time: candles[average - 1].time, value: wt })
  for (let i = average; i < candles.length; i++) {
    wt = ci[i] * kAvg + wt * (1 - kAvg)
    wt1Vals[i] = wt
    wt1.push({ time: candles[i].time, value: wt })
  }
  const wt2: LinePoint[] = []
  for (let i = average * 2 - 2; i < candles.length; i++) {
    let sum = 0
    let ok = true
    for (let j = i - average + 1; j <= i; j++) {
      if (!Number.isFinite(wt1Vals[j])) {
        ok = false
        break
      }
      sum += wt1Vals[j]
    }
    if (ok) wt2.push({ time: candles[i].time, value: sum / average })
  }
  return { wt1, wt2 }
}

/** SSL Channel direction (+1 / -1). */
export function sslDirection(candles: Candle[], period = 10): LinePoint[] {
  const hi = ema(
    candles.map((c) => ({ ...c, close: c.high })),
    period,
  )
  const lo = ema(
    candles.map((c) => ({ ...c, close: c.low })),
    period,
  )
  const hiMap = new Map(hi.map((p) => [p.time, p.value]))
  const loMap = new Map(lo.map((p) => [p.time, p.value]))
  const out: LinePoint[] = []
  let hlv = 0
  for (const c of candles) {
    const mh = hiMap.get(c.time)
    const ml = loMap.get(c.time)
    if (mh === undefined || ml === undefined) continue
    if (c.close > mh) hlv = 1
    else if (c.close < ml) hlv = -1
    out.push({ time: c.time, value: hlv })
  }
  return out
}
