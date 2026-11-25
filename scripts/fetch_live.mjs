#!/usr/bin/env node
/**
 * Fetch Yahoo M1 (and key TFs) into public/live/*.json for GitHub Pages.
 * Run in Actions (server-side) — browser CORS cannot hit Yahoo.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'live')

const SYMBOLS = {
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

const TFS = {
  '1m': { interval: '1m', range: '5d' },
  '5m': { interval: '5m', range: '10d' },
  '15m': { interval: '15m', range: '1mo' },
  '1H': { interval: '60m', range: '3mo' },
  '1D': { interval: '1d', range: '2y' },
}

async function fetchChart(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 KEHAI-live-fetcher' },
  })
  if (!res.ok) throw new Error(`Yahoo ${res.status} ${symbol}`)
  return res.json()
}

function toCandles(data) {
  const result = data?.chart?.result?.[0]
  const ts = result?.timestamp ?? []
  const q = result?.indicators?.quote?.[0]
  if (!q || !ts.length) throw new Error('empty chart')
  const candles = []
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
  const lastPrice =
    result?.meta?.regularMarketPrice ??
    (candles.length ? candles[candles.length - 1].close : null)
  return { candles: candles.slice(-360), lastPrice }
}

mkdirSync(OUT, { recursive: true })
const fetchedAt = Math.floor(Date.now() / 1000)
let ok = 0
let fail = 0

for (const [pairId, symbol] of Object.entries(SYMBOLS)) {
  for (const [tf, { interval, range }] of Object.entries(TFS)) {
    try {
      const data = await fetchChart(symbol, interval, range)
      const { candles, lastPrice } = toCandles(data)
      const payload = {
        pairId,
        timeframe: tf,
        source: 'Yahoo Finance',
        fetchedAt,
        lastPrice,
        candles,
      }
      const path = join(OUT, `${pairId}_${tf}.json`)
      writeFileSync(path, JSON.stringify(payload))
      ok++
      console.log('ok', pairId, tf, lastPrice, candles.length)
      await new Promise((r) => setTimeout(r, 200))
    } catch (e) {
      fail++
      console.error('fail', pairId, tf, e.message || e)
    }
  }
}

writeFileSync(
  join(OUT, 'meta.json'),
  JSON.stringify({ fetchedAt, ok, fail }, null, 2),
)
console.log('done', { ok, fail, fetchedAt })
if (ok === 0) process.exit(1)
