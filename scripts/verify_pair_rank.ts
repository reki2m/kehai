/**
 * Rank FX pairs under locked Peak Drive (SL12/TP24/hold90).
 * Also report recent ATR vs Peak verification window.
 */
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from 'fs'
import { getPair, type PairId } from '../src/lib/pairs.ts'
import { listHistoricalSignals } from '../src/lib/signalHistory.ts'
import { simulateHistTrades } from '../src/lib/histTrades.ts'
import { SIMPLE } from '../src/lib/simpleSignal.ts'
import { atr } from '../src/lib/indicators.ts'
import type { Candle } from '../src/lib/marketData.ts'

function loadCandles(path: string): Candle[] {
  const j = JSON.parse(readFileSync(path, 'utf8'))
  const arr = Array.isArray(j) ? j : j.candles
  const by = new Map<number, Candle>()
  for (const c of arr) {
    by.set(c.time, {
      time: c.time,
      open: +c.open,
      high: +c.high,
      low: +c.low,
      close: +c.close,
      volume: +(c.volume ?? 0),
    })
  }
  return [...by.values()].sort((a, b) => a.time - b.time)
}

function avgAtrPips(candles: Candle[], pip: number): number {
  const a = atr(candles, 14)
  if (!a.length) return 0
  return a.reduce((s, x) => s + x.value / pip, 0) / a.length
}

function dayRangePips(candles: Candle[], pip: number): number {
  const by = new Map<string, { h: number; l: number }>()
  for (const c of candles) {
    const d = new Date(c.time * 1000).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Tokyo',
    })
    const cur = by.get(d) ?? { h: -Infinity, l: Infinity }
    cur.h = Math.max(cur.h, c.high)
    cur.l = Math.min(cur.l, c.low)
    by.set(d, cur)
  }
  const ranges = [...by.values()].map((v) => (v.h - v.l) / pip)
  if (!ranges.length) return 0
  return ranges.reduce((s, v) => s + v, 0) / ranges.length
}

function runPair(pairId: PairId, candles: Candle[], label: string) {
  const pair = getPair(pairId)
  if (candles.length < 200) {
    return { pairId, label, skip: 'short', n: 0 }
  }
  const from = candles[120]!.time
  const sigs = listHistoricalSignals(candles, pair, from)
  const sum = simulateHistTrades(candles, sigs, pair)
  const daily = sum.days > 0 ? sum.netPips / sum.days : 0
  const atrP = avgAtrPips(candles, pair.pip)
  const dayR = dayRangePips(candles, pair.pip)
  return {
    pairId,
    label: pair.label,
    source: label,
    bars: candles.length,
    atrM1: Math.round(atrP * 100) / 100,
    dayRange: Math.round(dayR * 10) / 10,
    n: sum.n,
    tpd: sum.tradesPerDay,
    wr: sum.winRate,
    ev: sum.evPips,
    daily: Math.round(daily * 100) / 100,
    net: Math.round(sum.netPips * 10) / 10,
    days: sum.days,
    worst: sum.trades.length
      ? Math.min(...sum.trades.map((t) => t.pnlPips))
      : 0,
  }
}

const S = SIMPLE as any
S.slPips = 12
S.tpPips = 24
S.useFixedRisk = true
S.slMin = 12
S.slMax = 12
S.tpMin = 24
S.tpMax = 24
S.maxHoldBars = 90

const rows: any[] = []

// 1) USDJPY Peak lock window Aug–Oct
{
  const files = [
    'backtest/data/usdjpy_m1_dukascopy_2026aug.json',
    'backtest/data/usdjpy_m1_dukascopy_2026sep.json',
    'backtest/data/usdjpy_m1_dukascopy_2026oct.json',
  ]
  const by = new Map<number, Candle>()
  for (const f of files) {
    if (!existsSync(f)) continue
    for (const c of loadCandles(f)) by.set(c.time, c)
  }
  const c = [...by.values()].sort((a, b) => a.time - b.time)
  rows.push(runPair('USDJPY', c, 'duka_aug_oct'))
}

// 2) USDJPY Nov hist (recent)
if (existsSync('public/live/hist_USDJPY_1m.json')) {
  rows.push(
    runPair('USDJPY', loadCandles('public/live/hist_USDJPY_1m.json'), 'hist_nov'),
  )
}

// 3) Multi-pair Oct duka if present
const multiDir = 'backtest/data/duka_multi'
if (existsSync(multiDir)) {
  for (const f of readdirSync(multiDir).sort()) {
    const m = f.match(/^([A-Z]+)_m1_2026oct\.json$/)
    if (!m) continue
    const id = m[1] as PairId
    try {
      getPair(id)
    } catch {
      continue
    }
    rows.push(runPair(id, loadCandles(`${multiDir}/${f}`), 'duka_oct'))
  }
}

// 4) Yahoo recent ~4d fallback / supplement
const ydir = 'backtest/data/yahoo_fx_5d'
if (existsSync(ydir)) {
  for (const f of readdirSync(ydir).sort()) {
    const m = f.match(/^([A-Z]+)_1m\.json$/)
    if (!m) continue
    const id = m[1] as PairId
    try {
      getPair(id)
    } catch {
      continue
    }
    rows.push(runPair(id, loadCandles(`${ydir}/${f}`), 'yahoo_5d'))
  }
}

mkdirSync('backtest/out', { recursive: true })
writeFileSync('backtest/out/pair_rank.json', JSON.stringify(rows, null, 2))

console.log('\n=== SL=損切 / TP=利確 · Peak Drive fixed 12/24 ===\n')
const oct = rows.filter((r) => r.source === 'duka_oct' && r.n > 0)
const y5 = rows.filter((r) => r.source === 'yahoo_5d' && r.n > 0)
const usdjpy = rows.filter((r) => r.pairId === 'USDJPY')

console.log('USDJPY windows:')
for (const r of usdjpy) console.log(JSON.stringify(r))

if (oct.length) {
  console.log('\nOCT dukascopy rank by daily:')
  for (const r of [...oct].sort((a, b) => b.daily - a.daily)) {
    console.log(
      r.pairId.padEnd(8),
      'daily',
      String(r.daily).padStart(6),
      'ev',
      String(r.ev).padStart(6),
      'tpd',
      r.tpd,
      'wr',
      r.wr,
      'atr',
      r.atrM1,
      'dayR',
      r.dayRange,
      'n',
      r.n,
    )
  }
}

console.log('\nYahoo ~4d (noisy, few trades):')
for (const r of [...y5].sort((a, b) => b.daily - a.daily)) {
  console.log(
    r.pairId.padEnd(8),
    'daily',
    r.daily,
    'ev',
    r.ev,
    'n',
    r.n,
    'atr',
    r.atrM1,
    'dayR',
    r.dayRange,
  )
}
