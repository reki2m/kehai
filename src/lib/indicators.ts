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
