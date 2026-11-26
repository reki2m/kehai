/**
 * Beat Peak Edge daily edge (~3.07p/day) at ~8–12 fills/day.
 * Tests: entry stacks × exits × concurrent slots (1–3).
 * Precomputes indicators once.
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
const PEAK_NET = 104
const PEAK_EV = 1.92

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

type ExitCfg = {
  id: string
  slAtr: number
  slMin: number
  slMax: number
  rr: number
  hold: number
  beR: number
  trailAtr: number
}

type Pos = {
  dir: 1 | -1
  entry: number
  stop: number
  tp: number
  ei: number
  be: boolean
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

  const days = new Set<string>()
  for (const c of candles) if (isFxWeekday(c.time)) days.add(jstDay(c.time))
  const nd = Math.max(1, days.size)

  function gate(
    t: number,
    side: 'BUY' | 'SELL',
    ax: { plusDi: number; minusDi: number },
    needRsi: boolean,
  ) {
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

  type EntryMode = {
    id: string
    /** Return side + quality tier (2=peak, 1=fill) */
    signal: (
      i: number,
      noon: boolean,
      ax: { adx: number; plusDi: number; minusDi: number },
    ) => { side: 'BUY' | 'SELL'; tier: 2 | 1 } | null
  }

  const modes: EntryMode[] = [
    {
      id: 'peak18+st15',
      signal(i, noon, ax) {
        const t = candles[i]!.time
        if (ax.adx >= (noon ? 18 : 22)) {
          const fx = detectFxSession(t)
          const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
          const flip = utFlips
            .get(`${profile.utKey}/${profile.utAtr}`)!
            .get(t)
          if (flip && gate(t, flip, ax, true)) return { side: flip, tier: 2 }
        }
        if (ax.adx >= (noon ? 15 : 19)) {
          const flip = stFlip.get(t)
          if (flip && gate(t, flip, ax, false)) return { side: flip, tier: 1 }
        }
        return null
      },
    },
    {
      id: 'peak18+st16rsi',
      signal(i, noon, ax) {
        const t = candles[i]!.time
        if (ax.adx >= (noon ? 18 : 22)) {
          const fx = detectFxSession(t)
          const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
          const flip = utFlips
            .get(`${profile.utKey}/${profile.utAtr}`)!
            .get(t)
          if (flip && gate(t, flip, ax, true)) return { side: flip, tier: 2 }
        }
        if (ax.adx >= (noon ? 16 : 22)) {
          const flip = stFlip.get(t)
          if (flip && gate(t, flip, ax, true)) return { side: flip, tier: 1 }
        }
        return null
      },
    },
    {
      id: 'peak18+st15+ssl16',
      signal(i, noon, ax) {
        const t = candles[i]!.time
        if (ax.adx >= (noon ? 18 : 22)) {
          const fx = detectFxSession(t)
          const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
          const flip = utFlips
            .get(`${profile.utKey}/${profile.utAtr}`)!
            .get(t)
          if (flip && gate(t, flip, ax, true)) return { side: flip, tier: 2 }
        }
        if (ax.adx >= (noon ? 15 : 19)) {
          const flip = stFlip.get(t)
          if (flip && gate(t, flip, ax, false)) return { side: flip, tier: 1 }
        }
        if (ax.adx >= (noon ? 16 : 20)) {
          const flip = sslFlip.get(t)
          if (flip && gate(t, flip, ax, true)) return { side: flip, tier: 1 }
        }
        return null
      },
    },
    {
      id: 'peak16+st14',
      signal(i, noon, ax) {
        const t = candles[i]!.time
        if (ax.adx >= (noon ? 16 : 20)) {
          const fx = detectFxSession(t)
          const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
          const flip = utFlips
            .get(`${profile.utKey}/${profile.utAtr}`)!
            .get(t)
          if (flip && gate(t, flip, ax, true)) return { side: flip, tier: 2 }
        }
        if (ax.adx >= (noon ? 14 : 18)) {
          const flip = stFlip.get(t)
          if (flip && gate(t, flip, ax, false)) return { side: flip, tier: 1 }
        }
        return null
      },
    },
  ]

  const exits: ExitCfg[] = []
  for (const slAtr of [0.9, 1.0, 1.2]) {
    for (const rr of [1.4, 1.6, 1.8, 2.0]) {
      for (const hold of [20, 30, 45]) {
        for (const beR of [0, 1.0]) {
          for (const trailAtr of [0, 1.0]) {
            exits.push({
              id: `a${slAtr}_r${rr}_h${hold}_b${beR}_t${trailAtr}`,
              slAtr,
              slMin: 5,
              slMax: 10,
              rr,
              hold,
              beR,
              trailAtr,
            })
          }
        }
      }
    }
  }

  function run(
    mode: EntryMode,
    ex: ExitCfg,
    cool: number,
    slots: number,
    /** If true, fillers only when no open peak-tier pos? keep simple: any signal */
  ) {
    const pnls: number[] = []
    const open: Pos[] = []
    let last = -9999

    for (let i = 150; i < candles.length - 1; i++) {
      const c = candles[i]!
      const atrPips = (atrM.get(c.time) ?? 0) / PIP

      // manage opens
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
        if (ex.trailAtr > 0 && atrPips > 0) {
          const trail = ex.trailAtr * atrPips * PIP
          if (pos.dir > 0) {
            const cand = c.close - trail
            if (cand > pos.stop) pos.stop = cand
          } else {
            const cand = c.close + trail
            if (cand < pos.stop) pos.stop = cand
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
      const ax = adxM.get(c.time)
      if (!ax) continue
      if (atrPips > 0 && atrPips < 1.2) continue
      const noon = isNoonSignalWindow(c.time)
      const sig = mode.signal(i, noon, ax)
      if (!sig) continue

      const sl =
        Math.round(
          Math.max(ex.slMin, Math.min(ex.slMax, atrPips * ex.slAtr)) * 10,
        ) / 10
      const tpP =
        Math.round(Math.max(sl * ex.rr * 0.85, Math.min(sl * ex.rr * 1.15, sl * ex.rr)) * 10) /
        10
      const next = candles[i + 1]!
      const dir: 1 | -1 = sig.side === 'BUY' ? 1 : -1
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
  let done = 0
  const total = modes.length * exits.length * 2 * 3
  for (const mode of modes) {
    for (const ex of exits) {
      for (const cool of [3, 5]) {
        for (const slots of [1, 2, 3]) {
          const st = run(mode, ex, cool, slots)
          done++
          if (done % 200 === 0) console.log('progress', done, '/', total)
          if (st.tpd < 7.5 || st.tpd > 12.5) continue
          rows.push({
            mode: mode.id,
            exit: ex.id,
            cool,
            slots,
            ...st,
            beatDaily: st.daily > PEAK_DAILY,
            beatNet: st.net > PEAK_NET,
            beatEv: st.ev > PEAK_EV,
          })
        }
      }
    }
  }

  rows.sort((a, b) => b.daily - a.daily || b.net - a.net)
  const beatAll = rows.filter(
    (r) => r.daily > PEAK_DAILY && r.net > PEAK_NET && r.ev > PEAK_EV,
  )
  const beatDailyNet = rows.filter(
    (r) => r.daily > PEAK_DAILY && r.net > PEAK_NET,
  )
  const beatDaily = rows.filter((r) => r.daily > PEAK_DAILY)

  const out = {
    peak: { daily: PEAK_DAILY, net: PEAK_NET, ev: PEAK_EV },
    scannedKeep: rows.length,
    beatAll: beatAll.length,
    beatDailyNet: beatDailyNet.length,
    beatDaily: beatDaily.length,
    best: rows[0],
    topBeatDailyNet: beatDailyNet.slice(0, 15),
    topBeatDaily: beatDaily.slice(0, 15),
    top: rows.slice(0, 20),
  }
  mkdirSync('backtest/out', { recursive: true })
  writeFileSync('backtest/out/ten_slots.json', JSON.stringify(out, null, 2))
  console.log(
    JSON.stringify(
      {
        keep: rows.length,
        beatAll: beatAll.length,
        beatDailyNet: beatDailyNet.length,
        beatDaily: beatDaily.length,
        best: rows[0] && {
          mode: rows[0].mode,
          exit: rows[0].exit,
          slots: rows[0].slots,
          cool: rows[0].cool,
          tpd: rows[0].tpd,
          ev: rows[0].ev,
          net: rows[0].net,
          daily: rows[0].daily,
          wr: rows[0].wr,
        },
        topBeat: beatDailyNet.slice(0, 8).map((r) => ({
          mode: r.mode,
          exit: r.exit,
          slots: r.slots,
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
