/**
 * Alternative entries (BB/RSI extremes, UT-only soft, SSL) × Peak-like exits
 * aiming for ~10/day with daily edge > Peak Edge.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import {
  adx,
  atr,
  bollinger,
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
import type { Candle } from '../src/lib/marketData.ts'

const PIP = 0.01
const SPREAD = 0.2
const PEAK_DAILY = 1.6 * 1.92

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
  const utDirs = new Map<string, Map<number, number>>()
  for (const p of profiles) {
    const key = `${p.utKey}/${p.utAtr}`
    if (utFlips.has(key)) continue
    const { direction } = utBotTrail(candles, p.utKey, p.utAtr)
    const m = new Map(direction.map((d) => [d.time, d.value]))
    utDirs.set(key, m)
    utFlips.set(key, flipMap(m, candles))
  }
  const ssl = new Map(sslDirection(candles, 10).map((d) => [d.time, d.value]))
  const htf = new Map(sslDirection(candles, 50).map((d) => [d.time, d.value]))
  const stFlip = flipMap(
    new Map(supertrendDirection(candles, 10, 3).map((d) => [d.time, d.value])),
    candles,
  )
  const adxM = new Map(adx(candles, 14).map((d) => [d.time, d]))
  const atrM = new Map(atr(candles, 14).map((d) => [d.time, d.value]))
  const rsiM = new Map(rsi(candles, 14).map((d) => [d.time, d.value]))
  const bb = bollinger(candles, 20, 2)
  const bbM = new Map(bb.map((d) => [d.time, d]))
  const { wt1, wt2 } = wavetrend(candles, 10, 21)
  const wt1M = new Map(wt1.map((d) => [d.time, d.value]))
  const wt2M = new Map(wt2.map((d) => [d.time, d.value]))

  const days = new Set<string>()
  for (const c of candles) if (isFxWeekday(c.time)) days.add(jstDay(c.time))
  const nd = Math.max(1, days.size)

  type Sig = (i: number) => 'BUY' | 'SELL' | null

  const strategies: { id: string; sig: Sig }[] = [
    {
      id: 'bb_rsi_mr',
      sig(i) {
        const c = candles[i]!
        const b = bbM.get(c.time)
        const r = rsiM.get(c.time)
        const ax = adxM.get(c.time)
        if (!b || r == null || !ax) return null
        // mean-revert only when ADX not too high (range)
        if (ax.adx > 22) return null
        if (c.close <= b.lower && r <= 30) return 'BUY'
        if (c.close >= b.upper && r >= 70) return 'SELL'
        return null
      },
    },
    {
      id: 'bb_rsi_mr_htf',
      sig(i) {
        const c = candles[i]!
        const b = bbM.get(c.time)
        const r = rsiM.get(c.time)
        const ax = adxM.get(c.time)
        const h = htf.get(c.time)
        if (!b || r == null || !ax || h == null) return null
        if (ax.adx > 25) return null
        if (c.close <= b.lower && r <= 32 && h > 0) return 'BUY'
        if (c.close >= b.upper && r >= 68 && h < 0) return 'SELL'
        return null
      },
    },
    {
      id: 'ut_soft_peakexit',
      sig(i) {
        const c = candles[i]!
        const noon = isNoonSignalWindow(c.time)
        const ax = adxM.get(c.time)
        if (!ax || ax.adx < (noon ? 14 : 18)) return null
        const fx = detectFxSession(c.time)
        const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
        const flip = utFlips.get(`${profile.utKey}/${profile.utAtr}`)!.get(c.time)
        if (!flip) return null
        const long = flip === 'BUY'
        const s = ssl.get(c.time)
        const h = htf.get(c.time)
        const w1 = wt1M.get(c.time)
        const w2 = wt2M.get(c.time)
        if (s == null || (long ? s <= 0 : s >= 0)) return null
        if (h == null || (long ? h <= 0 : h >= 0)) return null
        if (w1 == null || w2 == null || (long ? !(w1 > w2) : !(w1 < w2)))
          return null
        if (long ? ax.plusDi <= ax.minusDi : ax.minusDi <= ax.plusDi) return null
        return flip
      },
    },
    {
      id: 'st_soft',
      sig(i) {
        const c = candles[i]!
        const noon = isNoonSignalWindow(c.time)
        const ax = adxM.get(c.time)
        if (!ax || ax.adx < (noon ? 12 : 16)) return null
        const flip = stFlip.get(c.time)
        if (!flip) return null
        const long = flip === 'BUY'
        const s = ssl.get(c.time)
        const h = htf.get(c.time)
        if (s == null || (long ? s <= 0 : s >= 0)) return null
        if (h == null || (long ? h <= 0 : h >= 0)) return null
        if (long ? ax.plusDi <= ax.minusDi : ax.minusDi <= ax.plusDi) return null
        return flip
      },
    },
    {
      id: 'hybrid_peak_bb',
      sig(i) {
        const c = candles[i]!
        const noon = isNoonSignalWindow(c.time)
        const ax = adxM.get(c.time)
        if (!ax) return null
        // Peak-like
        if (ax.adx >= (noon ? 22 : 26)) {
          const fx = detectFxSession(c.time)
          const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
          const flip = utFlips
            .get(`${profile.utKey}/${profile.utAtr}`)!
            .get(c.time)
          if (flip) {
            const long = flip === 'BUY'
            const s = ssl.get(c.time)
            const h = htf.get(c.time)
            const r = rsiM.get(c.time)
            const w1 = wt1M.get(c.time)
            const w2 = wt2M.get(c.time)
            if (
              s != null &&
              h != null &&
              r != null &&
              w1 != null &&
              w2 != null &&
              (long ? s > 0 : s < 0) &&
              (long ? h > 0 : h < 0) &&
              (long ? ax.plusDi > ax.minusDi : ax.minusDi > ax.plusDi) &&
              (long ? w1 > w2 : w1 < w2) &&
              (long ? r >= 40 && r <= 65 : r >= 35 && r <= 60)
            )
              return flip
          }
        }
        // BB MR filler
        const b = bbM.get(c.time)
        const r = rsiM.get(c.time)
        if (!b || r == null) return null
        if (ax.adx > 20) return null
        if (c.close <= b.lower && r <= 30) return 'BUY'
        if (c.close >= b.upper && r >= 70) return 'SELL'
        return null
      },
    },
  ]

  type Exit = {
    id: string
    slAtr: number
    rr: number
    hold: number
    beR: number
  }
  const exits: Exit[] = []
  for (const slAtr of [0.8, 1.0, 1.2]) {
    for (const rr of [1.2, 1.5, 1.8, 2.0, 2.5]) {
      for (const hold of [15, 25, 40]) {
        for (const beR of [0, 0.8, 1.2]) {
          exits.push({
            id: `a${slAtr}_r${rr}_h${hold}_b${beR}`,
            slAtr,
            rr,
            hold,
            beR,
          })
        }
      }
    }
  }

  function run(sig: Sig, ex: Exit, cool: number, slots: number) {
    const pnls: number[] = []
    type P = {
      dir: 1 | -1
      entry: number
      stop: number
      tp: number
      ei: number
      be: boolean
    }
    const open: P[] = []
    let last = -9999
    for (let i = 150; i < candles.length - 1; i++) {
      const c = candles[i]!
      const atrPips = (atrM.get(c.time) ?? 0) / PIP
      for (let p = open.length - 1; p >= 0; p--) {
        const pos = open[p]!
        if (ex.beR > 0 && !pos.be) {
          const favor =
            pos.dir > 0 ? (c.high - pos.entry) / PIP : (pos.entry - c.low) / PIP
          const slDist = Math.abs(pos.entry - pos.stop) / PIP
          if (favor >= slDist * ex.beR) {
            pos.stop = pos.entry
            pos.be = true
          }
        }
        const hitSl = pos.dir > 0 ? c.low <= pos.stop : c.high >= pos.stop
        const hitTp = pos.dir > 0 ? c.high >= pos.tp : c.low <= pos.tp
        const timed = i - pos.ei >= ex.hold
        const gap = c.time - candles[i - 1]!.time > 120
        if (gap || hitSl || hitTp || timed) {
          const exit = hitSl ? pos.stop : hitTp ? pos.tp : c.close
          pnls.push(((exit - pos.entry) * pos.dir) / PIP - SPREAD)
          open.splice(p, 1)
        }
      }
      if (!isFxWeekday(c.time) || newsBlackout(c.time)) continue
      if (i - last < cool) continue
      if (open.length >= slots) continue
      if (atrPips > 0 && atrPips < 1.0) continue
      const side = sig(i)
      if (!side) continue
      const sl =
        Math.round(Math.max(5, Math.min(10, atrPips * ex.slAtr)) * 10) / 10
      const tpP = Math.round(sl * ex.rr * 10) / 10
      const next = candles[i + 1]!
      const dir: 1 | -1 = side === 'BUY' ? 1 : -1
      const entry =
        dir > 0
          ? next.open + SPREAD * PIP * 0.5
          : next.open - SPREAD * PIP * 0.5
      open.push({
        dir,
        entry,
        stop: dir > 0 ? entry - sl * PIP : entry + sl * PIP,
        tp: dir > 0 ? entry + tpP * PIP : entry - tpP * PIP,
        ei: i + 1,
        be: false,
      })
      last = i
    }
    const n = pnls.length
    const net = pnls.reduce((a, b) => a + b, 0)
    const ev = n ? net / n : 0
    const tpd = n / nd
    return {
      n,
      tpd: Math.round(tpd * 100) / 100,
      wr: n ? Math.round((pnls.filter((p) => p > 0).length / n) * 1000) / 10 : 0,
      ev: Math.round(ev * 1000) / 1000,
      net: Math.round(net * 10) / 10,
      daily: Math.round(tpd * ev * 100) / 100,
    }
  }

  const rows: any[] = []
  for (const s of strategies) {
    for (const ex of exits) {
      for (const cool of [2, 5]) {
        for (const slots of [1, 2]) {
          const st = run(s.sig, ex, cool, slots)
          if (st.tpd < 7.5 || st.tpd > 12.5) continue
          rows.push({ strategy: s.id, exit: ex.id, cool, slots, ...st })
        }
      }
    }
  }
  rows.sort((a, b) => b.daily - a.daily)
  const beat = rows.filter((r) => r.daily > PEAK_DAILY && r.net > 104)
  const out = {
    peakDaily: PEAK_DAILY,
    keep: rows.length,
    beat: beat.length,
    best: rows[0],
    topBeat: beat.slice(0, 10),
    top: rows.slice(0, 20),
  }
  mkdirSync('backtest/out', { recursive: true })
  writeFileSync('backtest/out/alt_edge.json', JSON.stringify(out, null, 2))
  console.log(
    JSON.stringify(
      {
        keep: rows.length,
        beat: beat.length,
        best: rows[0],
        top5: rows.slice(0, 5).map((r) => ({
          s: r.strategy,
          e: r.exit,
          slots: r.slots,
          tpd: r.tpd,
          ev: r.ev,
          net: r.net,
          daily: r.daily,
          wr: r.wr,
        })),
      },
      null,
      2,
    ),
  )
}

main()
