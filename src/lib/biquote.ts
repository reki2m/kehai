/**
 * Free realtime FX/CFD feed from biquote (MT5-sourced).
 * REST + SignalR — no API key. Not the same as GMO board.
 */

import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr'
import type { Candle } from './marketData'
import type { PairId, Timeframe } from './pairs'

export interface BiquoteQuote {
  price: number
  bid?: number
  ask?: number
  source: string
  at: number
}

const BASE = 'https://biquote.io'

/** KEHAI pair → biquote symbol (blank = unsupported). */
export const BIQUOTE_SYMBOLS: Partial<Record<PairId, string>> = {
  USDJPY: 'USDJPY',
  EURUSD: 'EURUSD',
  GBPJPY: 'GBPJPY',
  EURJPY: 'EURJPY',
  AUDUSD: 'AUDUSD',
  USDCHF: 'USDCHF',
  USOIL: 'USOIL',
  NIKKEI: 'JP225',
  DOW: 'US30',
}

const OHLC_INTERVAL: Partial<Record<Timeframe, string>> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1H': '1h',
  '4H': '4h',
  '1D': '1d',
}

export interface BiquoteTick {
  symbol: string
  bid?: number
  ask?: number
  mid?: number
  spread?: number
  timestamp?: string
  lastQuoteAt?: string
  quoteAgeSeconds?: number
  stale?: boolean
  marketState?: string
  source?: string
}

function parseAt(tick: BiquoteTick): number {
  const raw = tick.lastQuoteAt || tick.timestamp
  if (raw) {
    const ms = Date.parse(raw)
    if (Number.isFinite(ms)) return Math.floor(ms / 1000)
  }
  const age = tick.quoteAgeSeconds
  if (typeof age === 'number' && Number.isFinite(age)) {
    return Math.floor(Date.now() / 1000 - Math.max(0, age))
  }
  return Math.floor(Date.now() / 1000)
}

export function tickToQuote(tick: BiquoteTick): BiquoteQuote | null {
  const bid = Number.isFinite(tick.bid) ? tick.bid : undefined
  const ask = Number.isFinite(tick.ask) ? tick.ask : undefined
  const mid =
    Number.isFinite(tick.mid) && tick.mid != null
      ? tick.mid
      : bid != null && ask != null
        ? (bid + ask) / 2
        : null
  if (mid == null || !Number.isFinite(mid)) return null
  if (tick.stale && (tick.quoteAgeSeconds ?? 0) > 30) return null
  return {
    price: mid,
    bid,
    ask,
    source: 'biquote',
    at: parseAt(tick),
  }
}

export async function fetchBiquoteQuote(
  pairId: PairId,
): Promise<BiquoteQuote | null> {
  const symbol = BIQUOTE_SYMBOLS[pairId]
  if (!symbol) return null
  const res = await fetch(
    `${BASE}/api/${encodeURIComponent(symbol)}?allowStale=false&_=${Date.now()}`,
  )
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`biquote ${res.status}`)
  const data = (await res.json()) as BiquoteTick
  return tickToQuote(data)
}

export async function fetchBiquoteCandles(
  pairId: PairId,
  timeframe: Timeframe,
): Promise<{ candles: Candle[]; lastPrice: number | null; source: string }> {
  const symbol = BIQUOTE_SYMBOLS[pairId]
  const interval = OHLC_INTERVAL[timeframe]
  if (!symbol || !interval) throw new Error('biquote symbol/interval missing')
  const url = `${BASE}/api/${encodeURIComponent(symbol)}/ohlc?interval=${interval}&limit=360&_=${Date.now()}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`biquote ohlc ${res.status}`)
  const data = (await res.json()) as {
    bars?: Array<{
      openTime: string
      open: number
      high: number
      low: number
      close: number
      volume?: number
      tickVolume?: number
    }>
  }
  if (!data.bars?.length) throw new Error('biquote ohlc empty')
  // newest-first → oldest-first; dedupe later in liveRates.sanitizeCandles
  const candles: Candle[] = []
  const seen = new Set<number>()
  for (const b of data.bars.slice().reverse()) {
    const time = Math.floor(Date.parse(b.openTime) / 1000)
    if (!Number.isFinite(time) || seen.has(time)) continue
    if (![b.open, b.high, b.low, b.close].every(Number.isFinite)) continue
    seen.add(time)
    candles.push({
      time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.tickVolume ?? b.volume ?? 0,
    })
  }
  if (candles.length < 30) throw new Error('biquote ohlc short')
  const lastPrice = candles[candles.length - 1].close
  return { candles: candles.slice(-360), lastPrice, source: 'biquote' }
}

export type BiquoteTickHandler = (quote: BiquoteQuote) => void

/**
 * Push ticks over SignalR. Returns a stop() disposer.
 * Falls back silently if the hub cannot connect.
 */
export function subscribeBiquoteTicks(
  pairId: PairId,
  onTick: BiquoteTickHandler,
): () => void {
  const symbol = BIQUOTE_SYMBOLS[pairId]
  if (!symbol) return () => {}

  let stopped = false
  let conn: HubConnection | null = null

  const connection = new HubConnectionBuilder()
    .withUrl(`${BASE}/hubs/tick`)
    .withAutomaticReconnect([0, 1000, 2000, 5000, 10000])
    .configureLogging(LogLevel.None)
    .build()

  conn = connection

  connection.on('ReceiveTick', (raw: BiquoteTick | BiquoteTick[]) => {
    if (stopped) return
    const ticks = Array.isArray(raw) ? raw : [raw]
    for (const t of ticks) {
      if (t?.symbol && t.symbol !== symbol) continue
      const q = tickToQuote(t)
      if (q) onTick(q)
    }
  })

  void (async () => {
    try {
      await connection.start()
      if (stopped) {
        await connection.stop().catch(() => {})
        return
      }
      // Hub accepts a single symbol or an array depending on version
      try {
        await connection.invoke('Subscribe', [symbol])
      } catch {
        await connection.invoke('Subscribe', symbol)
      }
    } catch {
      /* REST poll remains the fallback */
    }
  })()

  return () => {
    stopped = true
    if (conn && conn.state !== HubConnectionState.Disconnected) {
      void conn.stop().catch(() => {})
    }
    conn = null
  }
}
