/**
 * Fast search: multi-UT session flips × soft confirms × risk grid.
 * Goal: ~10/day with EV>0 (or best compromise).
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

function loadMerge(files: string[]): Candle[] {
  const by = new Map<number, Candle>()
  for (const f of files) {
    if (!existsSync(f)) continue
    const raw = JSON.parse(readFileSync(f, 'utf8'))
    const arr = Array.isArray(raw) ? raw : raw.candles || []
    for (const c of arr) {
      by.set(c.time, {
        time: c.time,
        open: +c.open,
        high: +c.high,
        low: +c.low,
        close: +c.close,
        volume: +(c.volume ?? 0) || 0,
      })
    }
    console.log('loaded', f, arr.length)
  }
  return [...by.values()].sort((a, b) => a.time - b.time)
}

function jstDay(t: number) {
  return new Date(t * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
}

type Pre = {
  candles: Candle[]
  utKeys: string[]
  ut: Map<string, Map<number, number>>
  ssl: Map<number, number>
  htf: Map<number, number>
  st: Map<number, number>
  adx: Map<number, { adx: number; plusDi: number; minusDi: number }>
  atr: Map<number, number>
  rsi: Map<number, number>
  wt1: Map<number, number>
  wt2: Map<number, number>
  flips: Map<string, Map<number, 'BUY' | 'SELL'>>
}

function build(candles: Candle[]): Pre {
  const profiles = [
    SESSION_PROFILES.tokyo,
    SESSION_PROFILES.london,
    SESSION_PROFILES.ny,
  ]
  const ut = new Map<string, Map<number, number>>()
  const flips = new Map<string, Map<number, 'BUY' | 'SELL'>>()
  const utKeys: string[] = []
  for (const p of profiles) {
    const key = `${p.utKey}/${p.utAtr}`
    if (ut.has(key)) continue
    utKeys.push(key)
    const { direction } = utBotTrail(candles, p.utKey, p.utAtr)
    const m = new Map(direction.map((d) => [d.time, d.value]))
    ut.set(key, m)
    const f = new Map<number, 'BUY' | 'SELL'>()
    for (let i = 1; i < candles.length; i++) {
      const a = m.get(candles[i - 1].time)
      const b = m.get(candles[i].time)
      if (a == null || b == null) continue
      if (b > 0 && a <= 0) f.set(candles[i].time, 'BUY')
      else if (b < 0 && a >= 0) f.set(candles[i].time, 'SELL')
    }
    flips.set(key, f)
  }
  const { wt1, wt2 } = wavetrend(candles, 10, 21)
  return {
    candles,
    utKeys,
    ut,
    ssl: new Map(sslDirection(candles, 10).map((d) => [d.time, d.value])),
    htf: new Map(sslDirection(candles, 50).map((d) => [d.time, d.value])),
    st: new Map(
      supertrendDirection(candles, 10, 3).map((d) => [d.time, d.value]),
    ),
    adx: new Map(adx(candles, 14).map((d) => [d.time, d])),
    atr: new Map(atr(candles, 14).map((d) => [d.time, d.value])),
    rsi: new Map(rsi(candles, 14).map((d) => [d.time, d.value])),
    wt1: new Map(wt1.map((d) => [d.time, d.value])),
    wt2: new Map(wt2.map((d) => [d.time, d.value])),
    flips,
  }
}

type Mode = 'peak' | 'core' | 'core_pb' | 'multi_ut' | 'multi_ut_score'

type Cfg = {
  name: string
  mode: Mode
  adxNoon: number
  adxOff: number
  cooldown: number
  pb: number
  minScore: number
  risk: 'atr' | 'fixed'
  sl: number
  tp: number
  need: {
    ssl: boolean
    htf: boolean
    st: boolean
    di: boolean
    wt: boolean
    rsi: boolean
  }
}

function scoreSide(
  pre: Pre,
  t: number,
  side: 'BUY' | 'SELL',
  need: Cfg['need'],
): { ok: boolean; score: number } {
  const long = side === 'BUY'
  const ssl = pre.ssl.get(t)
  const htf = pre.htf.get(t)
  const st = pre.st.get(t)
  const ax = pre.adx.get(t)
  const rv = pre.rsi.get(t)
  const w1 = pre.wt1.get(t)
  const w2 = pre.wt2.get(t)
  const sslOk = ssl != null && (long ? ssl > 0 : ssl < 0)
  const htfOk = htf != null && (long ? htf > 0 : htf < 0)
  const stOk = st != null && (long ? st > 0 : st < 0)
  const diOk = !!ax && (long ? ax.plusDi > ax.minusDi : ax.minusDi > ax.plusDi)
  const wtOk = w1 != null && w2 != null && (long ? w1 > w2 : w1 < w2)
  const rsiOk =
    rv != null && (long ? rv >= 38 && rv <= 68 : rv >= 32 && rv <= 62)
  if (need.ssl && !sslOk) return { ok: false, score: 0 }
  if (need.htf && !htfOk) return { ok: false, score: 0 }
  if (need.st && !stOk) return { ok: false, score: 0 }
  if (need.di && !diOk) return { ok: false, score: 0 }
  if (need.wt && !wtOk) return { ok: false, score: 0 }
  if (need.rsi && !rsiOk) return { ok: false, score: 0 }
  let score = 1
  if (sslOk) score++
  if (htfOk) score++
  if (stOk) score++
  if (diOk) score++
  if (wtOk) score++
  if (rsiOk) score++
  if (ax && ax.adx >= 25) score++
  return { ok: true, score }
}

function simulate(pre: Pre, cfg: Cfg) {
  const { candles } = pre
  const trades: number[] = []
  let pos: 0 | 1 | -1 = 0
  let entry = 0
  let stop = 0
  let tp = 0
  let ei = 0
  let last = -9999
  // pending flip times for pullback
  const pending = new Map<number, 'BUY' | 'SELL'>() // bar index -> side

  for (let i = 150; i < candles.length - 1; i++) {
    const c = candles[i]
    if (pos !== 0) {
      const hitSl = pos > 0 ? c.low <= stop : c.high >= stop
      const hitTp = pos > 0 ? c.high >= tp : c.low <= tp
      const timed = i - ei >= 45
      const gap = c.time - candles[i - 1].time > 120
      if (gap || hitSl || hitTp || timed) {
        let exit = c.close
        if (hitSl) exit = stop
        else if (hitTp) exit = tp
        trades.push(((exit - entry) * pos) / PIP - SPREAD)
        pos = 0
      }
      continue
    }

    if (!isFxWeekday(c.time) || newsBlackout(c.time)) continue
    if (i - last < cfg.cooldown) continue
    const noon = isNoonSignalWindow(c.time)
    const ax = pre.adx.get(c.time)
    const floor = noon ? cfg.adxNoon : cfg.adxOff
    if (!ax || ax.adx < floor) continue
    const atrV = pre.atr.get(c.time) ?? 0
    const atrPips = atrV / PIP
    if (atrPips > 0 && atrPips < 1.0) continue

    let side: 'BUY' | 'SELL' | null = null

    if (cfg.mode === 'peak' || cfg.mode === 'core' || cfg.mode === 'core_pb') {
      const fx = detectFxSession(c.time)
      const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
      const key = `${profile.utKey}/${profile.utAtr}`
      const flipNow = pre.flips.get(key)!.get(c.time) ?? null
      if (flipNow) pending.set(i, flipNow)
      // expire old
      for (const [bi] of [...pending]) {
        if (i - bi > cfg.pb) pending.delete(bi)
      }
      if (cfg.mode === 'core' || cfg.mode === 'peak') {
        side = flipNow
      } else {
        // pullback: take oldest pending if UT still aligned
        const ut = pre.ut.get(key)!.get(c.time)
        for (const [bi, s] of pending) {
          if (ut == null) continue
          if (s === 'BUY' && ut > 0) {
            side = 'BUY'
            break
          }
          if (s === 'SELL' && ut < 0) {
            side = 'SELL'
            break
          }
        }
      }
      if (cfg.mode === 'peak') {
        cfg.need = {
          ssl: true,
          htf: true,
          st: true,
          di: true,
          wt: true,
          rsi: true,
        }
      }
    } else {
      // multi UT: any profile flip this bar
      for (const key of pre.utKeys) {
        const f = pre.flips.get(key)!.get(c.time)
        if (f) {
          side = f
          break
        }
      }
    }

    if (!side) continue
    const sc = scoreSide(pre, c.time, side, cfg.need)
    if (!sc.ok || sc.score < cfg.minScore) continue

    let sl = cfg.sl
    let tpP = cfg.tp
    if (cfg.risk === 'atr') {
      const r = atrRiskPips(atrPips)
      sl = r.sl
      tpP = r.tp
    }
    const next = candles[i + 1]
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
    pending.clear()
  }

  const days = new Set<string>()
  for (const c of candles) {
    if (isFxWeekday(c.time)) days.add(jstDay(c.time))
  }
  const nd = Math.max(1, days.size)
  const n = trades.length
  if (!n) return { n: 0, wr: 0, ev: 0, net: 0, tpd: 0, days: nd }
  const wins = trades.filter((p) => p > 0).length
  const net = trades.reduce((a, b) => a + b, 0)
  return {
    n,
    wr: Math.round((wins / n) * 1000) / 10,
    ev: Math.round((net / n) * 1000) / 1000,
    net: Math.round(net * 10) / 10,
    tpd: Math.round((n / nd) * 100) / 100,
    days: nd,
  }
}

function main() {
  const candles = loadMerge([
    'backtest/data/usdjpy_m1_dukascopy_2026aug.json',
    'backtest/data/usdjpy_m1_dukascopy_2026sep.json',
    'backtest/data/usdjpy_m1_dukascopy_2026oct.json',
  ])
  console.log('building…', candles.length)
  const pre = build(candles)
  console.log('ut keys', pre.utKeys)

  const needPeak = {
    ssl: true,
    htf: true,
    st: true,
    di: true,
    wt: true,
    rsi: true,
  }
  const needCore = {
    ssl: true,
    htf: false,
    st: true,
    di: true,
    wt: false,
    rsi: true,
  }
  const needLite = {
    ssl: true,
    htf: false,
    st: false,
    di: true,
    wt: false,
    rsi: false,
  }
  const needQual = {
    ssl: true,
    htf: true,
    st: false,
    di: true,
    wt: true,
    rsi: true,
  }

  const cfgs: Cfg[] = []
  cfgs.push({
    name: 'peak_atr',
    mode: 'peak',
    adxNoon: 18,
    adxOff: 22,
    cooldown: 1,
    pb: 0,
    minScore: 6,
    risk: 'atr',
    sl: 7,
    tp: 10,
    need: needPeak,
  })

  // Compact grid aimed at ~10/day
  for (const risk of [
    { risk: 'atr' as const, sl: 7, tp: 10 },
    { risk: 'fixed' as const, sl: 5, tp: 8 },
    { risk: 'fixed' as const, sl: 4, tp: 6 },
    { risk: 'fixed' as const, sl: 6, tp: 9 },
  ]) {
    for (const [label, need] of [
      ['core', needCore],
      ['lite', needLite],
      ['qual', needQual],
    ] as const) {
      for (const cool of [8, 12]) {
        for (const minScore of [4, 5]) {
          cfgs.push({
            name: `multi_${label}_s${minScore}_cd${cool}_${risk.risk}${risk.sl}x${risk.tp}`,
            mode: 'multi_ut',
            adxNoon: 16,
            adxOff: 20,
            cooldown: cool,
            pb: 0,
            minScore,
            risk: risk.risk,
            sl: risk.sl,
            tp: risk.tp,
            need,
          })
          cfgs.push({
            name: `pb_${label}_s${minScore}_cd${cool}_${risk.risk}${risk.sl}x${risk.tp}`,
            mode: 'core_pb',
            adxNoon: 16,
            adxOff: 20,
            cooldown: cool,
            pb: 5,
            minScore,
            risk: risk.risk,
            sl: risk.sl,
            tp: risk.tp,
            need,
          })
        }
      }
    }
  }

  console.log('cfgs', cfgs.length)
  const rows: any[] = []
  for (const cfg of cfgs) {
    const st = simulate(pre, cfg)
    rows.push({ name: cfg.name, mode: cfg.mode, ...riskMeta(cfg), ...st })
    if (cfg.name === 'peak_atr' || (st.tpd >= 8 && st.tpd <= 12 && st.ev > -0.05)) {
      console.log(
        cfg.name,
        `tpd=${st.tpd} wr=${st.wr} ev=${st.ev} net=${st.net}`,
      )
    }
  }

  const band = rows
    .filter((r) => r.tpd >= 8 && r.tpd <= 12)
    .sort((a, b) => b.ev - a.ev || b.wr - a.wr)
  const pos = band.filter((r) => r.ev > 0)
  const near = [...rows]
    .filter((r) => r.n > 50)
    .sort(
      (a, b) =>
        Math.abs(a.tpd - 10) - Math.abs(b.tpd - 10) || b.ev - a.ev,
    )
    .slice(0, 25)
  const bestEv = [...rows].filter((r) => r.n > 30).sort((a, b) => b.ev - a.ev).slice(0, 15)

  const report = {
    peak: rows.find((r) => r.name === 'peak_atr'),
    band_pos: pos.slice(0, 10),
    band_top: band.slice(0, 15),
    nearest10: near,
    best_ev: bestEv,
  }
  mkdirSync('backtest/out', { recursive: true })
  writeFileSync('backtest/out/ten_fast.json', JSON.stringify(report, null, 2))
  console.log('\nPEAK', report.peak)
  console.log('BAND POS', pos.length)
  console.log('BAND TOP', band.slice(0, 8))
  console.log('BEST EV', bestEv.slice(0, 8))
  console.log('NEAR10', near.slice(0, 8))
}

function riskMeta(cfg: Cfg) {
  return {
    risk: cfg.risk,
    sl: cfg.sl,
    tp: cfg.tp,
    minScore: cfg.minScore,
    cooldown: cfg.cooldown,
    pb: cfg.pb,
    adxNoon: cfg.adxNoon,
    need: cfg.need,
  }
}

main()
