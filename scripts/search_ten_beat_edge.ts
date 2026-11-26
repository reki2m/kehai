/**
 * Find ~8–12 trades/day stacks whose daily edge (tpd×ev) beats Peak Edge.
 * Peak Edge baseline: ~1.6/day × EV+1.92 ≈ +3.07p/day (net ~+104).
 * Also try exit knobs (RR / hold / trail-ish early TP).
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
/** Peak Edge daily expectancy to beat. */
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

type Risk = {
  slAtr: number
  slMin: number
  slMax: number
  rr: number
  tpMin: number
  tpMax: number
  hold: number
}

function atrRisk(atrPips: number, r: Risk) {
  if (!(atrPips > 0)) return { sl: 7, tp: 14 }
  const sl =
    Math.round(Math.max(r.slMin, Math.min(r.slMax, atrPips * r.slAtr)) * 10) /
    10
  const tp =
    Math.round(Math.max(r.tpMin, Math.min(r.tpMax, sl * r.rr)) * 10) / 10
  return { sl, tp }
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
  const sslFlip = flipMap(ssl, candles)
  const adxM = new Map(adx(candles, 14).map((d) => [d.time, d]))
  const atrM = new Map(atr(candles, 14).map((d) => [d.time, d.value]))
  const rsiM = new Map(rsi(candles, 14).map((d) => [d.time, d.value]))
  const { wt1, wt2 } = wavetrend(candles, 10, 21)
  const wt1M = new Map(wt1.map((d) => [d.time, d.value]))
  const wt2M = new Map(wt2.map((d) => [d.time, d.value]))

  type Path = {
    id: string
    primary: 'ut' | 'st' | 'ssl'
    adxN: number
    adxO: number
    htf: boolean
    st: boolean
    di: boolean
    wt: boolean
    rsi: boolean
  }

  const peakTight: Path = {
    id: 'peak24',
    primary: 'ut',
    adxN: 24,
    adxO: 28,
    htf: true,
    st: false,
    di: true,
    wt: true,
    rsi: true,
  }
  const peakStd: Path = {
    id: 'peak18',
    primary: 'ut',
    adxN: 18,
    adxO: 22,
    htf: true,
    st: false,
    di: true,
    wt: true,
    rsi: true,
  }
  const peakSoft: Path = {
    id: 'peak16',
    primary: 'ut',
    adxN: 16,
    adxO: 20,
    htf: true,
    st: false,
    di: true,
    wt: true,
    rsi: true,
  }

  const fillers: Path[] = []
  for (const primary of ['st', 'ssl'] as const) {
    for (const adxN of [14, 15, 16, 17, 18, 20]) {
      for (const adxO of [adxN + 2, adxN + 4]) {
        for (const wt of [true, false]) {
          for (const rsiOn of [true, false]) {
            fillers.push({
              id: `${primary}_a${adxN}_${adxO}_w${wt ? 1 : 0}_r${rsiOn ? 1 : 0}`,
              primary,
              adxN,
              adxO,
              htf: true,
              st: false,
              di: true,
              wt,
              rsi: rsiOn,
            })
          }
        }
      }
    }
  }

  const risks: Risk[] = [
    { slAtr: 1.0, slMin: 7, slMax: 10, rr: 2.0, tpMin: 12, tpMax: 18, hold: 45 },
    { slAtr: 1.1, slMin: 6, slMax: 10, rr: 1.45, tpMin: 9, tpMax: 14, hold: 45 },
    { slAtr: 1.0, slMin: 5, slMax: 9, rr: 1.6, tpMin: 8, tpMax: 14, hold: 30 },
    { slAtr: 0.9, slMin: 5, slMax: 8, rr: 1.8, tpMin: 9, tpMax: 14, hold: 25 },
    { slAtr: 1.0, slMin: 6, slMax: 9, rr: 2.2, tpMin: 12, tpMax: 20, hold: 40 },
    { slAtr: 1.2, slMin: 6, slMax: 11, rr: 1.3, tpMin: 8, tpMax: 12, hold: 20 },
  ]

  function passGate(t: number, side: 'BUY' | 'SELL', p: Path, ax: any) {
    const long = side === 'BUY'
    const sslV = ssl.get(t)
    if (sslV == null || (long ? sslV <= 0 : sslV >= 0)) return false
    if (p.htf) {
      const h = htf.get(t)
      if (h == null || (long ? h <= 0 : h >= 0)) return false
    }
    if (p.st) {
      const s = stDir.get(t)
      if (s == null || (long ? s <= 0 : s >= 0)) return false
    }
    if (p.di && (long ? ax.plusDi <= ax.minusDi : ax.minusDi <= ax.plusDi))
      return false
    if (p.wt) {
      const a = wt1M.get(t)
      const b = wt2M.get(t)
      if (a == null || b == null || (long ? !(a > b) : !(a < b))) return false
    }
    if (p.rsi) {
      const r = rsiM.get(t)
      if (r == null) return false
      if (long && !(r >= 40 && r <= 65)) return false
      if (!long && !(r >= 35 && r <= 60)) return false
    }
    return true
  }

  function flipFor(p: Path, t: number): 'BUY' | 'SELL' | undefined {
    if (p.primary === 'ut') {
      const fx = detectFxSession(t)
      const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
      return utFlips.get(`${profile.utKey}/${profile.utAtr}`)!.get(t)
    }
    if (p.primary === 'st') return stFlip.get(t)
    return sslFlip.get(t)
  }

  function run(paths: Path[], risk: Risk, cool: number) {
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
        const timed = i - ei >= risk.hold
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
      if (atrPips > 0 && atrPips < 1.2) continue

      let side: 'BUY' | 'SELL' | null = null
      for (const p of paths) {
        if (ax.adx < (noon ? p.adxN : p.adxO)) continue
        const flip = flipFor(p, c.time)
        if (!flip) continue
        if (!passGate(c.time, flip, p, ax)) continue
        side = flip
        break
      }
      if (!side) continue
      const { sl, tp: tpP } = atrRisk(atrPips, risk)
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
  const peaks = [peakTight, peakStd, peakSoft]
  // Peak alone baselines
  for (const peak of peaks) {
    for (const risk of risks) {
      for (const cool of [1, 3, 5]) {
        const st = run([peak], risk, cool)
        rows.push({
          name: `${peak.id}_solo_rr${risk.rr}_h${risk.hold}_c${cool}`,
          paths: [peak.id],
          risk,
          cool,
          ...st,
        })
      }
    }
  }

  // Peak + one filler (sample fillers to keep runtime sane)
  const fillerSample = fillers.filter((_, i) => i % 3 === 0)
  for (const peak of [peakStd, peakSoft]) {
    for (const fill of fillerSample) {
      for (const risk of [risks[0]!, risks[1]!, risks[4]!]) {
        for (const cool of [3, 5]) {
          const st = run([peak, fill], risk, cool)
          if (st.tpd < 7 || st.tpd > 13) continue
          rows.push({
            name: `${peak.id}+${fill.id}_rr${risk.rr}_h${risk.hold}_c${cool}`,
            paths: [peak.id, fill.id],
            risk,
            cool,
            fill,
            ...st,
          })
        }
      }
    }
  }

  // Triple: peak + st + ssl soft fillers
  const softSt = fillers.filter(
    (f) => f.primary === 'st' && f.adxN <= 16 && f.wt && !f.rsi,
  )
  const softSsl = fillers.filter(
    (f) => f.primary === 'ssl' && f.adxN <= 16 && f.wt,
  )
  for (const peak of [peakStd]) {
    for (const st of softSt.slice(0, 8)) {
      for (const sslP of softSsl.slice(0, 6)) {
        for (const risk of [risks[0]!, risks[1]!]) {
          const res = run([peak, st, sslP], risk, 5)
          if (res.tpd < 7 || res.tpd > 13) continue
          rows.push({
            name: `${peak.id}+${st.id}+${sslP.id}_rr${risk.rr}_c5`,
            paths: [peak.id, st.id, sslP.id],
            risk,
            cool: 5,
            ...res,
          })
        }
      }
    }
  }

  const inBand = rows.filter((r) => r.tpd >= 8 && r.tpd <= 11.5)
  inBand.sort((a, b) => b.daily - a.daily || b.ev - a.ev)
  const beat = inBand.filter((r) => r.daily > PEAK_DAILY && r.net > 104)
  const beatDaily = inBand.filter((r) => r.daily > PEAK_DAILY)
  const bestBand = inBand[0] ?? null

  const out = {
    peakDaily: PEAK_DAILY,
    scanned: rows.length,
    inBand: inBand.length,
    beatPeakDailyAndNet: beat.length,
    beatPeakDaily: beatDaily.length,
    bestInBand: bestBand,
    topBeat: beat.slice(0, 10),
    topDaily: inBand.slice(0, 20),
  }
  mkdirSync('backtest/out', { recursive: true })
  writeFileSync('backtest/out/ten_beat_edge.json', JSON.stringify(out, null, 2))
  console.log(
    JSON.stringify(
      {
        scanned: out.scanned,
        inBand: out.inBand,
        beatBoth: out.beatPeakDailyAndNet,
        beatDaily: out.beatPeakDaily,
        best: bestBand && {
          name: bestBand.name,
          tpd: bestBand.tpd,
          ev: bestBand.ev,
          net: bestBand.net,
          daily: bestBand.daily,
          wr: bestBand.wr,
        },
        topBeat: beat.slice(0, 5).map((r) => ({
          name: r.name,
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
