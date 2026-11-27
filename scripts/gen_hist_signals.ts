/** Regenerate public/live/signals_USDJPY_1m.json from hist candles. */
import { readFileSync, writeFileSync } from 'fs'
import { getPair } from '../src/lib/pairs.ts'
import {
  HIST_FROM_UNIX,
  listHistoricalSignals,
} from '../src/lib/signalHistory.ts'
import { simulateHistTrades } from '../src/lib/histTrades.ts'
import { SIMPLE } from '../src/lib/simpleSignal.ts'
import type { Candle } from '../src/lib/marketData.ts'

const hist = JSON.parse(
  readFileSync('public/live/hist_USDJPY_1m.json', 'utf8'),
) as { candles: Candle[] }

const pair = getPair('USDJPY')
const signals = listHistoricalSignals(hist.candles, pair, HIST_FROM_UNIX)
const summary = simulateHistTrades(hist.candles, signals, pair)

const payload = {
  pairId: 'USDJPY',
  timeframe: '1m',
  from: HIST_FROM_UNIX,
  count: signals.length,
  stack: 'day_desk',
  params: {
    adxMin: SIMPLE.adxMin,
    adxPrime: SIMPLE.adxPrime,
    dayAdxMin: SIMPLE.dayAdxMin,
    dayAdxOff: SIMPLE.dayAdxOff,
    adxPulse: SIMPLE.adxPulse,
    adxPulseOff: SIMPLE.adxPulseOff,
    entryCooldownBars: SIMPLE.entryCooldownBars,
    daySize: SIMPLE.daySize,
  },
  performance: {
    n: summary.n,
    winRate: summary.winRate,
    evPips: summary.evPips,
    netPips: summary.netPips,
    weightedNetPips: summary.weightedNetPips,
    tradesPerDay: summary.tradesPerDay,
    honmeiN: summary.honmeiN,
    dayN: summary.dayN,
    days: summary.days,
  },
  generatedAt: Math.floor(Date.now() / 1000),
  signals,
}

writeFileSync(
  'public/live/signals_USDJPY_1m.json',
  JSON.stringify(payload),
)
console.log('signals', signals.length)
console.log('perf', payload.performance)
