/**
 * Search dual stacks in the ~7–12 trades/day band ("10回程度").
 * Prefer max EV; report best in-band even if slightly negative.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import {
  adx,
  atr,
  rsi,
  sslDirection,
  supertrendDirection,
  utBotTrail,
  wavetrend,
} from '../src/lib/indicators.ts'
import {
  SESSION_PROFILES,
  detectFxSession,
  isFxWeekday,
  isNoonSignalWindow,
} from '../src/lib/apex.ts'
import { newsBlackout } from '../src/lib/filters.ts'
import { atrRiskPips, SIMPLE } from '../src/lib/simpleSignal.ts'
import type { Candle } from '../src/lib/marketData.ts'

const PIP = 0.01
const SPREAD = 0.2

function loadMerge(files: string[]) {
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

function jstDay(t: number) {
  return new Date(t * 1000).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Tokyo',
  })
}

function flipMap(dir: Map<number, number>, candles: Candle[]) {
  const f = new Map<number, 'BUY' | 'SELL'>()
  for (let i = 1; i < candles.length; i++) {
    const a = dir.get(candles[i - 1]!.time)
    const b = dir.get(candles[i]!.time)
    if (a == null || b == null) continue
    if (b > 0 && a <= 0) f.set(candles[i]!.time, 'BUY')
    if (b < 0 && a >= 0) f.set(candles[i]!.time, 'SELL')
  }
  return f
}

type Gate = { htf: boolean; st: boolean; di: boolean; wt: boolean; rsi: boolean }
type Stack = {
  name: string
  primary: 'ut' | 'st' | 'ssl'
  gate: Gate
  adxN: number
  adxO: number
}

function main() {
  const candles = loadMerge([
    'backtest/data/usdjpy_m1_dukascopy_2026aug.json',
    'backtest/data/usdjpy_m1_dukascopy_2026sep.json',
    'backtest/data/usdjpy_m1_dukascopy_2026oct.json',
  ])
  const profiles = [
    SESSION_PROFILES.tokyo,
    SESSION_PROFILES.london,
    SESSION_PROFILES.ny,
  ]
  const utFlips = new Map<string, Map<number, 'BUY' | 'SELL'>>()
  for (const p of profiles) {
    const key = `${p.utKey}/${p.utAtr}`
    if (utFlips.has(key)) continue
    const { direction } = utBotTrail(candles, p.utKey, p.utAtr)
    const m = new Map(direction.map((d) => [d.time, d.value]))
    utFlips.set(key, flipMap(m, candles))
  }
  const ssl = new Map(sslDirection(candles, 10).map((d) => [d.time, d.value]))
  const htf = new Map(sslDirection(candles, 50).map((d) => [d.time, d.value]))
  const stDir = new Map(
    supertrendDirection(candles, 10, 3).map((d) => [d.time, d.value]),
  )
  const stFlip = flipMap(stDir, candles)
  const sslFlip = flipMap(ssl, candles)
  const adxM = new Map(adx(candles, 14).map((d) => [d.time, d]))
  const atrM = new Map(atr(candles, 14).map((d) => [d.time, d.value]))
  const rsiM = new Map(rsi(candles, 14).map((d) => [d.time, d.value]))
  const { wt1, wt2 } = wavetrend(candles, 10, 21)
  const wt1M = new Map(wt1.map((d) => [d.time, d.value]))
  const wt2M = new Map(wt2.map((d) => [d.time, d.value]))

  function passGate(
    t: number,
    side: 'BUY' | 'SELL',
    g: Gate,
    ax: { adx: number; plusDi: number; minusDi: number },
  ) {
    const long = side === 'BUY'
    const sslV = ssl.get(t)
    if (sslV == null || (long ? sslV <= 0 : sslV >= 0)) return false
    if (g.htf) {
      const h = htf.get(t)
      if (h == null || (long ? h <= 0 : h >= 0)) return false
    }
    if (g.st) {
      const s = stDir.get(t)
      if (s == null || (long ? s <= 0 : s >= 0)) return false
    }
    if (g.di && (long ? ax.plusDi <= ax.minusDi : ax.minusDi <= ax.plusDi))
      return false
    if (g.wt) {
      const a = wt1M.get(t)
      const b = wt2M.get(t)
      if (a == null || b == null || (long ? !(a > b) : !(a < b))) return false
    }
    if (g.rsi) {
      const r = rsiM.get(t)
      if (r == null) return false
      if (long && !(r >= 40 && r <= 65)) return false
      if (!long && !(r >= 35 && r <= 60)) return false
    }
    return true
  }

  const peak: Stack = {
    name: 'peak',
    primary: 'ut',
    gate: { htf: true, st: false, di: true, wt: true, rsi: true },
    adxN: 18,
    adxO: 22,
  }

  const pulseVariants: Stack[] = []
  for (const adxN of [15, 16, 17, 18, 19]) {
    for (const adxO of [adxN + 2, adxN + 4, adxN + 6]) {
      for (const wt of [true, false]) {
        for (const rsiOn of [true, false]) {
          pulseVariants.push({
            name: `st_a${adxN}_${adxO}_w${wt ? 1 : 0}_r${rsiOn ? 1 : 0}`,
            primary: 'st',
            gate: { htf: true, st: false, di: true, wt, rsi: rsiOn },
            adxN,
            adxO,
          })
        }
      }
    }
  }

  function run(active: Stack[], cool = 1) {
    const pnls: number[] = []
    let pos: 0 | 1 | -1 = 0
    let entry = 0
    let stop = 0
    let tp = 0
    let ei = 0
    let last = -9999
    for (let i = 150; i < candles.length - 1; i++) {
      const c = candles[i]!
      if (pos !== 0) {
        const hitSl = pos > 0 ? c.low <= stop : c.high >= stop
        const hitTp = pos > 0 ? c.high >= tp : c.low <= tp
        const timed = i - ei >= 45
        const gap = c.time - candles[i - 1]!.time > 120
        if (gap || hitSl || hitTp || timed) {
          const exit = hitSl ? stop : hitTp ? tp : c.close
          pnls.push(((exit - entry) * pos) / PIP - SPREAD)
          pos = 0
        }
        continue
      }
      if (!isFxWeekday(c.time) || newsBlackout(c.time)) continue
      if (i - last < cool) continue
      const noon = isNoonSignalWindow(c.time)
      const ax = adxM.get(c.time)
      if (!ax) continue
      const atrV = atrM.get(c.time) ?? 0
      const atrPips = atrV / PIP
      if (atrPips > 0 && atrPips < SIMPLE.minAtrPips) continue

      let side: 'BUY' | 'SELL' | null = null
      for (const s of active) {
        if (ax.adx < (noon ? s.adxN : s.adxO)) continue
        let flip: 'BUY' | 'SELL' | undefined
        if (s.primary === 'ut') {
          const fx = detectFxSession(c.time)
          const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
          const key = `${profile.utKey}/${profile.utAtr}`
          flip = utFlips.get(key)!.get(c.time)
        } else if (s.primary === 'st') flip = stFlip.get(c.time)
        else flip = sslFlip.get(c.time)
        if (!flip) continue
        if (!passGate(c.time, flip, s.gate, ax)) continue
        side = flip
        break
      }
      if (!side) continue
      const { sl, tp: tpP } = atrRiskPips(atrPips)
      const next = candles[i + 1]!
      if (side === 'BUY') {
        entry = next.open + SPREAD * PIP * 0.5
        stop = entry - sl * PIP
        tp = entry + tpP * PIP
        pos = 1
      } else {
        entry = next.open - SPREAD * PIP * 0.5
        stop = entry + sl * PIP
        tp = entry - tpP * PIP
        pos = -1
      }
      ei = i + 1
      last = i
    }
    const days = new Set<string>()
    for (const c of candles) if (isFxWeekday(c.time)) days.add(jstDay(c.time))
    const nd = Math.max(1, days.size)
    const n = pnls.length
    const net = pnls.reduce((a, b) => a + b, 0)
    return {
      n,
      tpd: Math.round((n / nd) * 100) / 100,
      wr: n ? Math.round((pnls.filter((p) => p > 0).length / n) * 1000) / 10 : 0,
      ev: n ? Math.round((net / n) * 1000) / 1000 : 0,
      net: Math.round(net * 10) / 10,
    }
  }

  const rows: any[] = []
  const peakAlone = run([peak])
  rows.push({ name: 'peak_alone', ...peakAlone })
  console.log('peak_alone', peakAlone)

  for (const cool of [1, 3, 5]) {
    for (const pulse of pulseVariants) {
      const st = run([peak, pulse], cool)
      if (st.tpd < 6.5 || st.tpd > 12.5) continue
      rows.push({ name: `peak+${pulse.name}_c${cool}`, cool, pulse, ...st })
    }
  }

  rows.sort((a, b) => b.ev - a.ev || b.tpd - a.tpd)
  const top = rows.slice(0, 25)
  const inBand10 = rows.filter((r) => r.tpd >= 8 && r.tpd <= 11)
  const best10 = inBand10[0] ?? null
  const bestEvPos = rows.find((r) => r.ev > 0) ?? null

  mkdirSync('backtest/out', { recursive: true })
  const out = {
    peakAlone,
    bestEvPos,
    bestNear10: best10,
    top,
    scanned: rows.length,
  }
  writeFileSync('backtest/out/ten_degree.json', JSON.stringify(out, null, 2))
  console.log('scanned', rows.length)
  console.log('bestEvPos', bestEvPos)
  console.log('bestNear10', best10)
  console.log('top5', top.slice(0, 5))
}

main()
