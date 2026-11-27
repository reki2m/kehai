/**
 * Context-only assets for USDJPY scalp — never trade these.
 * Show charts only while short-horizon returns look related to USDJPY.
 */
import type { Candle } from './marketData'
import { getPair, type PairId } from './pairs'

/** Watch-only: oil / Nikkei / Dow / VIX. Not trade targets. */
export const CONTEXT_WATCH_IDS: PairId[] = [
  'USOIL',
  'NIKKEI',
  'DOW',
  'VIX',
]

export function isContextOnly(id: PairId): boolean {
  return CONTEXT_WATCH_IDS.includes(id)
}

export function isTradeablePair(id: PairId): boolean {
  const p = getPair(id)
  return p.kind === 'fx' && !isContextOnly(id)
}

export interface ContextLink {
  id: PairId
  label: string
  /** Pearson corr of aligned 1m returns (−1…+1). */
  corr: number
  /** Absolute corr used for gates. */
  absCorr: number
  /** True while chart should be visible. */
  active: boolean
  /** Driver % change over the corr window. */
  changePct: number
  /** USDJPY pips over the same window. */
  usdjpyPips: number
  reason: string
  sample: number
}

export interface ContextWatchState {
  links: ContextLink[]
  /** Currently related (active) ids. */
  activeIds: PairId[]
  at: number
}

const ENTER_CORR = 0.48
const HOLD_CORR = 0.28
const MIN_SAMPLES = 24
/** Ignore dead markets — need some USDJPY travel. */
const MIN_USDJPY_PIPS = 6
/** Or driver must have moved. */
const MIN_DRIVER_PCT = 0.12

function returnsFromCloses(closes: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1]!
    const b = closes[i]!
    if (!(a > 0) || !(b > 0)) continue
    out.push((b - a) / a)
  }
  return out
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length)
  if (n < MIN_SAMPLES) return null
  let sx = 0
  let sy = 0
  for (let i = 0; i < n; i++) {
    sx += xs[i]!
    sy += ys[i]!
  }
  const mx = sx / n
  const my = sy / n
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    const ax = xs[i]! - mx
    const ay = ys[i]! - my
    num += ax * ay
    dx += ax * ax
    dy += ay * ay
  }
  if (dx <= 0 || dy <= 0) return null
  return num / Math.sqrt(dx * dy)
}

/** Align two series by unix minute, take last `bars` overlapping closes. */
export function alignCloses(
  a: Candle[],
  b: Candle[],
  bars = 60,
): { a: number[]; b: number[]; times: number[] } {
  const mapB = new Map(b.map((c) => [c.time, c.close]))
  const times: number[] = []
  const ca: number[] = []
  const cb: number[] = []
  for (let i = a.length - 1; i >= 0 && times.length < bars; i--) {
    const c = a[i]!
    const v = mapB.get(c.time)
    if (v == null || !Number.isFinite(v) || !Number.isFinite(c.close)) continue
    times.push(c.time)
    ca.push(c.close)
    cb.push(v)
  }
  times.reverse()
  ca.reverse()
  cb.reverse()
  return { a: ca, b: cb, times }
}

function pctSpan(closes: number[]): number {
  if (closes.length < 2) return 0
  const first = closes[0]!
  const last = closes[closes.length - 1]!
  if (!(first > 0)) return 0
  return ((last - first) / first) * 100
}

function pipSpan(closes: number[], pip: number): number {
  if (closes.length < 2 || !(pip > 0)) return 0
  return Math.abs(closes[closes.length - 1]! - closes[0]!) / pip
}

/**
 * Decide whether a context asset should show charts next to USDJPY.
 * Uses hysteresis so charts don't flicker on/off every poll.
 */
export function evaluateContextLink(
  usdjpy: Candle[],
  driver: Candle[],
  id: PairId,
  wasActive: boolean,
  windowBars = 55,
): ContextLink {
  const label = getPair(id).label
  const empty: ContextLink = {
    id,
    label,
    corr: 0,
    absCorr: 0,
    active: false,
    changePct: 0,
    usdjpyPips: 0,
    reason: 'データ不足',
    sample: 0,
  }
  if (usdjpy.length < 40 || driver.length < 40) return empty

  const aligned = alignCloses(usdjpy, driver, windowBars)
  if (aligned.a.length < MIN_SAMPLES + 1) return empty

  const ra = returnsFromCloses(aligned.a)
  const rb = returnsFromCloses(aligned.b)
  const corr = pearson(ra, rb)
  if (corr == null) return { ...empty, reason: '相関計算不可', sample: ra.length }

  const absCorr = Math.abs(corr)
  const changePct = pctSpan(aligned.b)
  const usdjpyPips = pipSpan(aligned.a, getPair('USDJPY').pip)
  const moved =
    usdjpyPips >= MIN_USDJPY_PIPS || Math.abs(changePct) >= MIN_DRIVER_PCT

  let active = wasActive
  let reason: string
  if (!moved) {
    active = false
    reason = '値動きが薄い（監視のみ）'
  } else if (!wasActive && absCorr >= ENTER_CORR) {
    active = true
    reason =
      corr >= 0
        ? `同方向相関 ${corr.toFixed(2)}`
        : `逆方向相関 ${corr.toFixed(2)}（関連）`
  } else if (wasActive && absCorr >= HOLD_CORR) {
    active = true
    reason =
      corr >= 0
        ? `同方向維持 ${corr.toFixed(2)}`
        : `逆方向維持 ${corr.toFixed(2)}`
  } else if (wasActive && absCorr < HOLD_CORR) {
    active = false
    reason = `関連終了 · 相関 ${corr.toFixed(2)}`
  } else {
    active = false
    reason = `関連弱 · 相関 ${corr.toFixed(2)}`
  }

  return {
    id,
    label,
    corr: Math.round(corr * 100) / 100,
    absCorr: Math.round(absCorr * 100) / 100,
    active,
    changePct: Math.round(changePct * 100) / 100,
    usdjpyPips: Math.round(usdjpyPips * 10) / 10,
    reason,
    sample: ra.length,
  }
}

export function evaluateContextWatch(
  usdjpy: Candle[],
  series: Partial<Record<PairId, Candle[]>>,
  prevActive: ReadonlySet<PairId> = new Set(),
): ContextWatchState {
  const links = CONTEXT_WATCH_IDS.map((id) =>
    evaluateContextLink(
      usdjpy,
      series[id] ?? [],
      id,
      prevActive.has(id),
    ),
  )
  return {
    links,
    activeIds: links.filter((l) => l.active).map((l) => l.id),
    at: Math.floor(Date.now() / 1000),
  }
}
