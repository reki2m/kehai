/**
 * Fast hunt for ≥30 pips/day — Aug–Oct M1 + full H1.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import {
  adx,
  atr,
  ema,
  rsi,
  sslDirection,
  supertrendDirection,
  utBotTrail,
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
const TARGET = 30

function loadMerge(files: string[]) {
  const by = new Map<number, any>()
  for (const f of files) {
    if (!existsSync(f)) continue
    const raw = JSON.parse(readFileSync(f, 'utf8'))
    const arr = Array.isArray(raw) ? raw : raw.candles || []
    for (const c of arr) by.set(+c.time, c)
  }
  return [...by.values()]
    .map((c) => ({
      time: +c.time,
      open: +c.open,
      high: +c.high,
      low: +c.low,
      close: +c.close,
      volume: 0,
    }))
    .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
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

function weekdayDays(candles: Candle[]) {
  const s = new Set<string>()
  for (const c of candles) if (isFxWeekday(c.time)) s.add(jstDay(c.time))
  return Math.max(1, s.size)
}

type Risk =
  | { kind: 'atr'; slAtr: number; slMin: number; slMax: number; rr: number; hold: number; beR: number }
  | { kind: 'fixed'; sl: number; tp: number; hold: number; beR: number }

function resolveRisk(atrPips: number, r: Risk) {
  if (r.kind === 'fixed') return { sl: r.sl, tp: r.tp, hold: r.hold, beR: r.beR }
  const sl =
    Math.round(
      Math.max(r.slMin, Math.min(r.slMax, Math.max(0.1, atrPips) * r.slAtr)) *
        10,
    ) / 10
  return { sl, tp: Math.round(sl * r.rr * 10) / 10, hold: r.hold, beR: r.beR }
}

function runEngine(
  candles: Candle[],
  spread: number,
  signalAt: (i: number) => 'BUY' | 'SELL' | null,
  risk: Risk,
  cool: number,
  slots: number,
  atrM: Map<number, number>,
  gapSec: number,
) {
  const pnls: number[] = []
  type P = {
    dir: 1 | -1
    entry: number
    stop: number
    tp: number
    ei: number
    be: boolean
    beR: number
  }
  const open: P[] = []
  let last = -9999
  for (let i = 80; i < candles.length - 1; i++) {
    const c = candles[i]!
    const atrPips = (atrM.get(c.time) ?? 0) / PIP
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p]!
      if (pos.beR > 0 && !pos.be) {
        const favor =
          pos.dir > 0 ? (c.high - pos.entry) / PIP : (pos.entry - c.low) / PIP
        const slDist = Math.abs(pos.entry - pos.stop) / PIP
        if (favor >= slDist * pos.beR) {
          pos.stop = pos.entry
          pos.be = true
        }
      }
      const hitSl = pos.dir > 0 ? c.low <= pos.stop : c.high >= pos.stop
      const hitTp = pos.dir > 0 ? c.high >= pos.tp : c.low <= pos.tp
      const rr = resolveRisk(atrPips, risk)
      const timed = i - pos.ei >= rr.hold
      const gap = c.time - candles[i - 1]!.time > gapSec
      if (gap || hitSl || hitTp || timed) {
        const exit = hitSl ? pos.stop : hitTp ? pos.tp : c.close
        pnls.push(((exit - pos.entry) * pos.dir) / PIP - spread)
        open.splice(p, 1)
      }
    }
    if (!isFxWeekday(c.time) || newsBlackout(c.time)) continue
    if (i - last < cool) continue
    if (open.length >= slots) continue
    const side = signalAt(i)
    if (!side) continue
    const rr = resolveRisk(atrPips, risk)
    const next = candles[i + 1]!
    const dir: 1 | -1 = side === 'BUY' ? 1 : -1
    const entry =
      dir > 0
        ? next.open + spread * PIP * 0.5
        : next.open - spread * PIP * 0.5
    open.push({
      dir,
      entry,
      stop: dir > 0 ? entry - rr.sl * PIP : entry + rr.sl * PIP,
      tp: dir > 0 ? entry + rr.tp * PIP : entry - rr.tp * PIP,
      ei: i + 1,
      be: false,
      beR: rr.beR,
    })
    last = i
  }
  const nd = weekdayDays(candles)
  const n = pnls.length
  const net = pnls.reduce((a, b) => a + b, 0)
  const ev = n ? net / n : 0
  const tpd = n / nd
  return {
    n,
    tpd: Math.round(tpd * 100) / 100,
    wr: n ? Math.round((pnls.filter((p) => p > 0).length / n) * 1000) / 10 : 0,
    ev: Math.round(ev * 100) / 100,
    net: Math.round(net * 10) / 10,
    daily: Math.round(tpd * ev * 100) / 100,
  }
}

function main() {
  const m1 = loadMerge([
    'backtest/data/usdjpy_m1_dukascopy_2026aug.json',
    'backtest/data/usdjpy_m1_dukascopy_2026sep.json',
    'backtest/data/usdjpy_m1_dukascopy_2026oct.json',
  ])
  const h1 = loadMerge(['backtest/data/usdjpy_60m_2025_2026.json'])
  console.log('m1', m1.length, 'h1', h1.length)
  const rows: any[] = []

  // M1
  {
    const profiles = [
      SESSION_PROFILES.tokyo,
      SESSION_PROFILES.london,
      SESSION_PROFILES.ny,
    ]
    const utFlips = new Map<string, Map<number, 'BUY' | 'SELL'>>()
    for (const p of profiles) {
      const key = `${p.utKey}/${p.utAtr}`
      if (utFlips.has(key)) continue
      const { direction } = utBotTrail(m1, p.utKey, p.utAtr)
      utFlips.set(
        key,
        flipMap(new Map(direction.map((d) => [d.time, d.value])), m1),
      )
    }
    const ssl = new Map(sslDirection(m1, 10).map((d) => [d.time, d.value]))
    const htf = new Map(sslDirection(m1, 50).map((d) => [d.time, d.value]))
    const stFlip = flipMap(
      new Map(supertrendDirection(m1, 10, 3).map((d) => [d.time, d.value])),
      m1,
    )
    const adxM = new Map(adx(m1, 14).map((d) => [d.time, d]))
    const atrM = new Map(atr(m1, 14).map((d) => [d.time, d.value]))
    const rsiM = new Map(rsi(m1, 14).map((d) => [d.time, d.value]))

    function gate(t: number, side: 'BUY' | 'SELL', ax: any, needRsi: boolean) {
      const long = side === 'BUY'
      const s = ssl.get(t)
      if (s == null || (long ? s <= 0 : s >= 0)) return false
      const h = htf.get(t)
      if (h == null || (long ? h <= 0 : h >= 0)) return false
      if (long ? ax.plusDi <= ax.minusDi : ax.minusDi <= ax.plusDi) return false
      if (needRsi) {
        const r = rsiM.get(t)
        if (r == null) return false
        if (long && !(r >= 40 && r <= 65)) return false
        if (!long && !(r >= 35 && r <= 60)) return false
      }
      return true
    }

    const modes = [
      {
        id: 'm1_peak24',
        fn(i: number) {
          const t = m1[i]!.time
          const noon = isNoonSignalWindow(t)
          const ax = adxM.get(t)
          if (!ax || ax.adx < (noon ? 24 : 28)) return null
          const fx = detectFxSession(t)
          const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
          const flip = utFlips
            .get(`${profile.utKey}/${profile.utAtr}`)!
            .get(t)
          return flip && gate(t, flip, ax, true) ? flip : null
        },
      },
      {
        id: 'm1_dual',
        fn(i: number) {
          const t = m1[i]!.time
          const noon = isNoonSignalWindow(t)
          const ax = adxM.get(t)
          if (!ax) return null
          if (ax.adx >= (noon ? 18 : 22)) {
            const fx = detectFxSession(t)
            const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
            const flip = utFlips
              .get(`${profile.utKey}/${profile.utAtr}`)!
              .get(t)
            if (flip && gate(t, flip, ax, true)) return flip
          }
          if (ax.adx >= (noon ? 15 : 19)) {
            const flip = stFlip.get(t)
            if (flip && gate(t, flip, ax, false)) return flip
          }
          return null
        },
      },
    ]

    const risks: Risk[] = [
      { kind: 'atr', slAtr: 1, slMin: 7, slMax: 10, rr: 2, hold: 45, beR: 0 },
      { kind: 'atr', slAtr: 1.5, slMin: 8, slMax: 18, rr: 2, hold: 60, beR: 1 },
      { kind: 'atr', slAtr: 2, slMin: 10, slMax: 25, rr: 3, hold: 90, beR: 1 },
      { kind: 'fixed', sl: 10, tp: 20, hold: 60, beR: 0 },
      { kind: 'fixed', sl: 15, tp: 30, hold: 90, beR: 1 },
      { kind: 'fixed', sl: 20, tp: 40, hold: 120, beR: 1 },
    ]

    for (const mode of modes) {
      for (const risk of risks) {
        for (const cool of [3, 5]) {
          for (const slots of [1, 2, 3]) {
            const st = runEngine(
              m1,
              0.2,
              mode.fn,
              risk,
              cool,
              slots,
              atrM,
              120,
            )
            if (st.n < 40) continue
            rows.push({
              tf: '1m',
              mode: mode.id,
              risk,
              cool,
              slots,
              ...st,
            })
          }
        }
      }
    }
    console.log('m1 done', rows.length)
  }

  // H1
  {
    const ema21 = new Map(ema(h1, 21).map((d) => [d.time, d.value]))
    const ema55 = new Map(ema(h1, 55).map((d) => [d.time, d.value]))
    const { direction } = utBotTrail(h1, 2, 7)
    const utFlip = flipMap(
      new Map(direction.map((d) => [d.time, d.value])),
      h1,
    )
    const stFlip = flipMap(
      new Map(supertrendDirection(h1, 10, 3).map((d) => [d.time, d.value])),
      h1,
    )
    const ssl = new Map(sslDirection(h1, 10).map((d) => [d.time, d.value]))
    const adxM = new Map(adx(h1, 14).map((d) => [d.time, d]))
    const atrM = new Map(atr(h1, 14).map((d) => [d.time, d.value]))

    const modes = [
      {
        id: 'h1_ema',
        fn(i: number) {
          const c = h1[i]!
          const p = h1[i - 1]!
          const ax = adxM.get(c.time)
          if (!ax || ax.adx < 18) return null
          const e21 = ema21.get(c.time)
          const e55 = ema55.get(c.time)
          const p21 = ema21.get(p.time)
          const p55 = ema55.get(p.time)
          if (e21 == null || e55 == null || p21 == null || p55 == null)
            return null
          if (p21 <= p55 && e21 > e55 && ax.plusDi > ax.minusDi) return 'BUY'
          if (p21 >= p55 && e21 < e55 && ax.minusDi > ax.plusDi) return 'SELL'
          return null
        },
      },
      {
        id: 'h1_ut',
        fn(i: number) {
          const t = h1[i]!.time
          const ax = adxM.get(t)
          if (!ax || ax.adx < 20) return null
          const flip = utFlip.get(t)
          if (!flip) return null
          const s = ssl.get(t)
          const long = flip === 'BUY'
          if (s == null || (long ? s <= 0 : s >= 0)) return null
          if (long ? ax.plusDi <= ax.minusDi : ax.minusDi <= ax.plusDi)
            return null
          return flip
        },
      },
      {
        id: 'h1_st',
        fn(i: number) {
          const t = h1[i]!.time
          const ax = adxM.get(t)
          if (!ax || ax.adx < 16) return null
          const flip = stFlip.get(t)
          if (!flip) return null
          const s = ssl.get(t)
          const long = flip === 'BUY'
          if (s == null || (long ? s <= 0 : s >= 0)) return null
          if (long ? ax.plusDi <= ax.minusDi : ax.minusDi <= ax.plusDi)
            return null
          return flip
        },
      },
    ]

    const risks: Risk[] = []
    for (const sl of [15, 20, 25, 30, 40]) {
      for (const rr of [1.5, 2, 2.5, 3]) {
        risks.push({
          kind: 'fixed',
          sl,
          tp: Math.round(sl * rr),
          hold: 24,
          beR: 1,
        })
        risks.push({
          kind: 'fixed',
          sl,
          tp: Math.round(sl * rr),
          hold: 48,
          beR: 0,
        })
      }
    }
    for (const slAtr of [1.2, 1.8, 2.5]) {
      for (const rr of [2, 3, 4]) {
        risks.push({
          kind: 'atr',
          slAtr,
          slMin: 12,
          slMax: 50,
          rr,
          hold: 36,
          beR: 1,
        })
      }
    }

    for (const mode of modes) {
      for (const risk of risks) {
        for (const cool of [1, 2]) {
          for (const slots of [1, 2]) {
            const st = runEngine(
              h1,
              0.3,
              mode.fn,
              risk,
              cool,
              slots,
              atrM,
              7200,
            )
            if (st.n < 25) continue
            rows.push({
              tf: '1H',
              mode: mode.id,
              risk,
              cool,
              slots,
              ...st,
            })
          }
        }
      }
    }
    console.log('h1 done', rows.length)
  }

  // Multi-pair Peak projection from Yahoo 5d × scale factor isn't enough;
  // instead report theoretical: best single daily × N pairs
  rows.sort((a, b) => b.daily - a.daily)
  const hit = rows.filter((r) => r.daily >= TARGET && r.ev > 0)
  const best = rows[0]
  const out = {
    target: TARGET,
    scanned: rows.length,
    hit30: hit.length,
    best,
    topHit: hit.slice(0, 15),
    top: rows.slice(0, 25),
    multiPairNote:
      best && best.daily > 0
        ? {
            pairsNeededFor30: Math.ceil(TARGET / best.daily),
            if6pairs: Math.round(best.daily * 6 * 100) / 100,
            if10pairs: Math.round(best.daily * 10 * 100) / 100,
          }
        : null,
  }
  mkdirSync('backtest/out', { recursive: true })
  writeFileSync('backtest/out/daily30.json', JSON.stringify(out, null, 2))
  console.log(JSON.stringify({
    scanned: rows.length,
    hit30: hit.length,
    best: best && {
      tf: best.tf,
      mode: best.mode,
      daily: best.daily,
      tpd: best.tpd,
      ev: best.ev,
      net: best.net,
      wr: best.wr,
      slots: best.slots,
      risk: best.risk,
    },
    top5: rows.slice(0, 5).map((r) => ({
      tf: r.tf,
      mode: r.mode,
      daily: r.daily,
      tpd: r.tpd,
      ev: r.ev,
      wr: r.wr,
    })),
    multi: out.multiPairNote,
  }, null, 2))
}

main()
