import {
  BIQUOTE_SYMBOLS,
  fetchBiquoteCandles,
  fetchBiquoteQuote,
} from './biquote'
import type { Candle } from './marketData'
import type { PairId, Timeframe } from './pairs'
import { TIMEFRAMES } from './pairs'
import { apiUrl, liveSnapshotUrl, liveTickUrl } from './http'

export interface LiveQuote {
  price: number
  bid?: number
  ask?: number
  source: string
  at: number // unix sec
}

/** Yahoo Finance symbols for each instrument. */
export const YAHOO_SYMBOLS: Record<PairId, string> = {
  USDJPY: 'USDJPY=X',
  EURUSD: 'EURUSD=X',
  GBPJPY: 'GBPJPY=X',
  EURJPY: 'EURJPY=X',
  AUDUSD: 'AUDUSD=X',
  USDCHF: 'USDCHF=X',
  GBPUSD: 'GBPUSD=X',
  NZDUSD: 'NZDUSD=X',
  CADJPY: 'CADJPY=X',
  EURGBP: 'EURGBP=X',
  USOIL: 'CL=F',
  NIKKEI: 'NIY=F',
  DOW: 'YM=F',
  VIX: '^VIX',
}

/** Twelve Data symbols (browser CORS OK, demo key). */
export const TWELVE_SYMBOLS: Partial<Record<PairId, string>> = {
  USDJPY: 'USD/JPY',
  EURUSD: 'EUR/USD',
  GBPJPY: 'GBP/JPY',
  EURJPY: 'EUR/JPY',
  AUDUSD: 'AUD/USD',
  USDCHF: 'USD/CHF',
  GBPUSD: 'GBP/USD',
  NZDUSD: 'NZD/USD',
  CADJPY: 'CAD/JPY',
  EURGBP: 'EUR/GBP',
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

function tfSeconds(tf: Timeframe): number {
  return TIMEFRAMES.find((t) => t.id === tf)?.seconds ?? 60
}

async function fetchSnapshot(
  pairId: PairId,
  timeframe: Timeframe,
): Promise<{ candles: Candle[]; lastPrice: number | null; source: string }> {
  const snapTf = timeframe === '4H' ? '1H' : timeframe
  let res = await fetch(liveSnapshotUrl(pairId, snapTf))
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
  const step = tfSeconds(timeframe)
  out = sanitizeCandles(out, step)
  if (out.length && lastPrice != null) {
    const last = out[out.length - 1]!
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
      ? `Yahoo履歴 ${ageSec < 90 ? `${ageSec}秒前` : `${Math.round(ageSec / 60)}分前`}`
      : (data.source ?? 'Yahoo履歴')
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
  out = sanitizeCandles(out, tfSeconds(timeframe))

  const lastPrice =
    result?.meta?.regularMarketPrice ??
    (out.length ? out[out.length - 1]!.close : null)

  return { candles: out.slice(-360), lastPrice, source: 'Yahoo Finance' }
}

const TWELVE_INTERVAL: Partial<Record<Timeframe, string>> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '1H': '1h',
  '1D': '1day',
}

const TWELVE_KEY =
  (typeof import.meta !== 'undefined' &&
    (import.meta.env.VITE_TWELVE_API_KEY as string | undefined)) ||
  'demo'

function twelveUrl(path: string, symbol: string): string {
  return `https://api.twelvedata.com/${path}?symbol=${encodeURIComponent(symbol)}&apikey=${TWELVE_KEY}&_=${Date.now()}`
}

async function fetchTwelveQuote(pairId: PairId): Promise<LiveQuote | null> {
  const symbol = TWELVE_SYMBOLS[pairId]
  if (!symbol) return null
  const res = await fetch(twelveUrl('quote', symbol))
  if (!res.ok) throw new Error(`twelve quote ${res.status}`)
  const data = (await res.json()) as {
    close?: string
    last_quote_at?: number
    code?: number
    message?: string
  }
  if (data.code && data.code !== 200) throw new Error(data.message ?? 'quote error')
  const px = Number(data.close)
  if (!Number.isFinite(px)) return null
  return {
    price: px,
    source: 'Twelve',
    at: data.last_quote_at ?? Math.floor(Date.now() / 1000),
  }
}

async function fetchTwelvePrice(pairId: PairId): Promise<LiveQuote | null> {
  const symbol = TWELVE_SYMBOLS[pairId]
  if (!symbol) return null
  const res = await fetch(twelveUrl('price', symbol))
  if (!res.ok) throw new Error(`twelve price ${res.status}`)
  const data = (await res.json()) as { price?: string; code?: number; message?: string }
  if (data.code && data.code !== 200) throw new Error(data.message ?? 'price error')
  const px = Number(data.price)
  if (!Number.isFinite(px)) return null
  return {
    price: px,
    source: 'Twelve',
    at: Math.floor(Date.now() / 1000),
  }
}

/** CI が Swissquote/Yahoo で書いたティック（CORS不要・raw.githubusercontent） */
async function fetchSnapshotTick(pairId: PairId): Promise<LiveQuote | null> {
  const res = await fetch(liveTickUrl(pairId))
  if (!res.ok) throw new Error(`tick snap ${res.status}`)
  const data = (await res.json()) as {
    mid?: number
    bid?: number
    ask?: number
    lastPrice?: number
    fetchedAt?: number
    source?: string
  }
  const bid = data.bid != null && Number.isFinite(data.bid) ? data.bid : undefined
  const ask = data.ask != null && Number.isFinite(data.ask) ? data.ask : undefined
  const price =
    data.mid ??
    data.lastPrice ??
    (bid != null && ask != null ? (bid + ask) / 2 : null)
  if (price == null || !Number.isFinite(price)) return null
  return {
    price,
    bid,
    ask,
    source: data.source ?? 'live-data',
    at: data.fetchedAt ?? Math.floor(Date.now() / 1000),
  }
}

/**
 * 複数ソースを並列に取り、いちばん新しい（同点なら bid/ask 付き）を採用。
 * 優先: biquote（無料・CORS・bid/ask）→ Twelve → CI Swissquote tick。
 */
export async function fetchLiveQuote(pairId: PairId): Promise<LiveQuote | null> {
  const tasks: Promise<LiveQuote | null>[] = [
    fetchBiquoteQuote(pairId).catch(() => null),
    fetchTwelvePrice(pairId).catch(() => null),
    fetchTwelveQuote(pairId).catch(() => null),
    fetchSnapshotTick(pairId).catch(() => null),
  ]
  const results = (await Promise.all(tasks)).filter((q): q is LiveQuote => !!q)
  if (!results.length) return null
  results.sort((a, b) => {
    // Prefer biquote when within 3s of the freshest quote
    const freshest = Math.max(...results.map((r) => r.at))
    const aFresh = a.at >= freshest - 3 ? 1 : 0
    const bFresh = b.at >= freshest - 3 ? 1 : 0
    const aBq = a.source === 'biquote' && aFresh ? 2 : 0
    const bBq = b.source === 'biquote' && bFresh ? 2 : 0
    if (bBq !== aBq) return bBq - aBq
    if (b.at !== a.at) return b.at - a.at
    const aBa = a.bid != null && a.ask != null ? 1 : 0
    const bBa = b.bid != null && b.ask != null ? 1 : 0
    return bBa - aBa
  })
  return results[0]
}

/** @deprecated use fetchLiveQuote — kept for call sites expecting a number */
export async function fetchLiveTick(pairId: PairId): Promise<number | null> {
  const q = await fetchLiveQuote(pairId)
  return q?.price ?? null
}

/** Browser M1/M5 candles via Twelve Data (CORS) — fresher than GH Pages snapshots. */
export async function fetchTwelveCandles(
  pairId: PairId,
  timeframe: Timeframe,
): Promise<{ candles: Candle[]; lastPrice: number | null; source: string }> {
  const symbol = TWELVE_SYMBOLS[pairId]
  const interval =
    timeframe === '4H' ? '1h' : (TWELVE_INTERVAL[timeframe] ?? '1min')
  if (!symbol) throw new Error('twelve symbol missing')
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=300&apikey=${TWELVE_KEY}&_=${Date.now()}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`twelve ${res.status}`)
  const data = (await res.json()) as {
    values?: Array<{
      datetime: string
      open: string
      high: string
      low: string
      close: string
    }>
    code?: number
    message?: string
  }
  if (data.code && data.code !== 200) throw new Error(data.message ?? 'twelve error')
  if (!data.values?.length) throw new Error('twelve empty')
  // Twelve returns newest-first
  let candles: Candle[] = data.values
    .slice()
    .reverse()
    .map((v) => {
      const t = Math.floor(new Date(v.datetime.replace(' ', 'T') + 'Z').getTime() / 1000)
      return {
        time: t,
        open: Number(v.open),
        high: Number(v.high),
        low: Number(v.low),
        close: Number(v.close),
        volume: 0,
      }
    })
    .filter(
      (c) =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.close),
    )
  if (timeframe === '4H') candles = resample(candles, 4)
  candles = sanitizeCandles(candles)
  if (candles.length < 30) throw new Error('twelve short')
  const lastPrice = candles[candles.length - 1].close
  return { candles: candles.slice(-360), lastPrice, source: 'Twelve Data' }
}

/** Align unix time down to the timeframe bucket (drops Yahoo fetchAt junk tips). */
export function alignBarTime(unixSec: number, stepSec: number): number {
  if (!(stepSec > 0) || !Number.isFinite(unixSec)) return unixSec
  return unixSec - (unixSec % stepSec)
}

/** Archive under live tip — live bars win; never re-inject a stale/unaligned tip. */
export function mergeArchiveCandles(
  archive: Candle[],
  live: Candle[],
  stepSec = 60,
): Candle[] {
  const liveClean = sanitizeCandles(live, stepSec)
  if (!archive.length) return liveClean
  if (!liveClean.length) return sanitizeCandles(archive, stepSec)
  const liveLast = liveClean[liveClean.length - 1]!.time
  const byTime = new Map<number, Candle>()
  for (const c of sanitizeCandles(archive, stepSec)) {
    // Keep archive strictly before the live tip bucket
    if (c.time >= liveLast) continue
    byTime.set(c.time, c)
  }
  for (const c of liveClean) {
    byTime.set(c.time, c)
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => c)
}

/**
 * Keep ascending unique times and valid OHLC for lightweight-charts.
 * Aligns to stepSec so fetchAt / quote stamps cannot create a rogue tip bar.
 */
export function sanitizeCandles(
  candles: Candle[],
  stepSec = 60,
): Candle[] {
  const byTime = new Map<number, Candle>()
  for (const c of candles) {
    if (!Number.isFinite(c.time) || !Number.isFinite(c.close)) continue
    const time = alignBarTime(c.time, stepSec)
    const open = Number.isFinite(c.open) ? c.open : c.close
    const close = c.close
    const high = Math.max(
      open,
      close,
      Number.isFinite(c.high) ? c.high : close,
    )
    const low = Math.min(open, close, Number.isFinite(c.low) ? c.low : close)
    const volume = Math.max(0, c.volume || 0)
    const prev = byTime.get(time)
    if (prev) {
      byTime.set(time, {
        time,
        open: prev.open,
        high: Math.max(prev.high, high),
        low: Math.min(prev.low, low),
        close,
        volume: Math.max(prev.volume || 0, volume),
      })
    } else {
      byTime.set(time, { time, open, high, low, close, volume })
    }
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => c)
}

/** Apply a live price onto the current timeframe bar (opens a new bar when needed). */
export function applyLiveTick(
  candles: Candle[],
  price: number,
  timeframe: Timeframe,
): Candle[] {
  if (!candles.length || !Number.isFinite(price)) return candles
  const step = tfSeconds(timeframe)
  const now = Math.floor(Date.now() / 1000)
  const barTime = alignBarTime(now, step)
  // Avoid full sanitize on every tick — history can be 20k+ bars (Nov archive).
  const out = candles.slice()
  let last = { ...out[out.length - 1]! }
  // Repair a rogue unaligned tip (Yahoo fetchAt / quote stamp) in place
  if (last.time !== alignBarTime(last.time, step)) {
    last = { ...last, time: alignBarTime(last.time, step) }
    // If alignment collapses onto the previous bar, merge then drop the tip
    if (out.length >= 2 && out[out.length - 2]!.time === last.time) {
      const prev = out[out.length - 2]!
      out[out.length - 2] = {
        time: prev.time,
        open: prev.open,
        high: Math.max(prev.high, last.high, price),
        low: Math.min(prev.low, last.low, price),
        close: price,
        volume: Math.max(prev.volume || 0, last.volume || 0) + 1,
      }
      out.pop()
      return out
    }
    out[out.length - 1] = last
  }
  // Never rewrite last.time backward — that duplicates the previous bar and crashes the chart.
  if (last.time < barTime) {
    out.push({
      time: barTime,
      open: price,
      high: price,
      low: price,
      close: price,
      // FX often has no notional volume — count ticks as activity
      volume: 1,
    })
    return out
  }
  // If tip is somehow ahead of "now" bucket, snap it back to the live bucket
  if (last.time > barTime) {
    last = {
      time: barTime,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: Math.max(1, last.volume || 0),
    }
    out[out.length - 1] = last
    return out
  }
  last.close = price
  last.high = Math.max(last.high, price)
  last.low = Math.min(last.low, price)
  last.volume = (last.volume || 0) + 1
  out[out.length - 1] = last
  return out
}

/**
 * リモート足で履歴を更新しつつ、ローカルで進めた形成中足は潰さない。
 * （Twelve の遅延 OHLC で毎20秒チャートが巻き戻るのが遅さの主因だった）
 */
export function mergeRemoteCandles(
  remote: Candle[],
  local: Candle[],
  timeframe: Timeframe,
  livePrice?: number | null,
): Candle[] {
  const step = tfSeconds(timeframe)
  const now = Math.floor(Date.now() / 1000)
  const barTime = alignBarTime(now, step)
  const remoteClean = sanitizeCandles(remote, step)
  const localClean = sanitizeCandles(local, step)
  if (!localClean.length) {
    let out = remoteClean
    if (livePrice != null) out = applyLiveTick(out, livePrice, timeframe)
    return out
  }
  const localLast = localClean[localClean.length - 1]!
  // リモートは「今のバーより前」だけ採用
  const hist = remoteClean.filter((c) => c.time < barTime)
  const byTime = new Map<number, Candle>()
  for (const c of hist) byTime.set(c.time, { ...c })
  // ローカルの過去バーも穴埋めに使う
  for (const c of localClean) {
    if (c.time < barTime && !byTime.has(c.time)) byTime.set(c.time, { ...c })
  }
  let out = [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c]) => c)

  const localForming = localLast.time >= barTime ? localLast : null
  const remoteForming = remoteClean.find((c) => c.time === barTime)
  let forming: Candle
  if (localForming) {
    // Local tip owns close/volume — remote may only widen the range / set open
    forming = { ...localForming, time: barTime }
    if (remoteForming) {
      forming.open = remoteForming.open
      forming.high = Math.max(forming.high, remoteForming.high, forming.close)
      forming.low = Math.min(forming.low, remoteForming.low, forming.close)
      if ((remoteForming.volume || 0) > (forming.volume || 0)) {
        forming.volume = remoteForming.volume
      }
    }
  } else if (remoteForming) {
    forming = { ...remoteForming, time: barTime }
  } else {
    const seed =
      livePrice ??
      (out.length ? out[out.length - 1]!.close : null)
    if (seed == null) return out.slice(-360)
    forming = {
      time: barTime,
      open: seed,
      high: seed,
      low: seed,
      close: seed,
      volume: 0,
    }
  }
  if (livePrice != null && Number.isFinite(livePrice)) {
    forming.close = livePrice
    forming.high = Math.max(forming.high, livePrice)
    forming.low = Math.min(forming.low, livePrice)
  }
  out.push(forming)
  return out.slice(-360)
}

/**
 * Never let a remote/archive refresh rewind the tip behind what the user
 * already sees (or strip the live quote off the forming bar).
 */
export function preserveLiveTip(
  prev: Candle[],
  next: Candle[],
  livePrice: number | null | undefined,
): Candle[] {
  if (!next.length) return next
  if (!prev.length) {
    if (livePrice == null || !Number.isFinite(livePrice)) return next
    const tip = { ...next[next.length - 1]! }
    tip.close = livePrice
    tip.high = Math.max(tip.high, livePrice)
    tip.low = Math.min(tip.low, livePrice)
    return [...next.slice(0, -1), tip]
  }
  const p = prev[prev.length - 1]!
  const n = next[next.length - 1]!
  if (p.time > n.time) {
    const base = next.filter((c) => c.time < p.time)
    const close =
      livePrice != null && Number.isFinite(livePrice) ? livePrice : p.close
    base.push({
      ...p,
      close,
      high: Math.max(p.high, close),
      low: Math.min(p.low, close),
    })
    return base
  }
  if (p.time === n.time) {
    const close =
      livePrice != null && Number.isFinite(livePrice) ? livePrice : n.close
    return [
      ...next.slice(0, -1),
      {
        ...n,
        close,
        high: Math.max(n.high, p.high, close),
        low: Math.min(n.low, p.low, close),
        volume: Math.max(n.volume || 0, p.volume || 0),
      },
    ]
  }
  return next
}

export async function fetchLiveCandles(
  pairId: PairId,
  timeframe: Timeframe,
): Promise<{ candles: Candle[]; lastPrice: number | null; source: string }> {
  // Browser: biquote first (free CORS), then Twelve, then snapshot/Yahoo.
  if (BIQUOTE_SYMBOLS[pairId]) {
    try {
      const live = await fetchBiquoteCandles(pairId, timeframe)
      return {
        ...live,
        candles: sanitizeCandles(live.candles, tfSeconds(timeframe)),
      }
    } catch {
      /* fall through */
    }
  }
  if (TWELVE_SYMBOLS[pairId]) {
    try {
      return await fetchTwelveCandles(pairId, timeframe)
    } catch {
      /* fall through */
    }
  }
  if (!import.meta.env.DEV) {
    try {
      return await fetchSnapshot(pairId, timeframe)
    } catch (e) {
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
