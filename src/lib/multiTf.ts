import { evaluateApex, type ApexSignal, type TradeAction } from './apex'
import type { Candle } from './marketData'
import type { PairMeta, Timeframe } from './pairs'

export type ApexTf = '1m' | '5m'

export interface TfReading {
  tf: ApexTf
  edge: ApexSignal
  dominance: number
}

export interface MultiTfDecision {
  activeTf: ApexTf
  edge: ApexSignal
  m1: TfReading
  m5: TfReading
  agreement: boolean
  reason: string
}

function dominance(edge: ApexSignal): number {
  let d = Math.abs(edge.score)
  if (edge.action !== 'WAIT') d += 55
  if (edge.setup) d += 20
  if (edge.sessionOpen) d += 8
  return d
}

function reading(tf: ApexTf, candles: Candle[], pair?: PairMeta): TfReading {
  const edge = evaluateApex(candles, pair)
  return { tf, edge, dominance: dominance(edge) }
}

/**
 * Compare 1m vs 5m Apex stacks and apply the stronger reading.
 * Opposite ENTRY directions → WAIT (conflict). Same direction → agree boost.
 */
export function decideMultiTf(
  candles1m: Candle[],
  candles5m: Candle[],
  prefer?: ApexTf,
  pair?: PairMeta,
): MultiTfDecision {
  const m1 = reading('1m', candles1m, pair)
  const m5 = reading('5m', candles5m, pair)
  if (prefer === '1m') m1.dominance += 4
  if (prefer === '5m') m5.dominance += 4

  const a1 = m1.edge.action
  const a5 = m5.edge.action
  const oppositeEntry =
    (a1 === 'LONG' && a5 === 'SHORT') || (a1 === 'SHORT' && a5 === 'LONG')

  if (oppositeEntry) {
    const stronger = m1.dominance >= m5.dominance ? m1 : m5
    return {
      activeTf: stronger.tf,
      edge: {
        ...stronger.edge,
        action: 'WAIT',
        label: `1m/5m 衝突 · ${stronger.tf}優勢だが見送り`,
        score: Math.round(stronger.edge.score * 0.35),
      },
      m1,
      m5,
      agreement: false,
      reason: '1分と5分が逆方向エントリーのため待機',
    }
  }

  const agreement =
    (a1 !== 'WAIT' && a1 === a5) ||
    (a1 === 'WAIT' &&
      a5 === 'WAIT' &&
      m1.edge.bias === m5.edge.bias &&
      m1.edge.bias !== 'neutral')

  let winner: TfReading
  if (a1 !== 'WAIT' && a5 === 'WAIT') winner = m1
  else if (a5 !== 'WAIT' && a1 === 'WAIT') winner = m5
  else if (m5.dominance > m1.dominance) winner = m5
  else if (m1.dominance > m5.dominance) winner = m1
  else winner = prefer === '1m' ? m1 : m5

  let edge = { ...winner.edge }
  if (agreement && edge.action !== 'WAIT') {
    edge = {
      ...edge,
      score: Math.max(-100, Math.min(100, edge.score + (edge.score >= 0 ? 8 : -8))),
      label: `${edge.label} · 1m/5m一致`,
    }
  } else if (edge.action !== 'WAIT') {
    edge = {
      ...edge,
      label: `${edge.label} · 適用${winner.tf}`,
    }
  } else {
    edge = {
      ...edge,
      label: edge.label.includes('APEX')
        ? `${edge.label} · 優勢${winner.tf}`
        : edge.label,
    }
  }

  return {
    activeTf: winner.tf,
    edge,
    m1,
    m5,
    agreement,
    reason:
      winner.tf === '5m'
        ? `5分足優勢 (dom ${m5.dominance.toFixed(0)} > ${m1.dominance.toFixed(0)})`
        : `1分足優勢 (dom ${m1.dominance.toFixed(0)} > ${m5.dominance.toFixed(0)})`,
  }
}

export function chartTfForDecision(active: ApexTf, userTf: Timeframe): Timeframe {
  if (userTf === '1m' || userTf === '5m') return active
  return userTf
}

export type { TradeAction }
