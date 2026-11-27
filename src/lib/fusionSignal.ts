/**
 * KEHAI Fusion Desk — role-split stack of popular TV concepts:
 *   UT Bot        → trigger (flip)
 *   SuperTrend    → trend filter
 *   Squeeze Mom   → energy (prefer release / rising mom)
 *   SMC structure → BOS bias filter
 *   Lorentzian    → ML neighbor vote
 *
 * Concept-level recombine (not a LuxAlgo / LazyBear / jdehorty port).
 * Live default stays Peak Drive until Fusion beats it on Dukascopy.
 */

import { newsBlackout } from './filters'
import type { Candle } from './marketData'
import {
  adx,
  lorentzianClassification,
  squeezeMomentum,
  smcStructure,
  supertrendDirection,
  utBotTrail,
} from './indicators'
import type { PairMeta } from './pairs'
import {
  SESSION_PROFILES,
  detectFxSession,
  isFxWeekday,
  isNoonSignalWindow,
} from './apex'
import { SIMPLE } from './simpleSignal'
import type { HistSignal } from './signalHistory'

export const FUSION = {
  name: 'KEHAI Fusion Desk',
  stack: 'UT×ST×Squeeze×SMC×Lorentz',
  requireSt: true,
  requireSqueezeOff: true,
  requireMomAgree: true,
  requireSmc: true,
  requireLorentz: true,
  adxMin: 22,
  adxPrime: 26,
  entryCooldownBars: 5,
  neighbors: 8,
  maxBarsBack: 400,
}

export type FusionGateOpts = Partial<{
  requireSt: boolean
  requireSqueezeOff: boolean
  requireMomAgree: boolean
  requireSmc: boolean
  requireLorentz: boolean
  adxMin: number
  adxPrime: number
  cool: number
  neighbors: number
  maxBarsBack: number
}>

/**
 * Historical Fusion entries for simulateHistTrades.
 */
export function listFusionSignals(
  candles: Candle[],
  _pair?: PairMeta,
  fromUnix = 0,
  gates?: FusionGateOpts,
): HistSignal[] {
  if (candles.length < 120) return []
  const g = {
    requireSt: gates?.requireSt ?? FUSION.requireSt,
    requireSqueezeOff: gates?.requireSqueezeOff ?? FUSION.requireSqueezeOff,
    requireMomAgree: gates?.requireMomAgree ?? FUSION.requireMomAgree,
    requireSmc: gates?.requireSmc ?? FUSION.requireSmc,
    requireLorentz: gates?.requireLorentz ?? FUSION.requireLorentz,
    adxMin: gates?.adxMin ?? FUSION.adxMin,
    adxPrime: gates?.adxPrime ?? FUSION.adxPrime,
    cool: gates?.cool ?? FUSION.entryCooldownBars,
    neighbors: gates?.neighbors ?? FUSION.neighbors,
    maxBarsBack: gates?.maxBarsBack ?? FUSION.maxBarsBack,
  }

  const profiles = [
    SESSION_PROFILES.tokyo,
    SESSION_PROFILES.london,
    SESSION_PROFILES.ny,
  ] as const

  const utBy = new Map<string, Map<number, number>>()
  for (const p of profiles) {
    const key = `${p.utKey}/${p.utAtr}`
    if (utBy.has(key)) continue
    const { direction } = utBotTrail(candles, p.utKey, p.utAtr)
    utBy.set(key, new Map(direction.map((d) => [d.time, d.value])))
  }

  const stMap = new Map(
    supertrendDirection(candles, SIMPLE.stPeriod, SIMPLE.stMult).map((d) => [
      d.time,
      d.value,
    ]),
  )
  const needSq = g.requireSqueezeOff || g.requireMomAgree
  const sqMap = needSq
    ? new Map(squeezeMomentum(candles).map((d) => [d.time, d]))
    : null
  const smcMap = g.requireSmc
    ? new Map(smcStructure(candles, 3).map((d) => [d.time, d]))
    : null
  const lzMap = g.requireLorentz
    ? new Map(
        lorentzianClassification(candles, {
          neighbors: g.neighbors,
          maxBarsBack: g.maxBarsBack,
        }).map((d) => [d.time, d]),
      )
    : null
  const adxMap = new Map(adx(candles, 14).map((d) => [d.time, d]))

  const out: HistSignal[] = []
  let lastIdx = -9999

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!
    if (c.time < fromUnix) continue
    if (i - lastIdx < g.cool) continue
    if (!isFxWeekday(c.time)) continue
    if (newsBlackout(c.time)) continue

    const fx = detectFxSession(c.time)
    if (!fx) continue
    const profile = SESSION_PROFILES[fx]
    const utMap = utBy.get(`${profile.utKey}/${profile.utAtr}`)
    if (!utMap) continue
    const u = utMap.get(c.time)
    const up = utMap.get(candles[i - 1]!.time)
    if (u == null || up == null) continue

    const flipLong = u > 0 && up <= 0
    const flipShort = u < 0 && up >= 0
    if (!flipLong && !flipShort) continue

    const noonOk = isNoonSignalWindow(c.time)
    const adxV = adxMap.get(c.time)
    if (!adxV || adxV.adx < (noonOk ? g.adxMin : g.adxPrime)) continue

    const long = flipLong
    const st = stMap.get(c.time) ?? 0
    if (g.requireSt && (long ? st <= 0 : st >= 0)) continue

    const sq = sqMap?.get(c.time)
    if (g.requireSqueezeOff && sq?.squeeze) continue
    if (g.requireMomAgree) {
      if (long && !(sq && sq.momentum > 0 && sq.rising)) continue
      if (!long && !(sq && sq.momentum < 0 && !sq.rising)) continue
    }

    const smc = smcMap?.get(c.time)
    if (g.requireSmc && (long ? !(smc && smc.bos > 0) : !(smc && smc.bos < 0)))
      continue

    const lz = lzMap?.get(c.time)
    if (
      g.requireLorentz &&
      (long ? !(lz && lz.vote > 0) : !(lz && lz.vote < 0))
    )
      continue

    out.push({
      time: c.time,
      side: long ? 'BUY' : 'SELL',
      price: c.close,
      prime: true,
      grade: 'A',
      track: 'honmei',
      sizeHint: 1,
    })
    lastIdx = i
  }
  return out
}
