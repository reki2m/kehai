/**
 * Hunt systems with mean daily edge ≥ 30 pips (USDJPY).
 * Tries M1 Peak-family, H1 trend, and multi-slot / larger RR.
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
const SPREAD_M1 = 0.2
const SPREAD_H1 = 0.3
const TARGET = 30

function loadMerge(files: string[]) {
  const by = new Map<number, any>()
  for (const f of files) {
    if (!existsSync(f)) continue
    const raw = JSON.parse(readFileSync(f, 'utf8'))
    const arr = Array.isArray(raw) ? raw : raw.candles || []
    for (const c of arr) by.set(c.time, c)
  }
  return [...by.values()]
    .map((c) => ({
      time: +c.time,
      open: +c.open,
      high: +c.high,
      low: +c.low,
      close: +c.close,
      volume: +(c.volume ?? 0) || 0,
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

type Risk = {
  slAtr: number
  slMin: number
  slMax: number
  rr: number
  hold: number
  beR: number
}

function riskPips(atrPips: number, r: Risk) {
  const sl =
    Math.round(
      Math.max(r.slMin, Math.min(r.slMax, Math.max(0.1, atrPips) * r.slAtr)) *
        10,
    ) / 10
  const tp = Math.round(sl * r.rr * 10) / 10
  return { sl, tp }
}

function runEngine(
  candles: Candle[],
  spread: number,
  signalAt: (i: number) => 'BUY' | 'SELL' | null,
  risk: Risk,
  cool: number,
  slots: number,
  atrM: Map<number, number>,
) {
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
  for (let i = 80; i < candles.length - 1; i++) {
    const c = candles[i]!
    const atrPips = (atrM.get(c.time) ?? 0) / PIP
    for (let p = open.length - 1; p >= 0; p--) {
      const pos = open[p]!
      if (risk.beR > 0 && !pos.be) {
        const favor =
          pos.dir > 0 ? (c.high - pos.entry) / PIP : (pos.entry - c.low) / PIP
        const slDist = Math.abs(pos.entry - pos.stop) / PIP
        if (favor >= slDist * risk.beR) {
          pos.stop = pos.entry
          pos.be = true
        }
      }
      const hitSl = pos.dir > 0 ? c.low <= pos.stop : c.high >= pos.stop
      const hitTp = pos.dir > 0 ? c.high >= pos.tp : c.low <= pos.tp
      const timed = i - pos.ei >= risk.hold
      const gap = c.time - candles[i - 1]!.time > (spread > 0.25 ? 7200 : 120)
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
    const { sl, tp } = riskPips(atrPips, risk)
    const next = candles[i + 1]!
    const dir: 1 | -1 = side === 'BUY' ? 1 : -1
    const entry =
      dir > 0
        ? next.open + spread * PIP * 0.5
        : next.open - spread * PIP * 0.5
    open.push({
      dir,
      entry,
      stop: dir > 0 ? entry - sl * PIP : entry + sl * PIP,
      tp: dir > 0 ? entry + tp * PIP : entry - tp * PIP,
      ei: i + 1,
      be: false,
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
    'backtest/data/usdjpy_m1_dukascopy_2026jan.json',
    'backtest/data/usdjpy_m1_dukascopy_2026feb.json',
    'backtest/data/usdjpy_m1_dukascopy_2026mar.json',
    'backtest/data/usdjpy_m1_dukascopy_2026apr.json',
    'backtest/data/usdjpy_m1_dukascopy_2026may.json',
    'backtest/data/usdjpy_m1_dukascopy_2026jun.json',
    'backtest/data/usdjpy_m1_dukascopy_2026jul.json',
    'backtest/data/usdjpy_m1_dukascopy_2026aug.json',
    'backtest/data/usdjpy_m1_dukascopy_2026sep.json',
    'backtest/data/usdjpy_m1_dukascopy_2026oct.json',
  ])
  const h1 = loadMerge(['backtest/data/usdjpy_60m_2025_2026.json'])
  console.log('m1', m1.length, 'h1', h1.length)

  const rows: any[] = []

  // ——— M1 Peak family ———
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
    const { wt1, wt2 } = wavetrend(m1, 10, 21)
    const wt1M = new Map(wt1.map((d) => [d.time, d.value]))
    const wt2M = new Map(wt2.map((d) => [d.time, d.value]))

    function gate(
      t: number,
      side: 'BUY' | 'SELL',
      ax: any,
      needRsi: boolean,
    ) {
      const long = side === 'BUY'
      const s = ssl.get(t)
      if (s == null || (long ? s <= 0 : s >= 0)) return false
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

    const modes: {
      id: string
      fn: (i: number) => 'BUY' | 'SELL' | null
    }[] = [
      {
        id: 'm1_peak24',
        fn(i) {
          const t = m1[i]!.time
          const noon = isNoonSignalWindow(t)
          const ax = adxM.get(t)
          if (!ax || ax.adx < (noon ? 24 : 28)) return null
          const fx = detectFxSession(t)
          const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
          const flip = utFlips
            .get(`${profile.utKey}/${profile.utAtr}`)!
            .get(t)
          if (!flip || !gate(t, flip, ax, true)) return null
          return flip
        },
      },
      {
        id: 'm1_peak18+st15',
        fn(i) {
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
      {
        id: 'm1_ut_soft14',
        fn(i) {
          const t = m1[i]!.time
          const noon = isNoonSignalWindow(t)
          const ax = adxM.get(t)
          if (!ax || ax.adx < (noon ? 14 : 18)) return null
          const fx = detectFxSession(t)
          const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
          const flip = utFlips
            .get(`${profile.utKey}/${profile.utAtr}`)!
            .get(t)
          if (!flip || !gate(t, flip, ax, true)) return null
          return flip
        },
      },
    ]

    const risks: Risk[] = []
    for (const slAtr of [1.0, 1.5, 2.0]) {
      for (const rr of [1.5, 2.0, 3.0, 4.0]) {
        for (const hold of [30, 60, 120]) {
          for (const beR of [0, 1.0]) {
            risks.push({
              slAtr,
              slMin: 5,
              slMax: slAtr >= 2 ? 25 : 12,
              rr,
              hold,
              beR,
            })
          }
        }
      }
    }

    for (const mode of modes) {
      for (const risk of risks) {
        for (const cool of [3, 5]) {
          for (const slots of [1, 2, 3]) {
            const st = runEngine(
              m1,
              SPREAD_M1,
              mode.fn,
              risk,
              cool,
              slots,
              atrM,
            )
            if (st.n < 30) continue
            rows.push({
              tf: '1m',
              mode: mode.id,
              risk: `a${risk.slAtr}_r${risk.rr}_h${risk.hold}_b${risk.beR}`,
              cool,
              slots,
              ...st,
            })
          }
        }
      }
    }
  }

  // ——— H1 trend ———
  if (h1.length > 200) {
    const ema21 = new Map(ema(h1, 21).map((d) => [d.time, d.value]))
    const ema55 = new Map(ema(h1, 55).map((d) => [d.time, d.value]))
    const { direction } = utBotTrail(h1, 2, 7)
    const utDir = new Map(direction.map((d) => [d.time, d.value]))
    const utFlip = flipMap(utDir, h1)
    const stFlip = flipMap(
      new Map(supertrendDirection(h1, 10, 3).map((d) => [d.time, d.value])),
      h1,
    )
    const ssl = new Map(sslDirection(h1, 10).map((d) => [d.time, d.value]))
    const adxM = new Map(adx(h1, 14).map((d) => [d.time, d]))
    const atrM = new Map(atr(h1, 14).map((d) => [d.time, d.value]))

    const modes: { id: string; fn: (i: number) => 'BUY' | 'SELL' | null }[] = [
      {
        id: 'h1_ema_cross_adx',
        fn(i) {
          const c = h1[i]!
          const p = h1[i - 1]!
          const ax = adxM.get(c.time)
          if (!ax || ax.adx < 20) return null
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
        id: 'h1_ut_ssl_adx22',
        fn(i) {
          const t = h1[i]!.time
          const ax = adxM.get(t)
          if (!ax || ax.adx < 22) return null
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
        id: 'h1_st_ssl_adx18',
        fn(i) {
          const t = h1[i]!.time
          const ax = adxM.get(t)
          if (!ax || ax.adx < 18) return null
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
    for (const slAtr of [1.0, 1.5, 2.0, 2.5]) {
      for (const rr of [1.5, 2.0, 3.0, 4.0]) {
        for (const hold of [12, 24, 48]) {
          for (const beR of [0, 1.0]) {
            risks.push({
              slAtr,
              slMin: 10,
              slMax: 40,
              rr,
              hold,
              beR,
            })
          }
        }
      }
    }

    for (const mode of modes) {
      for (const risk of risks) {
        for (const cool of [1, 3]) {
          for (const slots of [1, 2]) {
            const st = runEngine(
              h1,
              SPREAD_H1,
              mode.fn,
              risk,
              cool,
              slots,
              atrM,
            )
            if (st.n < 20) continue
            rows.push({
              tf: '1H',
              mode: mode.id,
              risk: `a${risk.slAtr}_r${risk.rr}_h${risk.hold}_b${risk.beR}`,
              cool,
              slots,
              ...st,
            })
          }
        }
      }
    }
  }

  rows.sort((a, b) => b.daily - a.daily)
  const hit = rows.filter((r) => r.daily >= TARGET)
  const out = {
    target: TARGET,
    scanned: rows.length,
    hit30: hit.length,
    best: rows[0],
    top30: hit.slice(0, 20),
    top: rows.slice(0, 30),
  }
  mkdirSync('backtest/out', { recursive: true })
  writeFileSync('backtest/out/daily30.json', JSON.stringify(out, null, 2))
  console.log(
    JSON.stringify(
      {
        scanned: rows.length,
        hit30: hit.length,
        best: rows[0],
        top5: rows.slice(0, 5),
        topHit: hit.slice(0, 5),
      },
      null,
      2,
    ),
  )
}

main()
