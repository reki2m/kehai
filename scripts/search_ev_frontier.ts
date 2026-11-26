/** Find max trades/day with EV>=0 by peeling Peak confirms one-by-one. */
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
    const arr = JSON.parse(readFileSync(f, 'utf8'))
    for (const c of arr) by.set(c.time, c)
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
  return new Date(t * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
}

function main() {
  const candles = loadMerge([
    'backtest/data/usdjpy_m1_dukascopy_2026aug.json',
    'backtest/data/usdjpy_m1_dukascopy_2026sep.json',
    'backtest/data/usdjpy_m1_dukascopy_2026oct.json',
  ])
  console.log('bars', candles.length)

  const profiles = [
    SESSION_PROFILES.tokyo,
    SESSION_PROFILES.london,
    SESSION_PROFILES.ny,
  ]
  const ut = new Map<string, Map<number, number>>()
  for (const p of profiles) {
    const key = `${p.utKey}/${p.utAtr}`
    if (ut.has(key)) continue
    const { direction } = utBotTrail(candles, p.utKey, p.utAtr)
    ut.set(key, new Map(direction.map((d) => [d.time, d.value])))
  }
  const ssl = new Map(sslDirection(candles, 10).map((d) => [d.time, d.value]))
  const htf = new Map(sslDirection(candles, 50).map((d) => [d.time, d.value]))
  const st = new Map(
    supertrendDirection(candles, 10, 3).map((d) => [d.time, d.value]),
  )
  const adxM = new Map(adx(candles, 14).map((d) => [d.time, d]))
  const atrM = new Map(atr(candles, 14).map((d) => [d.time, d.value]))
  const rsiM = new Map(rsi(candles, 14).map((d) => [d.time, d.value]))
  const { wt1, wt2 } = wavetrend(candles, 10, 21)
  const wt1M = new Map(wt1.map((d) => [d.time, d.value]))
  const wt2M = new Map(wt2.map((d) => [d.time, d.value]))

  type Need = {
    htf: boolean
    st: boolean
    di: boolean
    wt: boolean
    rsi: boolean
  }

  const variants: { name: string; need: Need; adxN: number; adxO: number; cool: number; pb: number }[] = [
    { name: 'full', need: { htf: true, st: true, di: true, wt: true, rsi: true }, adxN: 18, adxO: 22, cool: 1, pb: 0 },
    { name: 'no_wt', need: { htf: true, st: true, di: true, wt: false, rsi: true }, adxN: 18, adxO: 22, cool: 1, pb: 0 },
    { name: 'no_rsi', need: { htf: true, st: true, di: true, wt: true, rsi: false }, adxN: 18, adxO: 22, cool: 1, pb: 0 },
    { name: 'no_htf', need: { htf: false, st: true, di: true, wt: true, rsi: true }, adxN: 18, adxO: 22, cool: 1, pb: 0 },
    { name: 'no_st', need: { htf: true, st: false, di: true, wt: true, rsi: true }, adxN: 18, adxO: 22, cool: 1, pb: 0 },
    { name: 'ssl_di_st_rsi', need: { htf: false, st: true, di: true, wt: false, rsi: true }, adxN: 18, adxO: 22, cool: 1, pb: 0 },
    { name: 'ssl_di_htf_rsi', need: { htf: true, st: false, di: true, wt: false, rsi: true }, adxN: 18, adxO: 22, cool: 1, pb: 0 },
    { name: 'ssl_di_st', need: { htf: false, st: true, di: true, wt: false, rsi: false }, adxN: 18, adxO: 22, cool: 1, pb: 0 },
    { name: 'ssl_di', need: { htf: false, st: false, di: true, wt: false, rsi: false }, adxN: 18, adxO: 22, cool: 1, pb: 0 },
    { name: 'ssl_only', need: { htf: false, st: false, di: false, wt: false, rsi: false }, adxN: 18, adxO: 22, cool: 1, pb: 0 },
    // frequency boosters on best cores
    { name: 'ssl_di_st_rsi_pb5', need: { htf: false, st: true, di: true, wt: false, rsi: true }, adxN: 16, adxO: 20, cool: 8, pb: 5 },
    { name: 'ssl_di_st_rsi_cd8', need: { htf: false, st: true, di: true, wt: false, rsi: true }, adxN: 16, adxO: 20, cool: 8, pb: 0 },
    { name: 'ssl_di_htf_rsi_pb5', need: { htf: true, st: false, di: true, wt: false, rsi: true }, adxN: 16, adxO: 20, cool: 8, pb: 5 },
    { name: 'full_pb3', need: { htf: true, st: true, di: true, wt: true, rsi: true }, adxN: 18, adxO: 22, cool: 5, pb: 3 },
    { name: 'full_adx16', need: { htf: true, st: true, di: true, wt: true, rsi: true }, adxN: 16, adxO: 20, cool: 1, pb: 0 },
  ]

  const rows = []
  for (const v of variants) {
    const pnls: number[] = []
    let pos: 0 | 1 | -1 = 0
    let entry = 0
    let stop = 0
    let tp = 0
    let ei = 0
    let last = -9999
    const pending = new Map<number, 'BUY' | 'SELL'>()

    for (let i = 150; i < candles.length - 1; i++) {
      const c = candles[i]
      if (pos !== 0) {
        const hitSl = pos > 0 ? c.low <= stop : c.high >= stop
        const hitTp = pos > 0 ? c.high >= tp : c.low <= tp
        const timed = i - ei >= 45
        const gap = c.time - candles[i - 1].time > 120
        if (gap || hitSl || hitTp || timed) {
          let exit = hitSl ? stop : hitTp ? tp : c.close
          pnls.push(((exit - entry) * pos) / PIP - SPREAD)
          pos = 0
        }
        continue
      }
      if (!isFxWeekday(c.time) || newsBlackout(c.time)) continue
      if (i - last < v.cool) continue
      const noon = isNoonSignalWindow(c.time)
      const ax = adxM.get(c.time)
      if (!ax || ax.adx < (noon ? v.adxN : v.adxO)) continue
      const atrV = atrM.get(c.time) ?? 0
      const atrPips = atrV / PIP
      if (atrPips > 0 && atrPips < SIMPLE.minAtrPips) continue

      const fx = detectFxSession(c.time)
      const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
      const key = `${profile.utKey}/${profile.utAtr}`
      const um = ut.get(key)!
      const prev = um.get(candles[i - 1].time)
      const cur = um.get(c.time)
      let flip: 'BUY' | 'SELL' | null = null
      if (cur != null && prev != null) {
        if (cur > 0 && prev <= 0) flip = 'BUY'
        if (cur < 0 && prev >= 0) flip = 'SELL'
      }
      if (flip) pending.set(i, flip)
      for (const [bi] of [...pending]) if (i - bi > v.pb) pending.delete(bi)

      let side: 'BUY' | 'SELL' | null = null
      if (v.pb === 0) side = flip
      else {
        for (const [, s] of pending) {
          if (cur == null) break
          if (s === 'BUY' && cur > 0) {
            side = 'BUY'
            break
          }
          if (s === 'SELL' && cur < 0) {
            side = 'SELL'
            break
          }
        }
      }
      if (!side) continue

      const long = side === 'BUY'
      const sslV = ssl.get(c.time)
      if (sslV == null || (long ? sslV <= 0 : sslV >= 0)) continue
      if (v.need.htf) {
        const h = htf.get(c.time)
        if (h == null || (long ? h <= 0 : h >= 0)) continue
      }
      if (v.need.st) {
        const s = st.get(c.time)
        if (s == null || (long ? s <= 0 : s >= 0)) continue
      }
      if (v.need.di) {
        if (long ? ax.plusDi <= ax.minusDi : ax.minusDi <= ax.plusDi) continue
      }
      if (v.need.wt) {
        const a = wt1M.get(c.time)
        const b = wt2M.get(c.time)
        if (a == null || b == null || (long ? !(a > b) : !(a < b))) continue
      }
      if (v.need.rsi) {
        const r = rsiM.get(c.time)
        if (r == null) continue
        if (long && !(r >= 40 && r <= 65)) continue
        if (!long && !(r >= 35 && r <= 60)) continue
      }

      const { sl, tp: tpP } = atrRiskPips(atrPips)
      const next = candles[i + 1]
      if (long) {
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
    for (const c of candles) if (isFxWeekday(c.time)) days.add(jstDay(c.time))
    const nd = Math.max(1, days.size)
    const n = pnls.length
    const net = pnls.reduce((a, b) => a + b, 0)
    const wr = n ? pnls.filter((p) => p > 0).length / n : 0
    const row = {
      name: v.name,
      n,
      tpd: Math.round((n / nd) * 100) / 100,
      wr: Math.round(wr * 1000) / 10,
      ev: n ? Math.round((net / n) * 1000) / 1000 : 0,
      net: Math.round(net * 10) / 10,
      days: nd,
    }
    rows.push(row)
    console.log(
      `${row.name.padEnd(22)} tpd=${row.tpd.toFixed(2)} n=${row.n} wr=${row.wr}% ev=${row.ev} net=${row.net}`,
    )
  }

  mkdirSync('backtest/out', { recursive: true })
  writeFileSync('backtest/out/ev_frontier.json', JSON.stringify(rows, null, 2))
}

main()
