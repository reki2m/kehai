import type { Candle } from './marketData'
import { getPair, type PairId } from './pairs'

/** Drivers we added specifically to judge USD/JPY pressure. */
export const IMPACT_DRIVERS: PairId[] = ['EURUSD', 'USOIL', 'NIKKEI', 'DOW', 'VIX']

/**
 * Sign convention: positive beta = driver ↑ → USDJPY ↑.
 * Weights reflect typical short-horizon influence on USDJPY scalp context.
 */
export const USDJPY_BETA: Record<
  PairId,
  { beta: number; weight: number; why: string }
> = {
  USDJPY: { beta: 1, weight: 0, why: '' },
  EURUSD: {
    beta: -1,
    weight: 0.9,
    why: 'ユーロドル上昇＝ドル安圧力 → ドル円↓',
  },
  GBPJPY: { beta: 0, weight: 0, why: '' },
  EURJPY: { beta: 0, weight: 0, why: '' },
  AUDUSD: { beta: 0, weight: 0, why: '' },
  USDCHF: { beta: 0, weight: 0, why: '' },
  GBPUSD: { beta: 0, weight: 0, why: '' },
  NZDUSD: { beta: 0, weight: 0, why: '' },
  CADJPY: { beta: 0, weight: 0, why: '' },
  EURGBP: { beta: 0, weight: 0, why: '' },
  USOIL: {
    beta: 0.45,
    weight: 0.55,
    why: '原油高はリスクオン寄り → 円売り圧力でドル円↑（弱め）',
  },
  NIKKEI: {
    beta: 0.7,
    weight: 0.85,
    why: '日経高＝リスクオン／国内株連動 → ドル円↑寄り',
  },
  DOW: {
    beta: 0.75,
    weight: 0.9,
    why: 'ダウ高＝リスクオン → 円売りでドル円↑',
  },
  VIX: {
    beta: -1,
    weight: 1,
    why: 'VIX上昇＝リスクオフ → 円買い・ドル円↓',
  },
}

export type ImpactBias = 'usd_bull' | 'usd_bear' | 'neutral'

export interface DriverImpact {
  id: PairId
  label: string
  changePct: number
  beta: number
  weight: number
  /** Contribution to USDJPY (− = bearish USDJPY). */
  score: number
  why: string
  last: number | null
}

export interface UsdJpyImpact {
  drivers: DriverImpact[]
  /** Aggregated −100…+100 (+: USDJPY押し上げ). */
  score: number
  bias: ImpactBias
  label: string
  summary: string
  /** Soft gate: true if environment doesn't strongly fight a given action. */
  supportsLong: boolean
  supportsShort: boolean
}

function pctChange(candles: Candle[], lookback: number): number | null {
  if (candles.length < lookback + 1) return null
  const a = candles[candles.length - 1 - lookback]?.close
  const b = candles[candles.length - 1]?.close
  if (a == null || b == null || a === 0) return null
  return ((b - a) / a) * 100
}

function lastClose(candles: Candle[]): number | null {
  return candles.length ? candles[candles.length - 1].close : null
}

/** Map raw % move into a capped influence unit (−1…+1). */
function normalizeMove(changePct: number, scalePct: number): number {
  const z = changePct / scalePct
  return Math.max(-1, Math.min(1, z))
}

const SCALE: Partial<Record<PairId, number>> = {
  EURUSD: 0.12,
  USOIL: 0.8,
  NIKKEI: 0.6,
  DOW: 0.5,
  VIX: 4,
}

/**
 * Evaluate how related markets currently push USD/JPY.
 * @param series map of driver → recent candles (prefer 5m)
 * @param lookback bars for % change (default 12 ≈ 1h on 5m)
 */
export function evaluateUsdJpyImpact(
  series: Partial<Record<PairId, Candle[]>>,
  lookback = 12,
): UsdJpyImpact {
  const drivers: DriverImpact[] = []
  let weighted = 0
  let wSum = 0

  for (const id of IMPACT_DRIVERS) {
    const meta = USDJPY_BETA[id]
    const candles = series[id] ?? []
    const chg = pctChange(candles, lookback)
    const scale = SCALE[id] ?? 0.5
    const unit = chg == null ? 0 : normalizeMove(chg, scale)
    const score = meta.beta * unit * meta.weight * 100
    if (chg != null) {
      weighted += score
      wSum += meta.weight
    }
    drivers.push({
      id,
      label: getPair(id).label,
      changePct: chg ?? 0,
      beta: meta.beta,
      weight: meta.weight,
      score: Math.round(score),
      why: meta.why,
      last: lastClose(candles),
    })
  }

  const raw = wSum > 0 ? weighted / wSum : 0
  const score = Math.max(-100, Math.min(100, Math.round(raw)))
  const bias: ImpactBias =
    score >= 18 ? 'usd_bull' : score <= -18 ? 'usd_bear' : 'neutral'

  const top = [...drivers].sort((a, b) => Math.abs(b.score) - Math.abs(a.score))[0]
  let label = 'クロスアセット中立'
  if (bias === 'usd_bull') label = 'ドル円押し上げ環境'
  if (bias === 'usd_bear') label = 'ドル円押し下げ環境'

  const summary =
    top && Math.abs(top.score) >= 8
      ? `主因: ${top.label}（${top.changePct >= 0 ? '+' : ''}${top.changePct.toFixed(2)}% → 寄与 ${top.score > 0 ? '+' : ''}${top.score}）`
      : '関連市場の短期寄与は小さい'

  return {
    drivers,
    score,
    bias,
    label,
    summary,
    supportsLong: score >= -25,
    supportsShort: score <= 25,
  }
}

/** Adjust Apex action when USDJPY cross-asset strongly opposes. */
export function applyImpactGate<
  T extends { action: 'LONG' | 'SHORT' | 'WAIT'; score: number; label: string },
>(edge: T, impact: UsdJpyImpact): T {
  if (edge.action === 'LONG' && !impact.supportsLong) {
    return {
      ...edge,
      action: 'WAIT' as const,
      score: Math.round(edge.score * 0.4),
      label: `クロスアセット逆風 · ${impact.label}`,
    }
  }
  if (edge.action === 'SHORT' && !impact.supportsShort) {
    return {
      ...edge,
      action: 'WAIT' as const,
      score: Math.round(edge.score * 0.4),
      label: `クロスアセット逆風 · ${impact.label}`,
    }
  }
  if (edge.action === 'LONG' && impact.bias === 'usd_bull') {
    return {
      ...edge,
      score: Math.max(-100, Math.min(100, edge.score + 10)),
      label: `${edge.label} · 関連市場順風`,
    }
  }
  if (edge.action === 'SHORT' && impact.bias === 'usd_bear') {
    return {
      ...edge,
      score: Math.max(-100, Math.min(100, edge.score - 10)),
      label: `${edge.label} · 関連市場順風`,
    }
  }
  return edge
}
