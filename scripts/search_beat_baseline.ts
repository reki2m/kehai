/**
 * Slim hunt: strictly beat baseline daily on live-path metrics.
 * Baseline Peak: HTF+WT+DI+RSI · ADX24/28 · cool5 · SL10/TP20
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { getPair } from '../src/lib/pairs.ts'
import { listHistoricalSignals } from '../src/lib/signalHistory.ts'
import { simulateHistTrades } from '../src/lib/histTrades.ts'
import { SIMPLE } from '../src/lib/simpleSignal.ts'
import type { Candle } from '../src/lib/marketData.ts'

function load(files: string[]) {
  const by = new Map<number, any>()
  for (const f of files) {
    if (!existsSync(f)) continue
    for (const c of JSON.parse(readFileSync(f, 'utf8'))) by.set(c.time, c)
  }
  return [...by.values()]
    .map((c) => ({
      time: c.time,
      open: +c.open,
      high: +c.high,
      low: +c.low,
      close: +c.close,
      volume: 0,
    }))
    .sort((a, b) => a.time - b.time) as Candle[]
}

const candles = load([
  'backtest/data/usdjpy_m1_dukascopy_2026aug.json',
  'backtest/data/usdjpy_m1_dukascopy_2026sep.json',
  'backtest/data/usdjpy_m1_dukascopy_2026oct.json',
])
const pair = getPair('USDJPY')
const from = candles[200]!.time
const S = SIMPLE as any

type Cfg = {
  label: string
  adxMin: number
  adxPrime: number
  cool: number
  htf: boolean
  wt: boolean
  di: boolean
  rsi: boolean
  sl: number
  tp: number
  hold: number
}

function apply(cfg: Cfg) {
  S.adxMin = cfg.adxMin
  S.adxPrime = cfg.adxPrime
  S.entryCooldownBars = cfg.cool
  S.requireHtf = cfg.htf
  S.requireWt = cfg.wt
  S.requireDi = cfg.di
  S.requireRsi = cfg.rsi
  S.slPips = cfg.sl
  S.tpPips = cfg.tp
  S.useFixedRisk = true
  S.slMin = cfg.sl
  S.slMax = cfg.sl
  S.tpMin = cfg.tp
  S.tpMax = cfg.tp
  S.maxHoldBars = cfg.hold
  S.rsiLongLo = 40
  S.rsiLongHi = 65
  S.rsiShortLo = 35
  S.rsiShortHi = 60
}

function run(cfg: Cfg) {
  apply(cfg)
  const sum = simulateHistTrades(
    candles,
    listHistoricalSignals(candles, pair, from),
    pair,
  )
  const daily = sum.days > 0 ? sum.netPips / sum.days : 0
  return {
    ...cfg,
    tpd: sum.tradesPerDay,
    ev: sum.evPips,
    daily: Math.round(daily * 100) / 100,
    wr: sum.winRate,
    n: sum.n,
    net: Math.round(sum.netPips * 10) / 10,
    days: sum.days,
  }
}

const BASE: Cfg = {
  label: 'BASE',
  adxMin: 24,
  adxPrime: 28,
  cool: 5,
  htf: true,
  wt: true,
  di: true,
  rsi: true,
  sl: 10,
  tp: 20,
  hold: 60,
}
const base = run(BASE)
console.log('BASELINE', base)

const cfgs: Cfg[] = [BASE]

// Quality-preserving: keep all gates, tune risk/adx/cool/hold
for (const adxMin of [24, 26, 28, 30]) {
  for (const cool of [3, 5, 8]) {
    for (const [sl, tp] of [
      [10, 20],
      [10, 25],
      [12, 24],
      [8, 20],
      [10, 18],
    ] as const) {
      for (const hold of [45, 60, 90]) {
        cfgs.push({
          label: `all_a${adxMin}_c${cool}_sl${sl}_tp${tp}_h${hold}`,
          adxMin,
          adxPrime: Math.max(adxMin + 4, 28),
          cool,
          htf: true,
          wt: true,
          di: true,
          rsi: true,
          sl,
          tp,
          hold,
        })
      }
    }
  }
}

// Drop one gate at a time (quality path)
for (const drop of ['htf', 'wt', 'rsi'] as const) {
  for (const adxMin of [24, 26, 28]) {
    for (const cool of [3, 5]) {
      for (const [sl, tp] of [
        [10, 20],
        [10, 25],
        [12, 24],
      ] as const) {
        cfgs.push({
          label: `drop${drop}_a${adxMin}_c${cool}_sl${sl}_tp${tp}`,
          adxMin,
          adxPrime: Math.max(adxMin + 4, 28),
          cool,
          htf: drop !== 'htf',
          wt: drop !== 'wt',
          di: true,
          rsi: drop !== 'rsi',
          sl,
          tp,
          hold: 60,
        })
      }
    }
  }
}

// Tighter RSI-style via higher ADX + shorter cool (more selective fills reuse)
for (const adxMin of [28, 30, 32]) {
  for (const cool of [2, 3, 5]) {
    cfgs.push({
      label: `strict_a${adxMin}_c${cool}`,
      adxMin,
      adxPrime: adxMin + 4,
      cool,
      htf: true,
      wt: true,
      di: true,
      rsi: true,
      sl: 10,
      tp: 20,
      hold: 60,
    })
  }
}

// dedupe labels
const seen = new Set<string>()
const uniq = cfgs.filter((c) => {
  if (seen.has(c.label)) return false
  seen.add(c.label)
  return true
})
console.log('cfgs', uniq.length)

const rows = uniq.map((c, i) => {
  if (i % 40 === 0) console.log('…', i, '/', uniq.length)
  return run(c)
})

const beat = rows
  .filter((r) => r.daily > base.daily + 0.05 && r.net > base.net && r.ev > 0)
  .sort((a, b) => b.daily - a.daily || b.ev - a.ev)

const beatMore = beat.filter((r) => r.tpd >= base.tpd)

console.log('beat', beat.length)
for (const r of beat.slice(0, 20)) {
  console.log({
    label: r.label,
    tpd: r.tpd,
    ev: r.ev,
    daily: r.daily,
    wr: r.wr,
    net: r.net,
    n: r.n,
  })
}
console.log('beat+tpd≥base', beatMore.length)
for (const r of beatMore.slice(0, 15)) {
  console.log('MORE', {
    label: r.label,
    tpd: r.tpd,
    ev: r.ev,
    daily: r.daily,
    wr: r.wr,
    net: r.net,
  })
}

mkdirSync('backtest/out', { recursive: true })
writeFileSync(
  'backtest/out/beat_baseline.json',
  JSON.stringify({ base, beat: beat.slice(0, 30), beatMore: beatMore.slice(0, 20) }, null, 2),
)
