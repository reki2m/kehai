/** Verify Peak24 book across Yahoo FX files → daily pips. */
import { readFileSync, readdirSync } from 'fs'
import { getPair, type PairId } from '../src/lib/pairs.ts'
import { listHistoricalSignals } from '../src/lib/signalHistory.ts'
import { simulateHistTrades } from '../src/lib/histTrades.ts'
import type { Candle } from '../src/lib/marketData.ts'
import { SIMPLE } from '../src/lib/simpleSignal.ts'

// Ensure Peak-only for this verify — day desk may still be active in SIMPLE.
console.log('SIMPLE', SIMPLE.name, 'pulse', SIMPLE.pulseEnabled, 'adx', SIMPLE.adxMin)

const dir = 'backtest/data/yahoo_fx_5d'
const files = readdirSync(dir).filter((f) => f.endsWith('_1m.json'))
const all: { pairId: string; pnl: number; n: number; weighted: number }[] = []
const byDay = new Map<string, number>()

for (const f of files) {
  const id = f.replace('_1m.json', '') as PairId
  let pair
  try {
    pair = getPair(id)
  } catch {
    // temporary pip guess for unlisted pairs
    const jpy = id.includes('JPY')
    pair = {
      id,
      label: id,
      pip: jpy ? 0.01 : 0.0001,
      digits: jpy ? 3 : 5,
      kind: 'fx',
    } as any
  }
  const candles = JSON.parse(readFileSync(dir + '/' + f, 'utf8')) as Candle[]
  const from = candles[120]?.time ?? 0
  const sigs = listHistoricalSignals(candles, pair, from)
  const sum = simulateHistTrades(candles, sigs, pair)
  all.push({
    pairId: id,
    pnl: sum.netPips,
    n: sum.n,
    weighted: sum.weightedNetPips,
  })
  for (const t of sum.trades) {
    const d = new Date(t.entryTime * 1000).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Tokyo',
    })
    byDay.set(d, (byDay.get(d) || 0) + t.pnlPips)
  }
  console.log(id, { n: sum.n, tpd: sum.tradesPerDay, ev: sum.evPips, net: sum.netPips })
}

const days = [...byDay.entries()]
const dailyAvg =
  days.length > 0
    ? days.reduce((s, [, v]) => s + v, 0) / days.length
    : 0
const totalN = all.reduce((s, a) => s + a.n, 0)
const totalNet = all.reduce((s, a) => s + a.pnl, 0)
console.log({
  pairs: all.length,
  totalN,
  totalNet: +totalNet.toFixed(1),
  days: days.length,
  dailyAvg: +dailyAvg.toFixed(2),
  perDay: days.map(([d, v]) => ({ d, v: +v.toFixed(1) })),
})
