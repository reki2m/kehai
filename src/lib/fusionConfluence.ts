/**
 * Soft confluence readout for the Fusion desk (watch-only).
 * Does NOT override Peak Drive entries — popular TV concepts as votes.
 */

import type { Candle } from './marketData'
import {
  lorentzianClassification,
  squeezeMomentum,
  smcStructure,
  supertrendDirection,
  utBotTrail,
} from './indicators'
import { SIMPLE } from './simpleSignal'
import { SESSION_PROFILES, detectFxSession } from './apex'

export interface FusionVote {
  id: string
  name: string
  role: string
  bias: 'bull' | 'bear' | 'neutral'
  detail: string
}

export interface FusionConfluence {
  votes: FusionVote[]
  bull: number
  bear: number
  /** Net −5…+5 from directional votes. */
  score: number
  aligned: 'BUY' | 'SELL' | null
}

function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1]
}

export function evaluateFusionConfluence(candles: Candle[]): FusionConfluence {
  if (candles.length < 120) {
    return { votes: [], bull: 0, bear: 0, score: 0, aligned: null }
  }
  const t = last(candles)!.time
  const fx = detectFxSession(t)
  const profile = fx ? SESSION_PROFILES[fx] : SESSION_PROFILES.tokyo
  const { direction: utSeries } = utBotTrail(
    candles,
    profile.utKey,
    profile.utAtr,
  )
  const ut = last(utSeries)
  const utPrev = utSeries.length >= 2 ? utSeries[utSeries.length - 2] : undefined
  const st = last(
    supertrendDirection(candles, SIMPLE.stPeriod, SIMPLE.stMult),
  )
  const sq = last(squeezeMomentum(candles))
  const smc = last(smcStructure(candles, 3))
  // Lighter Lorentzian for live desk
  const lz = last(
    lorentzianClassification(candles, {
      neighbors: 6,
      maxBarsBack: 200,
      horizon: 4,
    }),
  )

  const votes: FusionVote[] = [
    {
      id: 'ut',
      name: 'UT Bot',
      role: 'トリガー',
      bias:
        ut && utPrev && ut.value > 0 && utPrev.value <= 0
          ? 'bull'
          : ut && utPrev && ut.value < 0 && utPrev.value >= 0
            ? 'bear'
            : ut && ut.value > 0
              ? 'bull'
              : ut && ut.value < 0
                ? 'bear'
                : 'neutral',
      detail:
        ut && utPrev && ut.value !== utPrev.value
          ? 'フリップ'
          : ut && ut.value > 0
            ? 'ロング側'
            : 'ショート側',
    },
    {
      id: 'st',
      name: 'SuperTrend',
      role: 'トレンド',
      bias: st && st.value > 0 ? 'bull' : st && st.value < 0 ? 'bear' : 'neutral',
      detail: st && st.value > 0 ? '上昇トレンド' : '下降トレンド',
    },
    {
      id: 'sq',
      name: 'Squeeze Mom',
      role: 'エネルギー',
      bias: sq?.squeeze
        ? 'neutral'
        : sq && sq.momentum > 0
          ? 'bull'
          : sq && sq.momentum < 0
            ? 'bear'
            : 'neutral',
      detail: sq?.squeeze
        ? 'スクイーズ中'
        : sq
          ? `モメ ${sq.momentum >= 0 ? '+' : ''}${sq.momentum.toFixed(4)}`
          : '—',
    },
    {
      id: 'smc',
      name: 'SMC BOS',
      role: '構造',
      bias: smc && smc.bos > 0 ? 'bull' : smc && smc.bos < 0 ? 'bear' : 'neutral',
      detail: smc ? `BOS ${smc.bos > 0 ? '強気' : smc.bos < 0 ? '弱気' : 'なし'}` : '—',
    },
    {
      id: 'lz',
      name: 'Lorentzian',
      role: 'ML投票',
      bias: lz && lz.vote > 0 ? 'bull' : lz && lz.vote < 0 ? 'bear' : 'neutral',
      detail: lz ? `vote ${lz.vote > 0 ? '+' : ''}${lz.vote} (${lz.score})` : '—',
    },
  ]

  let bull = 0
  let bear = 0
  for (const v of votes) {
    if (v.bias === 'bull') bull++
    if (v.bias === 'bear') bear++
  }
  const score = bull - bear
  return {
    votes,
    bull,
    bear,
    score,
    aligned: score >= 3 ? 'BUY' : score <= -3 ? 'SELL' : null,
  }
}
