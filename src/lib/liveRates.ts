import type { Candle } from './marketData'
import type { PairId, Timeframe } from './pairs'
import { apiUrl, liveSnapshotUrl } from './http'

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

interface LiveSnapshot {
  candles?: Candle[]
  lastPrice?: number | null
  source?: string
  fetchedAt?: number
}

async function fetchSnapshot(
  pairId: PairId,
  timeframe: Timeframe,
): Promise<{ candles: Candle[]; lastPrice: number | null; source: string }> {
  const snapTf = timeframe === '4H' ? '1H' : timeframe
  let res = await fetch(liveSnapshotUrl(pairId, snapTf))
  // First deploy: live-data branch may not exist yet → Pages copy
  if (!res.ok && !import.meta.env.DEV) {
    const base = import.meta.env.BASE_URL || '/'
    res = await fetch(`${base}live/${pairId}_${snapTf}.json?t=${Date.now()}`)
  }
  if (!res.ok) throw new Error(`live ${res.status}`)
  const data = (await res.json()) as LiveSnapshot
  if (!data.candles || data.candles.length < 30) throw new Error('live empty')
  let out = data.candles.map((c) => ({ ...c }))
  if (timeframe === '4H') out = resample(out, 4)
  const lastPrice =
    data.lastPrice ?? (out.length ? out[out.length - 1].close : null)
  // Keep forming bar in sync with lastPrice so the chart visibly updates
  if (out.length && lastPrice != null) {
    const last = out[out.length - 1]
    last.close = lastPrice
    last.high = Math.max(last.high, lastPrice)
    last.low = Math.min(last.low, lastPrice)
  }
  const ageSec =
    data.fetchedAt != null
      ? Math.max(0, Math.round(Date.now() / 1000 - data.fetchedAt))
      : null
  const source =
    ageSec != null
      ? `Yahoo更新 ${ageSec < 90 ? `${ageSec}秒前` : `${Math.round(ageSec / 60)}分前`}`
      : (data.source ?? 'Yahoo更新')
  return {
    candles: out.slice(-360),
    lastPrice,
    source,
  }
}

async function fetchYahooDirect(
  pairId: PairId,
  timeframe: Timeframe,
): Promise<{ candles: Candle[]; lastPrice: number | null; source: string }> {
  const symbol = encodeURIComponent(YAHOO_SYMBOLS[pairId])
  const interval = TF_MAP[timeframe]
  const range = RANGE_MAP[timeframe]
  const url = apiUrl(
    `/api/yahoo/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`,
  )
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

  let out = candles
  if (timeframe === '4H') out = resample(candles, 4)

  const lastPrice =
    result?.meta?.regularMarketPrice ??
    (out.length ? out[out.length - 1].close : null)

  return { candles: out.slice(-360), lastPrice, source: 'Yahoo Finance' }
}

export async function fetchLiveCandles(
  pairId: PairId,
  timeframe: Timeframe,
): Promise<{ candles: Candle[]; lastPrice: number | null; source: string }> {
  // Production (GitHub Pages): same-origin snapshots from Actions.
  // Dev: Vite proxy to Yahoo.
  if (!import.meta.env.DEV) {
    try {
      return await fetchSnapshot(pairId, timeframe)
    } catch (e) {
      // last resort: unlikely to work in browser
      try {
        return await fetchYahooDirect(pairId, timeframe)
      } catch {
        throw e instanceof Error ? e : new Error(String(e))
      }
    }
  }
  return fetchYahooDirect(pairId, timeframe)
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
