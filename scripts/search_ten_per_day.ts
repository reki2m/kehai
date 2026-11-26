/**
 * Search ~10 trades/day Peak-family variants with ATR-hybrid risk.
 * Uses the same indicator implementations as production.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import {
  adx,
  atr,
  ema,
  rsi,
  sessionVwap,
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
import { newsBlackout, estimateSpreadPips } from '../src/lib/filters.ts'
import { atrRiskPips, SIMPLE } from '../src/lib/simpleSignal.ts'
import type { Candle } from '../src/lib/marketData.ts'
import { PAIRS } from '../src/lib/pairs.ts'

const PIP = 0.01
const SPREAD = 0.2
const pair = PAIRS.find((p) => p.id === 'USDJPY')!

type Hard = {
  htf?: boolean
  st?: boolean
  di?: boolean
  wt?: boolean
  rsi?: boolean
  ema?: boolean
  vwap?: boolean
}

type Cfg = {
  name: string
  adxNoon: number
  adxOff: number
  minConfirms: number // of optional confirms beyond UT+SSL
  cooldown: number
  hard: Hard
  pullbackBars: number // 0 = flip bar only; >0 allow entry within N bars after flip
  rsiLong: [number, number]
  rsiShort: [number, number]
  minAtr: number
}

function load(path: string): Candle[] {
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  const arr = Array.isArray(raw) ? raw : raw.candles || []
  return arr.map((c: any) => ({
    time: c.time,
    open: +c.open,
    high: +c.high,
    low: +c.low,
    close: +c.close,
    volume: +(c.volume ?? 0) || 0,
  }))
}

function mergeFiles(files: string[]): Candle[] {
  const by = new Map<number, Candle>()
  for (const f of files) {
    if (!existsSync(f)) continue
    for (const c of load(f)) by.set(c.time, c)
    console.log('loaded', f, load(f).length)
  }
  return [...by.values()].sort((a, b) => a.time - b.time)
}

function jstDay(t: number) {
  return new Date(t * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
}

function buildMaps(candles: Candle[]) {
  const profiles = [
    SESSION_PROFILES.tokyo,
    SESSION_PROFILES.london,
    SESSION_PROFILES.ny,
  ] as const
  const ut = new Map<string, Map<number, number>>()
  const trail = new Map<string, Map<number, number>>()
  const ssl = new Map<number, Map<number, number>>()
  for (const p of profiles) {
    const key = `${p.utKey}/${p.utAtr}`
    if (!ut.has(key)) {
      const { direction, trail: tr } = utBotTrail(candles, p.utKey, p.utAtr)
      ut.set(key, new Map(direction.map((d) => [d.time, d.value])))
      trail.set(key, new Map(tr.map((d) => [d.time, d.value])))
    }
    if (!ssl.has(p.sslLen)) {
      ssl.set(
        p.sslLen,
        new Map(sslDirection(candles, p.sslLen).map((d) => [d.time, d.value])),
      )
    }
  }
  ssl.set(
    SIMPLE.htfSslLen,
    new Map(
      sslDirection(candles, SIMPLE.htfSslLen).map((d) => [d.time, d.value]),
    ),
  )
  const { wt1, wt2 } = wavetrend(candles, 10, 21)
  return {
    ut,
    trail,
    ssl,
    htf: ssl.get(SIMPLE.htfSslLen)!,
    st: new Map(
      supertrendDirection(candles, SIMPLE.stPeriod, SIMPLE.stMult).map((d) => [
        d.time,
        d.value,
      ]),
    ),
    adx: new Map(adx(candles, 14).map((d) => [d.time, d])),
    atr: new Map(atr(candles, 14).map((d) => [d.time, d.value])),
    rsi: new Map(rsi(candles, 14).map((d) => [d.time, d.value])),
    vwap: new Map(sessionVwap(candles).map((d) => [d.time, d.value])),
    ema21: new Map(ema(candles, 21).map((d) => [d.time, d.value])),
    ema55: new Map(ema(candles, 55).map((d) => [d.time, d.value])),
    wt1: new Map(wt1.map((d) => [d.time, d.value])),
    wt2: new Map(wt2.map((d) => [d.time, d.value])),
  }
}

type Maps = ReturnType<typeof buildMaps>

function confirms(
  maps: Maps,
  candles: Candle[],
  i: number,
  side: 'BUY' | 'SELL',
  cfg: Cfg,
  profile: (typeof SESSION_PROFILES)[keyof typeof SESSION_PROFILES],
) {
  const c = candles[i]
  const sslMap = maps.ssl.get(profile.sslLen)!
  const ssl = sslMap.get(c.time)
  const htf = maps.htf.get(c.time)
  const st = maps.st.get(c.time)
  const adxV = maps.adx.get(c.time)
  const rsiV = maps.rsi.get(c.time)
  const w1 = maps.wt1.get(c.time)
  const w2 = maps.wt2.get(c.time)
  const e21 = maps.ema21.get(c.time)
  const e55 = maps.ema55.get(c.time)
  const vwap = maps.vwap.get(c.time)
  const long = side === 'BUY'

  const checks: { id: string; ok: boolean; hard?: boolean }[] = [
    {
      id: 'ssl',
      ok: ssl != null && (long ? ssl > 0 : ssl < 0),
      hard: true,
    },
    {
      id: 'htf',
      ok: htf != null && (long ? htf > 0 : htf < 0),
      hard: !!cfg.hard.htf,
    },
    {
      id: 'st',
      ok: st != null && (long ? st > 0 : st < 0),
      hard: !!cfg.hard.st,
    },
    {
      id: 'di',
      ok: !!adxV && (long ? adxV.plusDi > adxV.minusDi : adxV.minusDi > adxV.plusDi),
      hard: !!cfg.hard.di,
    },
    {
      id: 'wt',
      ok: w1 != null && w2 != null && (long ? w1 > w2 : w1 < w2),
      hard: !!cfg.hard.wt,
    },
    {
      id: 'rsi',
      ok:
        rsiV != null &&
        (long
          ? rsiV >= cfg.rsiLong[0] && rsiV <= cfg.rsiLong[1]
          : rsiV >= cfg.rsiShort[0] && rsiV <= cfg.rsiShort[1]),
      hard: !!cfg.hard.rsi,
    },
    {
      id: 'ema',
      ok:
        !cfg.hard.ema ||
        (e21 != null && e55 != null && (long ? e21 > e55 : e21 < e55)),
      hard: !!cfg.hard.ema,
    },
    {
      id: 'vwap',
      ok:
        !cfg.hard.vwap ||
        (vwap != null && (long ? c.close >= vwap : c.close <= vwap)),
      hard: !!cfg.hard.vwap,
    },
  ]

  for (const ch of checks) {
    if (ch.hard && !ch.ok) return { ok: false, n: 0 }
  }
  const optional = checks.filter((ch) => ch.id !== 'ssl')
  const n = optional.filter((ch) => ch.ok).length
  if (n < cfg.minConfirms) return { ok: false, n }
  return { ok: true, n }
}

function flipAt(
  maps: Maps,
  candles: Candle[],
  i: number,
  profile: (typeof SESSION_PROFILES)[keyof typeof SESSION_PROFILES],
): 'BUY' | 'SELL' | null {
  if (i < 1) return null
  const key = `${profile.utKey}/${profile.utAtr}`
  const utMap = maps.ut.get(key)!
  const ut = utMap.get(candles[i].time)
  const utPrev = utMap.get(candles[i - 1].time)
  if (ut == null || utPrev == null) return null
  if (ut > 0 && utPrev <= 0) return 'BUY'
  if (ut < 0 && utPrev >= 0) return 'SELL'
  return null
}

/** Recent flip within pullbackBars that still matches direction. */
function recentFlip(
  maps: Maps,
  candles: Candle[],
  i: number,
  profile: (typeof SESSION_PROFILES)[keyof typeof SESSION_PROFILES],
  pullbackBars: number,
): 'BUY' | 'SELL' | null {
  const now = flipAt(maps, candles, i, profile)
  if (now) return now
  if (pullbackBars <= 0) return null
  const key = `${profile.utKey}/${profile.utAtr}`
  const utMap = maps.ut.get(key)!
  const utNow = utMap.get(candles[i].time)
  if (utNow == null) return null
  for (let k = 1; k <= pullbackBars && i - k >= 1; k++) {
    const f = flipAt(maps, candles, i - k, profile)
    if (!f) continue
    // still same UT direction
    if (f === 'BUY' && utNow > 0) return 'BUY'
    if (f === 'SELL' && utNow < 0) return 'SELL'
  }
  return null
}

function simulate(candles: Candle[], maps: Maps, cfg: Cfg, slip = 0) {
  const trades: { pnl: number; t: number; side: string }[] = []
  let pos: 0 | 1 | -1 = 0
  let entry = 0
  let stop = 0
  let tp = 0
  let ei = 0
  let lastSig = -9999

  for (let i = 120; i < candles.length - 1; i++) {
    const c = candles[i]
    if (pos !== 0) {
      const hitSl = pos > 0 ? c.low <= stop : c.high >= stop
      const hitTp = pos > 0 ? c.high >= tp : c.low <= tp
      const timed = i - ei >= SIMPLE.maxHoldBars
      const gap = c.time - candles[i - 1].time > 120
      let reason: string | null = null
      let exitPx = 0
      if (gap) {
        reason = 'TIME'
        exitPx = c.close
      } else if (hitSl) {
        reason = 'SL'
        exitPx = stop
      } else if (hitTp) {
        reason = 'TP'
        exitPx = tp
      } else if (timed) {
        reason = 'TIME'
        exitPx = c.close
      }
      if (reason) {
        exitPx = pos > 0 ? exitPx - slip * PIP : exitPx + slip * PIP
        const pnl = ((exitPx - entry) * pos) / PIP - SPREAD
        trades.push({ pnl, t: c.time, side: pos > 0 ? 'BUY' : 'SELL' })
        pos = 0
      }
      continue
    }

    if (!isFxWeekday(c.time)) continue
    if (newsBlackout(c.time)) continue
    if (i - lastSig < cfg.cooldown) continue

    const noon = isNoonSignalWindow(c.time)
    const fx = detectFxSession(c.time)
    const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
    const atrVal = maps.atr.get(c.time) ?? 0
    const atrPips = atrVal > 0 ? atrVal / PIP : 0
    if (atrPips > 0 && atrPips < cfg.minAtr) continue
    const adxV = maps.adx.get(c.time)
    const adxFloor = noon ? cfg.adxNoon : cfg.adxOff
    if (!adxV || adxV.adx < adxFloor) continue

    const side = recentFlip(maps, candles, i, profile, cfg.pullbackBars)
    if (!side) continue

    // session soft gates from profile when hard flags set
    const hard: Hard = { ...cfg.hard }
    if (profile.requireEma) hard.ema = true
    if (profile.requireVwap) hard.vwap = true
    const cfg2 = { ...cfg, hard }

    const conf = confirms(maps, candles, i, side, cfg2, profile)
    if (!conf.ok) continue

    const { sl, tp: tpP } = atrRiskPips(atrPips)
    const next = candles[i + 1]
    if (side === 'BUY') {
      entry = next.open + SPREAD * PIP * 0.5 + slip * PIP
      stop = entry - sl * PIP
      tp = entry + tpP * PIP
      pos = 1
    } else {
      entry = next.open - SPREAD * PIP * 0.5 - slip * PIP
      stop = entry + sl * PIP
      tp = entry - tpP * PIP
      pos = -1
    }
    ei = i + 1
    lastSig = i
  }
  return trades
}

function stats(trades: { pnl: number; t: number }[], candles: Candle[]) {
  const days = new Set<string>()
  for (const c of candles) {
    if (!isFxWeekday(c.time)) continue
    days.add(jstDay(c.time))
  }
  const nd = Math.max(1, days.size)
  if (!trades.length) {
    return { n: 0, wr: 0, ev: 0, net: 0, tpd: 0, days: nd }
  }
  const wins = trades.filter((t) => t.pnl > 0).length / trades.length
  const net = trades.reduce((s, t) => s + t.pnl, 0)
  return {
    n: trades.length,
    wr: Math.round(wins * 1000) / 10,
    ev: Math.round((net / trades.length) * 1000) / 1000,
    net: Math.round(net * 10) / 10,
    tpd: Math.round((trades.length / nd) * 100) / 100,
    days: nd,
  }
}

function configs(): Cfg[] {
  const out: Cfg[] = []
  // Peak-like baseline
  out.push({
    name: 'peak_full',
    adxNoon: 18,
    adxOff: 22,
    minConfirms: 5,
    cooldown: 1,
    hard: { htf: true, st: true, di: true, wt: true, rsi: true },
    pullbackBars: 0,
    rsiLong: [40, 65],
    rsiShort: [35, 60],
    minAtr: 1.2,
  })

  const hardOpts: Hard[] = [
    { di: true, st: true },
    { di: true, htf: true },
    { st: true, htf: true },
    { di: true, rsi: true },
    { di: true, wt: true },
    { di: true, st: true, rsi: true },
    { di: true, st: true, htf: true },
    { di: true, htf: true, rsi: true },
  ]
  for (const pb of [0, 3, 5, 8]) {
    for (const cool of [6, 10, 15]) {
      for (const minC of [2, 3, 4]) {
        for (const hard of hardOpts) {
          const tag = Object.entries(hard)
            .filter(([, v]) => v)
            .map(([k]) => k.slice(0, 2))
            .join('')
          out.push({
            name: `pb${pb}_cd${cool}_mc${minC}_${tag}`,
            adxNoon: 16,
            adxOff: 20,
            minConfirms: minC,
            cooldown: cool,
            hard,
            pullbackBars: pb,
            rsiLong: [38, 68],
            rsiShort: [32, 62],
            minAtr: 1.0,
          })
        }
      }
    }
  }
  return out
}

function main() {
  const candles = mergeFiles([
    'backtest/data/usdjpy_m1_dukascopy_2026aug.json',
    'backtest/data/usdjpy_m1_dukascopy_2026sep.json',
    'backtest/data/usdjpy_m1_dukascopy_2026oct.json',
  ])
  console.log('bars', candles.length)
  console.log('building maps...')
  const maps = buildMaps(candles)
  const rows: any[] = []
  const cfgs = configs()
  console.log('variants', cfgs.length)

  for (const cfg of cfgs) {
    const tr0 = simulate(candles, maps, cfg, 0)
    const st0 = stats(tr0, candles)
    const tr3 = simulate(candles, maps, cfg, 0.3)
    const st3 = stats(tr3, candles)
    const row = {
      name: cfg.name,
      ...cfg,
      ...st0,
      ev_slip03: st3.ev,
      wr_slip03: st3.wr,
      net_slip03: st3.net,
    }
    rows.push(row)
    if (cfg.name === 'peak_full' || (st0.tpd >= 7 && st0.tpd <= 13)) {
      console.log(
        `${cfg.name.padEnd(36)} tpd=${st0.tpd.toFixed(2)} n=${st0.n} wr=${st0.wr}% ev=${st0.ev} net=${st0.net} ev@.3=${st3.ev}`,
      )
    }
  }

  const band = rows.filter((r) => r.tpd >= 8 && r.tpd <= 12)
  const pos = band.filter((r) => r.ev > 0).sort((a, b) => b.ev - a.ev || b.wr - a.wr)
  const pos3 = band
    .filter((r) => r.ev_slip03 > 0)
    .sort((a, b) => b.ev_slip03 - a.ev_slip03)
  const bestEv = [...rows].sort((a, b) => b.ev - a.ev).slice(0, 15)
  const bestNear10 = [...rows]
    .map((r) => ({ ...r, dist: Math.abs(r.tpd - 10) }))
    .filter((r) => r.ev > -0.15)
    .sort((a, b) => a.dist - b.dist || b.ev - a.ev)
    .slice(0, 20)

  const report = {
    sample: 'Dukascopy M1 Aug–Oct 2026',
    spread: SPREAD,
    peak_full: rows.find((r) => r.name === 'peak_full'),
    band_8_12_ev_pos: pos.slice(0, 10),
    band_8_12_ev_slip_pos: pos3.slice(0, 10),
    best_ev_any_freq: bestEv,
    nearest_10_nonterrible: bestNear10,
  }
  mkdirSync('backtest/out', { recursive: true })
  writeFileSync('backtest/out/ten_per_day_search.json', JSON.stringify(report, null, 2))
  console.log('\npeak_full', report.peak_full)
  console.log('band EV>0 count', pos.length)
  console.log('top band', pos.slice(0, 5))
  console.log('nearest10', bestNear10.slice(0, 8))
}

main()
