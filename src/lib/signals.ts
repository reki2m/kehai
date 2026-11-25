import type { Candle } from './marketData'
import {
  atr,
  bollinger,
  ema,
  macd,
  rsi,
  sma,
  stochastic,
} from './indicators'

export type Bias = 'bull' | 'bear' | 'neutral'

export interface IndicatorSignal {
  id: string
  name: string
  bias: Bias
  strength: number
  detail: string
}

export interface Confluence {
  score: number
  bias: Bias
  label: string
  signals: IndicatorSignal[]
}

function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1]
}

export function evaluateConfluence(candles: Candle[]): Confluence {
  const signals: IndicatorSignal[] = []
  const price = last(candles)?.close ?? 0

  const ema21 = last(ema(candles, 21))
  const ema55 = last(ema(candles, 55))
  const sma20 = last(sma(candles, 20))
  if (ema21 && ema55) {
    const bull = ema21.value > ema55.value
    signals.push({
      id: 'ema-cross',
      name: 'EMA 21/55',
      bias: bull ? 'bull' : 'bear',
      strength: Math.min(1, Math.abs(ema21.value - ema55.value) / (price * 0.002)),
      detail: bull ? '短期EMAが長期を上回る' : '短期EMAが長期を下回る',
    })
  }

  const rsiVal = last(rsi(candles, 14))
  if (rsiVal) {
    let bias: Bias = 'neutral'
    let detail = `RSI ${rsiVal.value.toFixed(1)} — 中立域`
    if (rsiVal.value >= 70) {
      bias = 'bear'
      detail = `RSI ${rsiVal.value.toFixed(1)} — 過買い`
    } else if (rsiVal.value <= 30) {
      bias = 'bull'
      detail = `RSI ${rsiVal.value.toFixed(1)} — 過売り`
    } else if (rsiVal.value > 55) {
      bias = 'bull'
      detail = `RSI ${rsiVal.value.toFixed(1)} — 買い優勢`
    } else if (rsiVal.value < 45) {
      bias = 'bear'
      detail = `RSI ${rsiVal.value.toFixed(1)} — 売り優勢`
    }
    signals.push({
      id: 'rsi',
      name: 'RSI(14)',
      bias,
      strength: Math.min(1, Math.abs(rsiVal.value - 50) / 30),
      detail,
    })
  }

  const macdVal = last(macd(candles))
  if (macdVal) {
    const bull = macdVal.macd > macdVal.signal
    signals.push({
      id: 'macd',
      name: 'MACD',
      bias: bull ? 'bull' : 'bear',
      strength: Math.min(1, Math.abs(macdVal.histogram) / (Math.abs(macdVal.macd) + 1e-9) * 0.8 + 0.2),
      detail: bull
        ? `ヒストグラム +${macdVal.histogram.toPrecision(3)}`
        : `ヒストグラム ${macdVal.histogram.toPrecision(3)}`,
    })
  }

  const bb = last(bollinger(candles))
  if (bb && sma20) {
    const width = bb.upper - bb.lower || 1
    const pos = (price - bb.lower) / width
    let bias: Bias = 'neutral'
    let detail = 'バンド中央付近'
    if (pos >= 0.85) {
      bias = 'bear'
      detail = '上限付近 — 反転警戒'
    } else if (pos <= 0.15) {
      bias = 'bull'
      detail = '下限付近 — 反発候補'
    } else if (price > bb.middle) {
      bias = 'bull'
      detail = 'ミドル上で推移'
    } else {
      bias = 'bear'
      detail = 'ミドル下で推移'
    }
    signals.push({
      id: 'bb',
      name: 'Bollinger',
      bias,
      strength: Math.min(1, Math.abs(pos - 0.5) * 2),
      detail,
    })
  }

  const stoch = stochastic(candles)
  const k = last(stoch.k)
  const d = last(stoch.d)
  if (k && d) {
    let bias: Bias = 'neutral'
    let detail = `%K ${k.value.toFixed(1)} / %D ${d.value.toFixed(1)}`
    if (k.value < 20 && k.value > d.value) {
      bias = 'bull'
      detail = 'ストキャス過売りから上向き'
    } else if (k.value > 80 && k.value < d.value) {
      bias = 'bear'
      detail = 'ストキャス過買いから下向き'
    } else if (k.value > d.value) {
      bias = 'bull'
      detail = `%K>%D — モメンタム上向き`
    } else {
      bias = 'bear'
      detail = `%K<%D — モメンタム下向き`
    }
    signals.push({
      id: 'stoch',
      name: 'Stochastic',
      bias,
      strength: Math.min(1, Math.abs(k.value - 50) / 40),
      detail,
    })
  }

  const atrVal = last(atr(candles))
  if (atrVal) {
    const atrPct = (atrVal.value / price) * 100
    signals.push({
      id: 'atr',
      name: 'ATR(14)',
      bias: 'neutral',
      strength: Math.min(1, atrPct / 0.4),
      detail: `ボラティリティ ${atrPct.toFixed(3)}%`,
    })
  }

  let bull = 0
  let bear = 0
  for (const s of signals) {
    if (s.id === 'atr') continue
    if (s.bias === 'bull') bull += s.strength
    if (s.bias === 'bear') bear += s.strength
  }
  const total = bull + bear || 1
  const score = Math.round(((bull - bear) / total) * 100)
  const abs = Math.abs(score)
  let bias: Bias = 'neutral'
  let label = '様子見'
  if (score >= 35) {
    bias = 'bull'
    label = abs >= 70 ? '強い買い気配' : '買い気配'
  } else if (score <= -35) {
    bias = 'bear'
    label = abs >= 70 ? '強い売り気配' : '売り気配'
  }

  return { score, bias, label, signals }
}
