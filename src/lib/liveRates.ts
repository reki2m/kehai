import type { Candle } from './marketData'
import type { PairId, Timeframe } from './pairs'

/** Yahoo Finance symbols for each instrument. */
export const YAHOO_SYMBOLS: Record<PairId, string> = {
  USDJPY: 'USDJPY=X',
  EURUSD: 'EURUSD=X',
  GBPJPY: 'GBPJPY=X',
  EURJPY: 'EURJPY=X',
  AUDUSD: 'AUDUSD=X',
  USDCHF: 'USDCHF=X',
  USOIL: 'CL=F',
  NIKKEI: 'NIY=F',
  DOW: 'YM=F',
  VIX: '^VIX',
}

const TF_MAP: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1H': '60m',
  '4H': '60m',
  '1D': '1d',
}

const RANGE_MAP: Record<Timeframe, string> = {
  '1m': '5d',
  '5m': '10d',
  '15m': '1mo',
  '1H': '3mo',
  '4H': '6mo',
  '1D': '2y',
}

interface YahooChart {
  chart?: {
    result?: Array<{
      timestamp?: number[]
      indicators?: {
        quote?: Array<{
          open?: (number | null)[]
          high?: (number | null)[]
          low?: (number | null)[]
          close?: (number | null)[]
          volume?: (number | null)[]
        }>
      }
      meta?: { regularMarketPrice?: number }
    }>
    error?: { description?: string }
  }
}

export async function fetchLiveCandles(
  pairId: PairId,
  timeframe: Timeframe,
): Promise<{ candles: Candle[]; lastPrice: number | null; source: string }> {
  const symbol = encodeURIComponent(YAHOO_SYMBOLS[pairId])
  const interval = TF_MAP[timeframe]
  const range = RANGE_MAP[timeframe]
  const url = `/api/yahoo/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Yahoo ${res.status}`)
  const data = (await res.json()) as YahooChart
  if (data.chart?.error) throw new Error(data.chart.error.description ?? 'Yahoo error')
  const result = data.chart?.result?.[0]
  const ts = result?.timestamp ?? []
  const q = result?.indicators?.quote?.[0]
  if (!q || ts.length === 0) throw new Error('Yahoo empty')

  const candles: Candle[] = []
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i]
    const h = q.high?.[i]
    const l = q.low?.[i]
    const c = q.close?.[i]
    if (o == null || h == null || l == null || c == null) continue
    candles.push({
      time: ts[i],
      open: o,
      high: h,
      low: l,
      close: c,
      volume: q.volume?.[i] ?? 0,
    })
  }

  // 4H: resample from 60m
  let out = candles
  if (timeframe === '4H') out = resample(candles, 4)

  const lastPrice =
    result?.meta?.regularMarketPrice ??
    (out.length ? out[out.length - 1].close : null)

  return { candles: out.slice(-360), lastPrice, source: 'Yahoo Finance' }
}

function resample(candles: Candle[], group: number): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < candles.length; i += group) {
    const chunk = candles.slice(i, i + group)
    if (chunk.length === 0) continue
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
    })
  }
  return out
}
