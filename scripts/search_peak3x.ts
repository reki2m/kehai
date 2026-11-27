/**
 * Fast Peak 3× hunt — indicators precomputed once.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import {
  adx,
  atr,
  rsi,
  sslDirection,
  utBotTrail,
  wavetrend,
} from '../src/lib/indicators.ts'
import {
  SESSION_PROFILES,
  detectFxSession,
  isFxWeekday,
  isNoonSignalWindow,
  sessionAwayFromEdge,
} from '../src/lib/apex.ts'
import { newsBlackout, estimateSpreadPips } from '../src/lib/filters.ts'
import type { Candle } from '../src/lib/marketData.ts'

const PIP = 0.01

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

type Cfg = {
  name: string
  adxMin: number
  adxPrime: number
  cool: number
  htf: boolean
  di: boolean
  wt: boolean
  rsi: boolean
  sl: number
  tp: number
  hold: number
}

type Ctx = {
  candles: Candle[]
  atrM: Map<number, number>
  adxM: Map<number, { adx: number; plusDi: number; minusDi: number }>
  rsiM: Map<number, number>
  ssl10M: Map<number, number>
  ssl50M: Map<number, number>
  ssl30M: Map<number, number>
  wt1M: Map<number, number>
  wt2M: Map<number, number>
  flips: Map<string, Map<number, 1 | -1>>
  nDays: number
}

function buildCtx(candles: Candle[]): Ctx {
  const atrM = new Map(atr(candles, 14).map((x) => [x.time, x.value]))
  const adxM = new Map(adx(candles, 14).map((x) => [x.time, x]))
  const rsiM = new Map(rsi(candles, 14).map((x) => [x.time, x.value]))
  const ssl10M = new Map(sslDirection(candles, 10).map((x) => [x.time, x.value]))
  const ssl50M = new Map(sslDirection(candles, 50).map((x) => [x.time, x.value]))
  const ssl30M = new Map(sslDirection(candles, 30).map((x) => [x.time, x.value]))
  const { wt1, wt2 } = wavetrend(candles, 10, 21)
  const wt1M = new Map(wt1.map((x) => [x.time, x.value]))
  const wt2M = new Map(wt2.map((x) => [x.time, x.value]))
  const flips = new Map<string, Map<number, 1 | -1>>()
  for (const id of ['tokyo', 'london', 'ny'] as const) {
    const p = SESSION_PROFILES[id]
    const { direction } = utBotTrail(candles, p.utKey, p.utAtr)
    const dirM = new Map(direction.map((x) => [x.time, x.value]))
    const flip = new Map<number, 1 | -1>()
    for (let i = 1; i < candles.length; i++) {
      const a = dirM.get(candles[i - 1]!.time)
      const b = dirM.get(candles[i]!.time)
      if (a == null || b == null) continue
      if (b > 0 && a <= 0) flip.set(candles[i]!.time, 1)
      if (b < 0 && a >= 0) flip.set(candles[i]!.time, -1)
    }
    flips.set(id, flip)
  }
  const days = new Set<string>()
  for (const c of candles) if (isFxWeekday(c.time)) days.add(jstDay(c.time))
  return {
    candles,
    atrM,
    adxM,
    rsiM,
    ssl10M,
    ssl50M,
    ssl30M,
    wt1M,
    wt2M,
    flips,
    nDays: Math.max(1, days.size),
  }
}

function simulate(ctx: Ctx, cfg: Cfg, htfLen: 30 | 50 = 50) {
  const { candles } = ctx
  const sslHM = htfLen === 30 ? ctx.ssl30M : ctx.ssl50M
  type Pos = {
    dir: 1 | -1
    entry: number
    stop: number
    tp: number
    ei: number
  }
  let pos: Pos | null = null
  let lastSig = -9999
  const pnls: number[] = []

  for (let i = 120; i < candles.length - 1; i++) {
    const c = candles[i]!
    const t = c.time

    if (pos) {
      const hitSl = pos.dir > 0 ? c.low <= pos.stop : c.high >= pos.stop
      const hitTp = pos.dir > 0 ? c.high >= pos.tp : c.low <= pos.tp
      const expired = i - pos.ei >= cfg.hold
      if (hitSl || hitTp || expired) {
        let exit = c.close
        if (hitSl) exit = pos.stop
        else if (hitTp) exit = pos.tp
        const raw =
          pos.dir > 0 ? (exit - pos.entry) / PIP : (pos.entry - exit) / PIP
        pnls.push(Math.round((raw - 0.2) * 10) / 10)
        pos = null
      }
    }

    if (pos) continue
    if (i - lastSig < cfg.cool) continue
    if (!isFxWeekday(t)) continue
    if (newsBlackout(t)) continue

    const sess = detectFxSession(t) ?? 'tokyo'
    const profile = SESSION_PROFILES[sess]
    const noonOk = isNoonSignalWindow(t)
    const adxFloor = noonOk ? cfg.adxMin : cfg.adxPrime
    if (!sessionAwayFromEdge(t, 0, sess)) continue

    const atrPips = (ctx.atrM.get(t) ?? 0) / PIP
    if (atrPips > 0 && atrPips < 1.2) continue
    const spread = estimateSpreadPips(t, atrPips || undefined)
    if (spread > (profile.maxSpread ?? 0.45)) continue

    const a = ctx.adxM.get(t)
    if (!a || a.adx < adxFloor) continue

    const flip = ctx.flips.get(sess)!.get(t)
    if (!flip) continue

    const ssl = ctx.ssl10M.get(t) ?? 0
    if (flip > 0 && ssl <= 0) continue
    if (flip < 0 && ssl >= 0) continue

    if (cfg.htf) {
      const h = sslHM.get(t) ?? 0
      if (flip > 0 && h <= 0) continue
      if (flip < 0 && h >= 0) continue
    }
    if (cfg.di) {
      if (flip > 0 && !(a.plusDi > a.minusDi)) continue
      if (flip < 0 && !(a.minusDi > a.plusDi)) continue
    }
    if (cfg.wt) {
      const w1 = ctx.wt1M.get(t)
      const w2 = ctx.wt2M.get(t)
      if (w1 == null || w2 == null) continue
      if (flip > 0 && !(w1 > w2)) continue
      if (flip < 0 && !(w1 < w2)) continue
    }
    if (cfg.rsi) {
      const r = ctx.rsiM.get(t)
      if (r == null) continue
      if (flip > 0 && (r < 40 || r > 65)) continue
      if (flip < 0 && (r < 35 || r > 60)) continue
    }

    const entry = c.close
    const stop = flip > 0 ? entry - cfg.sl * PIP : entry + cfg.sl * PIP
    const tp = flip > 0 ? entry + cfg.tp * PIP : entry - cfg.tp * PIP
    pos = { dir: flip, entry, stop, tp, ei: i }
    lastSig = i
  }

  const net = pnls.reduce((s, x) => s + x, 0)
  const n = pnls.length
  const wins = pnls.filter((x) => x > 0).length
  return {
    n,
    tpd: Math.round((n / ctx.nDays) * 100) / 100,
    wr: n ? Math.round((wins / n) * 1000) / 10 : 0,
    ev: n ? Math.round((net / n) * 100) / 100 : 0,
    net: Math.round(net * 10) / 10,
    daily: Math.round((net / ctx.nDays) * 100) / 100,
  }
}

const candles = loadMerge([
  'backtest/data/usdjpy_m1_dukascopy_2026aug.json',
  'backtest/data/usdjpy_m1_dukascopy_2026sep.json',
  'backtest/data/usdjpy_m1_dukascopy_2026oct.json',
])
console.log('bars', candles.length)
const ctx = buildCtx(candles)
console.log('ctx ready', ctx.nDays)

const base = simulate(ctx, {
  name: 'BASE',
  adxMin: 24,
  adxPrime: 28,
  cool: 5,
  htf: true,
  di: true,
  wt: true,
  rsi: true,
  sl: 10,
  tp: 20,
  hold: 60,
})
console.log('BASE', base)

const cfgs: Cfg[] = []
for (const adxMin of [18, 20, 22, 24]) {
  for (const cool of [1, 2, 3]) {
    for (const htf of [true, false]) {
      for (const di of [true]) {
        for (const wt of [true, false]) {
          for (const rsiOn of [true, false]) {
            for (const [sl, tp] of [
              [10, 20],
              [8, 16],
            ] as const) {
              cfgs.push({
                name: `a${adxMin}_c${cool}_h${htf ? 1 : 0}_w${wt ? 1 : 0}_r${rsiOn ? 1 : 0}_sl${sl}`,
                adxMin,
                adxPrime: Math.max(adxMin + 4, 24),
                cool,
                htf,
                di,
                wt,
                rsi: rsiOn,
                sl,
                tp,
                hold: 60,
              })
            }
          }
        }
      }
    }
  }
}

const rows = cfgs.map((cfg) => {
  const s = simulate(ctx, cfg)
  const tpdScore =
    s.tpd >= 4 && s.tpd <= 7 ? 30 : s.tpd >= 3.5 ? 15 : s.tpd >= 3 ? 5 : 0
  const score = s.ev > 0 ? s.daily * 15 + s.ev * 10 + tpdScore : -999
  return { cfg, s, score }
})
rows.sort((a, b) => b.score - a.score)

console.log('top')
for (const row of rows.slice(0, 15)) {
  console.log({
    name: row.cfg.name,
    tpd: row.s.tpd,
    ev: row.s.ev,
    daily: row.s.daily,
    wr: row.s.wr,
    n: row.s.n,
  })
}
const hit = rows.filter((r) => r.s.ev > 0 && r.s.tpd >= 4)
console.log('≥4tpd+EV', hit.length, hit[0]?.cfg.name, hit[0]?.s)

mkdirSync('backtest/out', { recursive: true })
writeFileSync(
  'backtest/out/peak3x.json',
  JSON.stringify({ base, top: rows.slice(0, 20), hit3x: hit.slice(0, 10) }, null, 2),
)
