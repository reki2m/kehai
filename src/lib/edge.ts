import {
  estimateSpreadPips,
  MAX_ENTRY_SPREAD_PIPS,
  newsBlackout,
} from './filters'
import type { Candle } from './marketData'
import {
  adx,
  atr,
  bollinger,
  bollingerSqueeze,
  ema,
  macd,
  rsi,
  sessionVwap,
  stochastic,
  supertrendDirection,
} from './indicators'
import {
  evaluateConfluence,
  type Bias,
  type Confluence,
  type IndicatorSignal,
} from './signals'

/**
 * KEHAI Edge Pro — TradingView-inspired scalping stack.
 * Sources: session VWAP (LuxAlgo Sessions), Supertrend 7/2 (1m TV common),
 * Squeeze Engine style BB/KC gate, plus prior Edge Strict gates.
 */
export const EDGE_PARAMS = {
  entryScore: 65,
  adxMin: 22,
  slAtr: 1.2,
  tpAtr: 2.0,
  cooldownBars: 12,
  stPeriod: 7,
  stMult: 2,
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
  spreadPips: number
  newsLabel: string | null
}

function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1]
}

/** Tokyo 09–15 / London 16–24 in Asia/Tokyo. */
export function isScalpSession(unixSec: number, now = new Date()): boolean {
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

export function evaluateEdge(candles: Candle[], prevScore?: number): EdgeSignal {
  const base = evaluateConfluence(candles)
  const price = last(candles)?.close ?? 0
  const t = last(candles)?.time ?? 0
  const signals: IndicatorSignal[] = [...base.signals]

  const atrVal = last(atr(candles, 14))?.value ?? 0
  const atrPips = atrVal > 0 ? atrVal / 0.01 : undefined
  const spreadPips = estimateSpreadPips(t, atrPips)
  const news = newsBlackout(t)

  const adxVal = last(adx(candles, 14))
  const st = last(
    supertrendDirection(candles, EDGE_PARAMS.stPeriod, EDGE_PARAMS.stMult),
  )
  const vwap = last(sessionVwap(candles))
  const squeeze = last(bollingerSqueeze(candles))
  const ema21mtf = last(ema(candles, 105))
  const ema55mtf = last(ema(candles, 275))
  const ema8 = last(ema(candles, 8))
  const ema21 = last(ema(candles, 21))
  const ema55 = last(ema(candles, 55))
  const rsi7 = last(rsi(candles, 7))
  const stoch = stochastic(candles, 5, 3)
  const k = last(stoch.k)
  const d = last(stoch.d)
  const macdVal = last(macd(candles))
  const bb = last(bollinger(candles))

  if (vwap) {
    signals.unshift({
      id: 'vwap',
      name: 'Session VWAP',
      bias: price >= vwap.value ? 'bull' : 'bear',
      strength: Math.min(1, Math.abs(price - vwap.value) / (atrVal || price * 0.0005)),
      detail:
        price >= vwap.value
          ? `VWAP上 ${vwap.value.toFixed(3)} — TV機関バイアス買い`
          : `VWAP下 ${vwap.value.toFixed(3)} — TV機関バイアス売り`,
    })
  }

  if (squeeze) {
    signals.unshift({
      id: 'squeeze',
      name: 'BB Squeeze',
      bias: 'neutral',
      strength: squeeze.squeeze ? 0.2 : 0.8,
      detail: squeeze.squeeze
        ? 'スクイーズ中 — ブレイク待ち（TV Squeeze）'
        : 'スクイーズ解除 — 拡大局面',
    })
  }

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
      name: `Supertrend(${EDGE_PARAMS.stPeriod},${EDGE_PARAMS.stMult})`,
      bias: st.value > 0 ? 'bull' : 'bear',
      strength: 0.9,
      detail: st.value > 0 ? '上昇トレンド帯（TV 1m設定）' : '下降トレンド帯（TV 1m設定）',
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
        rsi7.value <= 28
          ? 'bull'
          : rsi7.value >= 72
            ? 'bear'
            : rsi7.value > 55
              ? 'bull'
              : rsi7.value < 45
                ? 'bear'
                : 'neutral',
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
  const vwapOk = !!vwap
  const notSqueeze = !!squeeze && !squeeze.squeeze
  const spreadOk = spreadPips <= MAX_ENTRY_SPREAD_PIPS
  const newsOk = !news
  const score = base.score
  const stAlignLong = stOk && st!.value > 0
  const stAlignShort = stOk && st!.value < 0
  const mtfAlignLong = mtfOk && ema21mtf!.value > ema55mtf!.value
  const mtfAlignShort = mtfOk && ema21mtf!.value < ema55mtf!.value
  const vwapLong = vwapOk && price >= vwap!.value
  const vwapShort = vwapOk && price < vwap!.value
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
      id: 'news',
      name: 'ニュース帯',
      ok: newsOk,
      detail: newsOk ? '高インパクトなし' : `回避: ${news!.label}`,
    },
    {
      id: 'spread',
      name: 'スプレッド',
      ok: spreadOk,
      detail: `${spreadPips.toFixed(2)} pips ${spreadOk ? `≤ ${MAX_ENTRY_SPREAD_PIPS}` : '(拡大中)'}`,
    },
    {
      id: 'squeeze',
      name: 'Squeeze',
      ok: notSqueeze,
      detail: notSqueeze ? '拡大局面 OK' : 'スクイーズ中 — 見送り',
    },
    {
      id: 'vwap',
      name: 'Session VWAP',
      ok: vwapLong || vwapShort,
      detail: vwapOk
        ? price >= vwap!.value
          ? '価格≥VWAP'
          : '価格<VWAP'
        : '未計算',
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
      detail: stOk ? (st!.value > 0 ? '上昇帯' : '下降帯') : '未計算',
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

  let action: TradeAction = 'WAIT'
  const baseOk = sessionOpen && adxOk && newsOk && spreadOk && notSqueeze
  if (baseOk) {
    if (scoreLong && stAlignLong && mtfAlignLong && vwapLong) action = 'LONG'
    else if (scoreShort && stAlignShort && mtfAlignShort && vwapShort)
      action = 'SHORT'
  }

  let bias: Bias = base.bias
  let label = base.label
  if (action === 'LONG') {
    bias = 'bull'
    label = 'EDGE ロング'
  } else if (action === 'SHORT') {
    bias = 'bear'
    label = 'EDGE ショート'
  } else if (!newsOk) {
    label = `ニュース回避 (${news!.label})`
  } else if (!spreadOk) {
    label = 'スプレッド拡大'
  } else if (!notSqueeze) {
    label = 'スクイーズ待ち'
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
    spreadPips,
    newsLabel: news?.label ?? null,
  }
}
