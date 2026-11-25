import type { PairMeta, Timeframe } from './pairs'
import { TIMEFRAMES } from './pairs'

export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

function mulberry32(seed: number) {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function timeframeSeconds(tf: Timeframe): number {
  return TIMEFRAMES.find((t) => t.id === tf)?.seconds ?? 3600
}

/** Deterministic sample OHLC series — labeled as sample in the UI. */
export function generateCandles(
  pair: PairMeta,
  timeframe: Timeframe,
  count = 240,
): Candle[] {
  const rand = mulberry32(pair.seed + timeframe.charCodeAt(0) * 97)
  const step = timeframeSeconds(timeframe)
  const now = Math.floor(Date.now() / 1000)
  const aligned = now - (now % step)
  const start = aligned - step * (count - 1)

  const candles: Candle[] = []
  let price = pair.open
  const volatility = pair.open * (pair.quote === 'JPY' ? 0.00035 : 0.00055)

  for (let i = 0; i < count; i++) {
    const drift = (rand() - 0.48) * volatility * 2.2
    const shock = rand() > 0.97 ? (rand() - 0.5) * volatility * 8 : 0
    const open = price
    const close = Math.max(pair.pip, open + drift + shock)
    const wickUp = rand() * volatility * 1.8
    const wickDown = rand() * volatility * 1.8
    const high = Math.max(open, close) + wickUp
    const low = Math.min(open, close) - wickDown
    const volume = 800 + Math.floor(rand() * 4200 + Math.abs(close - open) / pair.pip)

    candles.push({
      time: start + i * step,
      open: round(open, pair.digits),
      high: round(high, pair.digits),
      low: round(low, pair.digits),
      close: round(close, pair.digits),
      volume,
    })
    price = close
  }

  return candles
}

export function advanceCandle(
  candles: Candle[],
  pair: PairMeta,
  timeframe: Timeframe,
): Candle[] {
  if (candles.length === 0) return candles
  const step = timeframeSeconds(timeframe)
  const last = candles[candles.length - 1]
  const now = Math.floor(Date.now() / 1000)
  const tickNoise = (Math.random() - 0.5) * pair.pip * (2 + Math.random() * 4)
  const nextClose = Math.max(pair.pip, last.close + tickNoise)

  if (now >= last.time + step) {
    const open = last.close
    const close = nextClose
    const high = Math.max(open, close) + Math.random() * pair.pip * 2
    const low = Math.min(open, close) - Math.random() * pair.pip * 2
    const fresh: Candle = {
      time: last.time + step,
      open: round(open, pair.digits),
      high: round(high, pair.digits),
      low: round(low, pair.digits),
      close: round(close, pair.digits),
      volume: 600 + Math.floor(Math.random() * 3000),
    }
    return [...candles.slice(1), fresh]
  }

  const updated: Candle = {
    ...last,
    close: round(nextClose, pair.digits),
    high: round(Math.max(last.high, nextClose), pair.digits),
    low: round(Math.min(last.low, nextClose), pair.digits),
    volume: last.volume + Math.floor(Math.random() * 40),
  }
  return [...candles.slice(0, -1), updated]
}

function round(n: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}
