/**
 * Maximize EV / net on Dukascopy Aug–Oct — quality over frequency.
 * Peak-family gates + risk knobs + optional ST path.
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

function atrRisk(
  atrPips: number,
  knobs: { slAtr: number; slMin: number; slMax: number; rr: number; tpMin: number; tpMax: number },
) {
  if (!(atrPips > 0)) return { sl: 7, tp: 10 }
  const sl =
    Math.round(
      Math.max(knobs.slMin, Math.min(knobs.slMax, atrPips * knobs.slAtr)) * 10,
    ) / 10
  const tp =
    Math.round(
      Math.max(knobs.tpMin, Math.min(knobs.tpMax, sl * knobs.rr)) * 10,
    ) / 10
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
    const m = new Map(direction.map((d) => [d.time, d.value]))
    utFlips.set(key, flipMap(m, candles))
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

  type Cfg = {
    name: string
    adxN: number
    adxO: number
    requireSt: boolean
    requireHtf: boolean
    requireDi: boolean
    requireWt: boolean
    requireRsi: boolean
    pulse: null | { adxN: number; adxO: number; rsi: boolean }
    cool: number
    minAtr: number
    risk: {
      slAtr: number
      slMin: number
      slMax: number
      rr: number
      tpMin: number
      tpMax: number
    }
    noonOnly: boolean
  }

  const risks = [
    { slAtr: 1.1, slMin: 6, slMax: 10, rr: 1.45, tpMin: 9, tpMax: 14 },
    { slAtr: 1.0, slMin: 5, slMax: 9, rr: 1.6, tpMin: 8, tpMax: 14 },
    { slAtr: 1.2, slMin: 6, slMax: 11, rr: 1.8, tpMin: 10, tpMax: 16 },
    { slAtr: 1.0, slMin: 7, slMax: 10, rr: 2.0, tpMin: 12, tpMax: 18 },
  ]

  const cfgs: Cfg[] = []
  for (const adxN of [18, 20, 22, 24]) {
    for (const adxO of [adxN + 2, adxN + 4]) {
      for (const requireSt of [false, true]) {
        for (const risk of risks) {
          for (const noonOnly of [false, true]) {
            cfgs.push({
              name: `peak_a${adxN}_${adxO}_st${requireSt ? 1 : 0}_n${noonOnly ? 1 : 0}_rr${risk.rr}`,
              adxN,
              adxO,
              requireSt,
              requireHtf: true,
              requireDi: true,
              requireWt: true,
              requireRsi: true,
              pulse: null,
              cool: 5,
              minAtr: 1.2,
              risk,
              noonOnly,
            })
          }
        }
      }
    }
  }
  // Best dual from prior: peak + ST pulse with RSI
  for (const pulse of [
    { adxN: 16, adxO: 22, rsi: true },
    { adxN: 18, adxO: 22, rsi: true },
    { adxN: 18, adxO: 22, rsi: false },
  ]) {
    for (const risk of risks.slice(0, 2)) {
      cfgs.push({
        name: `dual_p${pulse.adxN}_${pulse.adxO}_r${pulse.rsi ? 1 : 0}_rr${risk.rr}`,
        adxN: 18,
        adxO: 22,
        requireSt: false,
        requireHtf: true,
        requireDi: true,
        requireWt: true,
        requireRsi: true,
        pulse,
        cool: 5,
        minAtr: 1.2,
        risk,
        noonOnly: false,
      })
    }
  }

  function run(cfg: Cfg) {
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
      if (i - last < cfg.cool) continue
      const noon = isNoonSignalWindow(c.time)
      if (cfg.noonOnly && !noon) continue
      const ax = adxM.get(c.time)
      if (!ax) continue
      const atrV = atrM.get(c.time) ?? 0
      const atrPips = atrV / PIP
      if (atrPips > 0 && atrPips < cfg.minAtr) continue

      let side: 'BUY' | 'SELL' | null = null

      // Peak UT path
      if (ax.adx >= (noon ? cfg.adxN : cfg.adxO)) {
        const fx = detectFxSession(c.time)
        const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
        const key = `${profile.utKey}/${profile.utAtr}`
        const flip = utFlips.get(key)!.get(c.time)
        if (flip) {
          const long = flip === 'BUY'
          const sslV = ssl.get(c.time)
          const okSsl = sslV != null && (long ? sslV > 0 : sslV < 0)
          const h = htf.get(c.time)
          const okHtf =
            !cfg.requireHtf || (h != null && (long ? h > 0 : h < 0))
          const s = stDir.get(c.time)
          const okSt =
            !cfg.requireSt || (s != null && (long ? s > 0 : s < 0))
          const okDi =
            !cfg.requireDi ||
            (long ? ax.plusDi > ax.minusDi : ax.minusDi > ax.plusDi)
          const w1 = wt1M.get(c.time)
          const w2 = wt2M.get(c.time)
          const okWt =
            !cfg.requireWt ||
            (w1 != null &&
              w2 != null &&
              (long ? w1 > w2 : w1 < w2))
          const r = rsiM.get(c.time)
          const okRsi =
            !cfg.requireRsi ||
            (r != null &&
              (long ? r >= 40 && r <= 65 : r >= 35 && r <= 60))
          if (okSsl && okHtf && okSt && okDi && okWt && okRsi) side = flip
        }
      }

      // Pulse ST path
      if (!side && cfg.pulse && ax.adx >= (noon ? cfg.pulse.adxN : cfg.pulse.adxO)) {
        const flip = stFlip.get(c.time)
        if (flip) {
          const long = flip === 'BUY'
          const sslV = ssl.get(c.time)
          const okSsl = sslV != null && (long ? sslV > 0 : sslV < 0)
          const h = htf.get(c.time)
          const okHtf = h != null && (long ? h > 0 : h < 0)
          const okDi = long ? ax.plusDi > ax.minusDi : ax.minusDi > ax.plusDi
          const w1 = wt1M.get(c.time)
          const w2 = wt2M.get(c.time)
          const okWt =
            w1 != null && w2 != null && (long ? w1 > w2 : w1 < w2)
          const r = rsiM.get(c.time)
          const okRsi =
            !cfg.pulse.rsi ||
            (r != null &&
              (long ? r >= 40 && r <= 65 : r >= 35 && r <= 60))
          if (okSsl && okHtf && okDi && okWt && okRsi) side = flip
        }
      }

      if (!side) continue
      const { sl, tp: tpP } = atrRisk(atrPips, cfg.risk)
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
  for (const cfg of cfgs) {
    const st = run(cfg)
    if (st.n < 40) continue
    rows.push({ ...cfg, ...st })
  }
  rows.sort((a, b) => b.net - a.net || b.ev - a.ev)
  const byEv = [...rows].sort((a, b) => b.ev - a.ev || b.net - a.net)
  const out = {
    bestNet: rows[0],
    bestEv: byEv[0],
    topNet: rows.slice(0, 15),
    topEv: byEv.slice(0, 15),
    scanned: rows.length,
  }
  mkdirSync('backtest/out', { recursive: true })
  writeFileSync('backtest/out/max_edge.json', JSON.stringify(out, null, 2))
  console.log('scanned', rows.length)
  console.log('bestNet', {
    name: rows[0]?.name,
    tpd: rows[0]?.tpd,
    ev: rows[0]?.ev,
    net: rows[0]?.net,
    wr: rows[0]?.wr,
  })
  console.log('bestEv', {
    name: byEv[0]?.name,
    tpd: byEv[0]?.tpd,
    ev: byEv[0]?.ev,
    net: byEv[0]?.net,
    wr: byEv[0]?.wr,
  })
  console.log(
    'top5 net',
    rows.slice(0, 5).map((r) => ({
      n: r.name,
      tpd: r.tpd,
      ev: r.ev,
      net: r.net,
      wr: r.wr,
    })),
  )
}

main()
