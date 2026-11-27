/**
 * Take a known ~9–10/day entry stack and hunt exits that lift daily edge
 * above Peak Edge (~3.07p/day).
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
  for (const p of profiles) {
    const key = `${p.utKey}/${p.utAtr}`
    if (utFlips.has(key)) continue
    const { direction } = utBotTrail(candles, p.utKey, p.utAtr)
    utFlips.set(
      key,
      flipMap(new Map(direction.map((d) => [d.time, d.value])), candles),
    )
  }
  const ssl = new Map(sslDirection(candles, 10).map((d) => [d.time, d.value]))
  const htf = new Map(sslDirection(candles, 50).map((d) => [d.time, d.value]))
  const stDir = new Map(
    supertrendDirection(candles, 10, 3).map((d) => [d.time, d.value]),
  )
  const stFlip = flipMap(stDir, candles)
  const adxM = new Map(adx(candles, 14).map((d) => [d.time, d]))
  const atrM = new Map(atr(candles, 14).map((d) => [d.time, d.value]))
  const rsiM = new Map(rsi(candles, 14).map((d) => [d.time, d.value]))
  const { wt1, wt2 } = wavetrend(candles, 10, 21)
  const wt1M = new Map(wt1.map((d) => [d.time, d.value]))
  const wt2M = new Map(wt2.map((d) => [d.time, d.value]))

  type Exit = {
    name: string
    slAtr: number
    slMin: number
    slMax: number
    rr: number
    tpMin: number
    tpMax: number
    hold: number
    /** Move SL to BE after +beTriggerR * SL in favor */
    beTriggerR: number
    /** Trail by trailAtr * ATR once in profit */
    trailAtr: number
  }

  const exits: Exit[] = []
  for (const slAtr of [0.8, 1.0, 1.2]) {
    for (const rr of [1.2, 1.5, 1.8, 2.0, 2.5]) {
      for (const hold of [15, 25, 35, 45]) {
        for (const beTriggerR of [0, 0.8, 1.0]) {
          for (const trailAtr of [0, 0.8, 1.2]) {
            exits.push({
              name: `sl${slAtr}_rr${rr}_h${hold}_be${beTriggerR}_tr${trailAtr}`,
              slAtr,
              slMin: 5,
              slMax: 11,
              rr,
              tpMin: Math.round(5 * rr * 10) / 10,
              tpMax: Math.round(11 * rr * 10) / 10,
              hold,
              beTriggerR,
              trailAtr,
            })
          }
        }
      }
    }
  }

  function gate(t: number, side: 'BUY' | 'SELL', ax: any, needRsi: boolean) {
    const long = side === 'BUY'
    const sslV = ssl.get(t)
    if (sslV == null || (long ? sslV <= 0 : sslV >= 0)) return false
    const h = htf.get(t)
    if (h == null || (long ? h <= 0 : h >= 0)) return false
    if (long ? ax.plusDi <= ax.minusDi : ax.minusDi <= ax.plusDi) return false
    const a = wt1M.get(t)
    const b = wt2M.get(t)
    if (a == null || b == null || (long ? !(a > b) : !(a < b))) return false
    if (needRsi) {
      const r = rsiM.get(t)
      if (r == null) return false
      if (long && !(r >= 40 && r <= 65)) return false
      if (!long && !(r >= 35 && r <= 60)) return false
    }
    return true
  }

  function run(
    mode: 'peak_st15' | 'peak_st16rsi',
    ex: Exit,
    cool: number,
  ) {
    const pnls: number[] = []
    let pos: 0 | 1 | -1 = 0
    let entry = 0
    let stop = 0
    let tp = 0
    let ei = 0
    let last = -9999
    let beArmed = false
    for (let i = 150; i < candles.length - 1; i++) {
      const c = candles[i]!
      if (pos !== 0) {
        const atrV = (atrM.get(c.time) ?? 0) / PIP
        // breakeven
        if (ex.beTriggerR > 0 && !beArmed) {
          const favor =
            pos > 0 ? (c.high - entry) / PIP : (entry - c.low) / PIP
          const slDist = Math.abs(entry - stop) / PIP
          if (favor >= slDist * ex.beTriggerR) {
            stop = entry
            beArmed = true
          }
        }
        // ATR trail
        if (ex.trailAtr > 0 && atrV > 0) {
          const trail = ex.trailAtr * atrV * PIP
          if (pos > 0) {
            const cand = c.close - trail
            if (cand > stop) stop = cand
          } else {
            const cand = c.close + trail
            if (cand < stop) stop = cand
          }
        }
        const hitSl = pos > 0 ? c.low <= stop : c.high >= stop
        const hitTp = pos > 0 ? c.high >= tp : c.low <= tp
        const timed = i - ei >= ex.hold
        const gap = c.time - candles[i - 1]!.time > 120
        if (gap || hitSl || hitTp || timed) {
          const exit = hitSl ? stop : hitTp ? tp : c.close
          pnls.push(((exit - entry) * pos) / PIP - SPREAD)
          pos = 0
          beArmed = false
        }
        continue
      }
      if (!isFxWeekday(c.time) || newsBlackout(c.time)) continue
      if (i - last < cool) continue
      const noon = isNoonSignalWindow(c.time)
      const ax = adxM.get(c.time)
      if (!ax) continue
      const atrPips = (atrM.get(c.time) ?? 0) / PIP
      if (atrPips > 0 && atrPips < 1.2) continue

      let side: 'BUY' | 'SELL' | null = null
      // Peak 18/22
      if (ax.adx >= (noon ? 18 : 22)) {
        const fx = detectFxSession(c.time)
        const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
        const flip = utFlips
          .get(`${profile.utKey}/${profile.utAtr}`)!
          .get(c.time)
        if (flip && gate(c.time, flip, ax, true)) side = flip
      }
      // ST filler
      if (!side) {
        const need =
          mode === 'peak_st16rsi'
            ? { n: 16, o: 22, rsi: true }
            : { n: 15, o: 19, rsi: false }
        if (ax.adx >= (noon ? need.n : need.o)) {
          const flip = stFlip.get(c.time)
          if (flip && gate(c.time, flip, ax, need.rsi)) side = flip
        }
      }
      if (!side) continue

      const sl =
        Math.round(
          Math.max(ex.slMin, Math.min(ex.slMax, atrPips * ex.slAtr)) * 10,
        ) / 10
      const tpP =
        Math.round(
          Math.max(ex.tpMin, Math.min(ex.tpMax, sl * ex.rr)) * 10,
        ) / 10
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
      beArmed = false
    }
    const days = new Set<string>()
    for (const c of candles) if (isFxWeekday(c.time)) days.add(jstDay(c.time))
    const nd = Math.max(1, days.size)
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
  for (const mode of ['peak_st15', 'peak_st16rsi'] as const) {
    for (const cool of [3, 5]) {
      for (const ex of exits) {
        const st = run(mode, ex, cool)
        if (st.tpd < 8 || st.tpd > 12) continue
        rows.push({ mode, cool, exit: ex.name, ...ex, ...st })
      }
    }
  }
  rows.sort((a, b) => b.daily - a.daily || b.ev - a.ev)
  const beat = rows.filter((r) => r.daily > PEAK_DAILY && r.net > 104)
  const out = {
    peakDaily: PEAK_DAILY,
    scanned: rows.length,
    beat: beat.length,
    best: rows[0],
    topBeat: beat.slice(0, 15),
    top: rows.slice(0, 25),
  }
  mkdirSync('backtest/out', { recursive: true })
  writeFileSync('backtest/out/ten_exits.json', JSON.stringify(out, null, 2))
  console.log(
    JSON.stringify(
      {
        scanned: out.scanned,
        beat: out.beat,
        best: rows[0] && {
          mode: rows[0].mode,
          exit: rows[0].exit,
          tpd: rows[0].tpd,
          ev: rows[0].ev,
          net: rows[0].net,
          daily: rows[0].daily,
          wr: rows[0].wr,
        },
        topBeat: beat.slice(0, 5).map((r) => ({
          mode: r.mode,
          exit: r.exit,
          tpd: r.tpd,
          ev: r.ev,
          net: r.net,
          daily: r.daily,
        })),
      },
      null,
      2,
    ),
  )
}

main()
