import type { Candle } from './marketData'
import {
  adx,
  atr,
  bollinger,
  ema,
  macd,
  rsi,
  stochastic,
  supertrendDirection,
} from './indicators'
import {
  evaluateConfluence,
  type Bias,
  type Confluence,
  type IndicatorSignal,
} from './signals'

/** Frozen Edge Strict params from 2025 train / 2026 holdout. */
export const EDGE_PARAMS = {
  entryScore: 65,
  adxMin: 22,
  slAtr: 1.2,
  tpAtr: 2.0,
  cooldownBars: 12,
} as const

export type TradeAction = 'LONG' | 'SHORT' | 'WAIT'

export interface EdgeGate {
  id: string
  name: string
  ok: boolean
  detail: string
}

export interface EdgeSignal extends Confluence {
  action: TradeAction
  gates: EdgeGate[]
  atr: number
  stopDistance: number
  takeProfitDistance: number
  sessionOpen: boolean
}

function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1]
}

/** Tokyo 09–15 / London 16–24 in Asia/Tokyo. */
export function isScalpSession(unixSec: number, now = new Date()): boolean {
  // Prefer candle time when available; fall back to wall clock for live tick.
  const t = unixSec > 0 ? new Date(unixSec * 1000) : now
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(t)
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? ''
  if (weekday === 'Sat' || weekday === 'Sun') return false
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  const hm = hour * 60 + minute
  return (hm >= 9 * 60 && hm < 15 * 60) || (hm >= 16 * 60 && hm < 24 * 60)
}

/**
 * KEHAI Edge Strict — confluence + ADX / Supertrend / MTF gates.
 * Tuned for 1m scalping; action fires only on score cross of ±65 with gates green.
 */
export function evaluateEdge(candles: Candle[], prevScore?: number): EdgeSignal {
  const base = evaluateConfluence(candles)
  const price = last(candles)?.close ?? 0
  const t = last(candles)?.time ?? 0
  const signals: IndicatorSignal[] = [...base.signals]

  const adxVal = last(adx(candles, 14))
  const st = last(supertrendDirection(candles, 10, 2))
  const ema21mtf = last(ema(candles, 105))
  const ema55mtf = last(ema(candles, 275))
  const atrVal = last(atr(candles, 14))?.value ?? 0
  const ema8 = last(ema(candles, 8))
  const ema21 = last(ema(candles, 21))
  const ema55 = last(ema(candles, 55))
  const rsi7 = last(rsi(candles, 7))
  const stoch = stochastic(candles, 5, 3)
  const k = last(stoch.k)
  const d = last(stoch.d)
  const macdVal = last(macd(candles))
  const bb = last(bollinger(candles))

  if (adxVal) {
    signals.unshift({
      id: 'adx',
      name: 'ADX(14)',
      bias:
        adxVal.adx >= EDGE_PARAMS.adxMin
          ? adxVal.plusDi > adxVal.minusDi
            ? 'bull'
            : 'bear'
          : 'neutral',
      strength: Math.min(1, adxVal.adx / 40),
      detail:
        adxVal.adx >= EDGE_PARAMS.adxMin
          ? `ADX ${adxVal.adx.toFixed(1)} — トレンド相場`
          : `ADX ${adxVal.adx.toFixed(1)} — レンジ回避`,
    })
  }

  if (st) {
    signals.unshift({
      id: 'supertrend',
      name: 'Supertrend',
      bias: st.value > 0 ? 'bull' : 'bear',
      strength: 0.9,
      detail: st.value > 0 ? '上昇トレンド帯' : '下降トレンド帯',
    })
  }

  if (ema21mtf && ema55mtf) {
    signals.unshift({
      id: 'mtf',
      name: 'MTF 5m相当',
      bias: ema21mtf.value > ema55mtf.value ? 'bull' : 'bear',
      strength: 0.85,
      detail:
        ema21mtf.value > ema55mtf.value
          ? '上位足バイアス買い'
          : '上位足バイアス売り',
    })
  }

  if (ema8 && ema21 && ema55) {
    const stacked =
      ema8.value > ema21.value && ema21.value > ema55.value
        ? 'bull'
        : ema8.value < ema21.value && ema21.value < ema55.value
          ? 'bear'
          : 'neutral'
    signals.push({
      id: 'ema-stack',
      name: 'EMA 8/21/55',
      bias: stacked,
      strength: stacked === 'neutral' ? 0.2 : 0.95,
      detail:
        stacked === 'bull'
          ? 'パーフェクトオーダー買い'
          : stacked === 'bear'
            ? 'パーフェクトオーダー売り'
            : 'EMA混在',
    })
  }

  if (rsi7) {
    signals.push({
      id: 'rsi7',
      name: 'RSI(7)',
      bias:
        rsi7.value <= 28 ? 'bull' : rsi7.value >= 72 ? 'bear' : rsi7.value > 55 ? 'bull' : rsi7.value < 45 ? 'bear' : 'neutral',
      strength: Math.min(1, Math.abs(rsi7.value - 50) / 30),
      detail: `スキャルRSI ${rsi7.value.toFixed(1)}`,
    })
  }

  if (k && d) {
    signals.push({
      id: 'stoch-fast',
      name: 'Stoch(5,3)',
      bias: k.value > d.value ? 'bull' : 'bear',
      strength: Math.min(1, Math.abs(k.value - 50) / 40),
      detail: `%K ${k.value.toFixed(1)} / %D ${d.value.toFixed(1)}`,
    })
  }

  if (macdVal) {
    signals.push({
      id: 'macd-edge',
      name: 'MACD Hist',
      bias: macdVal.histogram >= 0 ? 'bull' : 'bear',
      strength: 0.7,
      detail: macdVal.histogram >= 0 ? 'ヒストグラムプラス' : 'ヒストグラムマイナス',
    })
  }

  if (bb) {
    signals.push({
      id: 'bb-edge',
      name: 'Bollinger',
      bias: price > bb.middle ? 'bull' : 'bear',
      strength: 0.5,
      detail: price > bb.middle ? 'ミドル上' : 'ミドル下',
    })
  }

  const sessionOpen = isScalpSession(t)
  const adxOk = !!adxVal && adxVal.adx >= EDGE_PARAMS.adxMin
  const stOk = !!st
  const mtfOk = !!ema21mtf && !!ema55mtf
  const score = base.score
  const stAlignLong = stOk && st!.value > 0
  const stAlignShort = stOk && st!.value < 0
  const mtfAlignLong = mtfOk && ema21mtf!.value > ema55mtf!.value
  const mtfAlignShort = mtfOk && ema21mtf!.value < ema55mtf!.value
  const scoreLong = score >= EDGE_PARAMS.entryScore
  const scoreShort = score <= -EDGE_PARAMS.entryScore
  const crossedLong =
    scoreLong && (prevScore === undefined || prevScore < EDGE_PARAMS.entryScore)
  const crossedShort =
    scoreShort && (prevScore === undefined || prevScore > -EDGE_PARAMS.entryScore)

  const gates: EdgeGate[] = [
    {
      id: 'session',
      name: 'セッション',
      ok: sessionOpen,
      detail: sessionOpen ? '東京/ロンドン稼働中' : '時間外 — 待機',
    },
    {
      id: 'adx',
      name: 'ADXゲート',
      ok: adxOk,
      detail: adxOk
        ? `ADX ${adxVal!.adx.toFixed(1)} ≥ ${EDGE_PARAMS.adxMin}`
        : `ADX不足（要≥${EDGE_PARAMS.adxMin}）`,
    },
    {
      id: 'supertrend',
      name: 'Supertrend',
      ok: stAlignLong || stAlignShort,
      detail: stOk
        ? st!.value > 0
          ? '上昇帯'
          : '下降帯'
        : '未計算',
    },
    {
      id: 'mtf',
      name: 'MTFゲート',
      ok: mtfAlignLong || mtfAlignShort,
      detail: mtfOk
        ? ema21mtf!.value > ema55mtf!.value
          ? '上位足買いバイアス'
          : '上位足売りバイアス'
        : '未計算',
    },
    {
      id: 'score',
      name: '気配±65',
      ok: scoreLong || scoreShort,
      detail: `スコア ${score > 0 ? '+' : ''}${score}${
        crossedLong || crossedShort ? ' · CROSS' : ''
      }`,
    },
  ]

  // Live UI: armed when all directional gates align. Backtests use cross-only.
  let action: TradeAction = 'WAIT'
  if (sessionOpen && adxOk) {
    if (scoreLong && stAlignLong && mtfAlignLong) action = 'LONG'
    else if (scoreShort && stAlignShort && mtfAlignShort) action = 'SHORT'
  }

  let bias: Bias = base.bias
  let label = base.label
  if (action === 'LONG') {
    bias = 'bull'
    label = 'EDGE ロング'
  } else if (action === 'SHORT') {
    bias = 'bear'
    label = 'EDGE ショート'
  } else if (!sessionOpen) {
    label = 'セッション外'
  } else if (!adxOk) {
    label = 'ADX待ち'
  } else if (Math.abs(score) >= EDGE_PARAMS.entryScore) {
    label = 'ゲート未充足'
  }

  return {
    ...base,
    score,
    bias,
    label,
    signals,
    action,
    gates,
    atr: atrVal,
    stopDistance: atrVal * EDGE_PARAMS.slAtr,
    takeProfitDistance: atrVal * EDGE_PARAMS.tpAtr,
    sessionOpen,
  }
}
