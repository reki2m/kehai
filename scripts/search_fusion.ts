/**
 * Compare Fusion gate subsets vs locked Peak Drive on Dukascopy Aug–Oct.
 * Keep Peak as live default unless Fusion daily strictly beats it.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { getPair } from '../src/lib/pairs.ts'
import { listHistoricalSignals } from '../src/lib/signalHistory.ts'
import { listFusionSignals } from '../src/lib/fusionSignal.ts'
import { simulateHistTrades } from '../src/lib/histTrades.ts'
import { SIMPLE } from '../src/lib/simpleSignal.ts'
import type { Candle } from '../src/lib/marketData.ts'
import type { FusionGateOpts } from '../src/lib/fusionSignal.ts'

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
const from = Date.UTC(2026, 7, 1) / 1000
const S = SIMPLE as any

// Lock Peak risk for fair compare
S.slPips = 12
S.tpPips = 24
S.useFixedRisk = true
S.slMin = 12
S.slMax = 12
S.tpMin = 24
S.tpMax = 24
S.maxHoldBars = 90

const peakSigs = listHistoricalSignals(candles, pair, from)
const peak = simulateHistTrades(candles, peakSigs, pair)
const peakDaily = peak.days > 0 ? peak.netPips / peak.days : 0
console.log('PEAK_DRIVE', {
  n: peak.n,
  tpd: peak.tradesPerDay,
  wr: peak.winRate,
  ev: peak.evPips,
  daily: Math.round(peakDaily * 100) / 100,
  net: peak.netPips,
  worst: Math.min(0, ...peak.trades.map((t) => t.pnlPips)),
})

type Row = {
  label: string
  n: number
  tpd: number
  wr: number
  ev: number
  daily: number
  net: number
  worst: number
  gates: FusionGateOpts
}

function run(label: string, gates: FusionGateOpts): Row {
  const sigs = listFusionSignals(candles, pair, from, gates)
  const sum = simulateHistTrades(candles, sigs, pair)
  const daily = sum.days > 0 ? sum.netPips / sum.days : 0
  return {
    label,
    n: sum.n,
    tpd: sum.tradesPerDay,
    wr: sum.winRate,
    ev: sum.evPips,
    daily: Math.round(daily * 100) / 100,
    net: Math.round(sum.netPips * 10) / 10,
    worst: sum.trades.length
      ? Math.min(...sum.trades.map((t) => t.pnlPips))
      : 0,
    gates,
  }
}

const baseLz = { neighbors: 6, maxBarsBack: 250, cool: 5 as number }
const combos: { label: string; gates: FusionGateOpts }[] = [
  {
    label: 'ALL',
    gates: {
      requireSt: true,
      requireSqueezeOff: true,
      requireMomAgree: true,
      requireSmc: true,
      requireLorentz: true,
      adxMin: 22,
      adxPrime: 26,
      ...baseLz,
    },
  },
  {
    label: 'ST_Sq_SMC',
    gates: {
      requireSt: true,
      requireSqueezeOff: true,
      requireMomAgree: false,
      requireSmc: true,
      requireLorentz: false,
      adxMin: 24,
      adxPrime: 28,
      ...baseLz,
    },
  },
  {
    label: 'ST_SMC_Lz',
    gates: {
      requireSt: true,
      requireSqueezeOff: false,
      requireMomAgree: false,
      requireSmc: true,
      requireLorentz: true,
      adxMin: 24,
      adxPrime: 28,
      ...baseLz,
    },
  },
  {
    label: 'ST_Sq_Lz',
    gates: {
      requireSt: true,
      requireSqueezeOff: true,
      requireMomAgree: false,
      requireSmc: false,
      requireLorentz: true,
      adxMin: 24,
      adxPrime: 28,
      ...baseLz,
    },
  },
  {
    label: 'ST_Mom_SMC',
    gates: {
      requireSt: true,
      requireSqueezeOff: false,
      requireMomAgree: true,
      requireSmc: true,
      requireLorentz: false,
      adxMin: 24,
      adxPrime: 28,
      ...baseLz,
    },
  },
  {
    label: 'Sq_Mom_only',
    gates: {
      requireSt: false,
      requireSqueezeOff: true,
      requireMomAgree: true,
      requireSmc: false,
      requireLorentz: false,
      adxMin: 24,
      adxPrime: 28,
      ...baseLz,
    },
  },
  {
    label: 'ST_only',
    gates: {
      requireSt: true,
      requireSqueezeOff: false,
      requireMomAgree: false,
      requireSmc: false,
      requireLorentz: false,
      adxMin: 24,
      adxPrime: 28,
      ...baseLz,
    },
  },
  {
    label: 'SMC_Lz',
    gates: {
      requireSt: false,
      requireSqueezeOff: false,
      requireMomAgree: false,
      requireSmc: true,
      requireLorentz: true,
      adxMin: 24,
      adxPrime: 28,
      ...baseLz,
    },
  },
  {
    label: 'ST_Sq_Mom_SMC',
    gates: {
      requireSt: true,
      requireSqueezeOff: true,
      requireMomAgree: true,
      requireSmc: true,
      requireLorentz: false,
      adxMin: 22,
      adxPrime: 26,
      ...baseLz,
    },
  },
  {
    label: 'ST_SMC',
    gates: {
      requireSt: true,
      requireSqueezeOff: false,
      requireMomAgree: false,
      requireSmc: true,
      requireLorentz: false,
      adxMin: 24,
      adxPrime: 28,
      ...baseLz,
    },
  },
]

console.log('combos', combos.length)
const rows: Row[] = []
for (const c of combos) {
  const r = run(c.label, c.gates)
  rows.push(r)
  if (r.n > 0) {
    console.log(
      r.label,
      'n',
      r.n,
      'tpd',
      r.tpd,
      'wr',
      r.wr,
      'ev',
      r.ev,
      'daily',
      r.daily,
      'worst',
      r.worst,
    )
  }
}

rows.sort((a, b) => b.daily - a.daily || b.ev - a.ev)
const top = rows.filter((r) => r.n >= 20).slice(0, 15)
const beat = rows.filter(
  (r) => r.n >= 20 && r.daily > peakDaily + 0.05 && r.ev >= peak.evPips,
)

mkdirSync('backtest/out', { recursive: true })
writeFileSync(
  'backtest/out/fusion_search.json',
  JSON.stringify(
    {
      peak: {
        daily: Math.round(peakDaily * 100) / 100,
        ev: peak.evPips,
        tpd: peak.tradesPerDay,
        wr: peak.winRate,
        n: peak.n,
      },
      beat,
      top,
    },
    null,
    2,
  ),
)
console.log('\nTOP15')
for (const r of top) console.log(r.label, r.daily, r.ev, r.tpd, r.wr, r.n)
console.log('\nBEAT_PEAK', beat.length)
for (const r of beat) console.log(r.label, r.daily, r.ev, r.tpd)
