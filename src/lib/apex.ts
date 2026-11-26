import {
  estimateSpreadPips,
  newsBlackout,
} from './filters'
import type { Candle } from './marketData'
import {
  atr,
  ema,
  sessionVwap,
  sslDirection,
  utBotDirection,
  wavetrend,
} from './indicators'
import type { PairMeta } from './pairs'
import type { Bias, IndicatorSignal } from './signals'

/**
 * KEHAI Apex — Triple Session (widened for more manual scalp chances)
 *
 * Stack: UT Bot flip × SSL confirm, session-tuned knobs.
 *
 * Windows (USDJPY):
 *  Tokyo 00:00–06 UTC (09–15 JST) · UT1.5/7 · EMA
 *  London 07:00–11 UTC (16–20 JST) · UT2/10 · VWAP
 *  NY 13:00–17 UTC (22–02 JST) · UT3/7 · EMA
 */

export type FxSession = 'tokyo' | 'london' | 'ny'

export interface SessionProfile {
  id: FxSession
  label: string
  labelJa: string
  /** Display window in JST. */
  jst: string
  utKey: number
  utAtr: number
  sslLen: number
  slPips: number
  tpPips: number
  maxSpread: number
  requireVwap: boolean
  requireEma: boolean
}

/** Wider scalp windows — more chances than the old mid-only lock. */
export const SESSION_PROFILES: Record<FxSession, SessionProfile> = {
  tokyo: {
    id: 'tokyo',
    label: 'Tokyo',
    labelJa: '東京時間',
    jst: '09:00–15:00 JST',
    utKey: 1.5,
    utAtr: 7,
    sslLen: 10,
    slPips: 7,
    tpPips: 10,
    maxSpread: 0.5,
    requireVwap: false,
    requireEma: true,
  },
  london: {
    id: 'london',
    label: 'London',
    labelJa: 'ロンドン時間',
    jst: '16:00–20:00 JST',
    utKey: 2,
    utAtr: 10,
    sslLen: 10,
    slPips: 7,
    tpPips: 10,
    maxSpread: 0.45,
    requireVwap: true,
    requireEma: false,
  },
  ny: {
    id: 'ny',
    label: 'NY',
    labelJa: 'NY時間',
    jst: '22:00–02:00 JST',
    utKey: 3,
    utAtr: 7,
    sslLen: 10,
    slPips: 7,
    tpPips: 10,
    maxSpread: 0.45,
    requireVwap: false,
    requireEma: true,
  },
}

/** Default / legacy export for UI that still reads APEX_PARAMS. */
export const APEX_PARAMS = {
  family: 'ut_ssl_triple' as const,
  kz: 'tokyo_london_ny' as const,
  hourMode: 'triple' as const,
  maxSpread: 0.5,
  slPips: 3,
  tpPips: 6,
  utKey: 2,
  utAtr: 7,
  sslLen: 10,
  requireVwap: true,
  pip: 0.01,
} as const

export type TradeAction = 'LONG' | 'SHORT' | 'WAIT'

export interface ApexGate {
  id: string
  name: string
  ok: boolean
  detail: string
}

export interface ApexSignal {
  score: number
  bias: Bias
  label: string
  signals: IndicatorSignal[]
  action: TradeAction
  gates: ApexGate[]
  atr: number
  stopDistance: number
  takeProfitDistance: number
  sessionOpen: boolean
  spreadPips: number
  newsLabel: string | null
  family: string
  setup: string | null
  session: FxSession | null
  sessionLabel: string | null
}

function last<T>(arr: T[]): T | undefined {
  return arr[arr.length - 1]
}

function utcHm(unixSec: number) {
  const d = new Date(unixSec * 1000)
  return {
    weekday: d.getUTCDay(),
    hm: d.getUTCHours() * 60 + d.getUTCMinutes(),
  }
}

export function detectFxSession(unixSec: number): FxSession | null {
  const { weekday, hm } = utcHm(unixSec)
  if (weekday === 0 || weekday === 6) return null
  // Tokyo 09–15 JST
  if (hm >= 0 && hm < 6 * 60) return 'tokyo'
  // London 16–20 JST
  if (hm >= 7 * 60 && hm < 11 * 60) return 'london'
  // NY 22–02 JST (13–17 UTC, and 0–2 UTC overlaps Tokyo — Tokyo already claimed)
  if (hm >= 13 * 60 && hm < 17 * 60) return 'ny'
  return null
}

/** @deprecated use detectFxSession — kept for London-only callers */
export function isEntryWindow(unixSec: number): boolean {
  return detectFxSession(unixSec) === 'london'
}

/** Broader weekday sessions for energy / index / VIX. */
export function isInstrumentWindow(unixSec: number, pair?: PairMeta): boolean {
  const { weekday, hm } = utcHm(unixSec)
  if (weekday === 0 || weekday === 6) return false
  if (!pair || pair.kind === 'fx') return detectFxSession(unixSec) != null
  if (pair.id === 'NIKKEI') {
    return hm < 8 * 60 || hm >= 23 * 60 || (hm >= 0 && hm < 7 * 60)
  }
  if (pair.id === 'DOW' || pair.id === 'VIX') {
    return hm >= 13 * 60 && hm < 21 * 60
  }
  if (pair.id === 'USOIL') {
    return hm >= 11 * 60 && hm < 21 * 60
  }
  return true
}

export function evaluateApex(candles: Candle[], pair?: PairMeta): ApexSignal {
  const pip = pair?.pip ?? APEX_PARAMS.pip
  const cur = last(candles)
  const price = cur?.close ?? 0
  const t = cur?.time ?? 0
  const atrVal = last(atr(candles, 14))?.value ?? 0
  const atrPips = atrVal > 0 ? atrVal / pip : 0

  const fxSession = !pair || pair.kind === 'fx' ? detectFxSession(t) : null
  const profile = fxSession ? SESSION_PROFILES[fxSession] : null

  const slPips = profile?.slPips ?? pair?.sl ?? APEX_PARAMS.slPips
  const tpPips = profile?.tpPips ?? pair?.tp ?? APEX_PARAMS.tpPips
  const maxSpread = profile?.maxSpread ?? APEX_PARAMS.maxSpread
  const utKey = profile?.utKey ?? APEX_PARAMS.utKey
  const utAtr = profile?.utAtr ?? APEX_PARAMS.utAtr
  const sslLen = profile?.sslLen ?? APEX_PARAMS.sslLen
  const requireVwap = profile?.requireVwap ?? true
  const requireEma = profile?.requireEma ?? false

  const spreadPips =
    pair && pair.kind !== 'fx'
      ? Math.min(maxSpread, 0.15 + Math.min(0.2, atrPips * 0.002))
      : estimateSpreadPips(t, atrPips || undefined)
  const news = pair?.kind === 'fx' ? newsBlackout(t) : null
  const vwap = last(sessionVwap(candles))
  const utSeries = utBotDirection(candles, utKey, utAtr)
  const sslSeries = sslDirection(candles, sslLen)
  const ut = last(utSeries)
  const utPrev = utSeries.length >= 2 ? utSeries[utSeries.length - 2] : undefined
  const ssl = last(sslSeries)
  const { wt1, wt2 } = wavetrend(candles, 10, 21)
  const w1 = last(wt1)
  const w2 = last(wt2)
  const ema21 = last(ema(candles, 21))
  const ema55 = last(ema(candles, 55))

  const windowOk =
    pair && pair.kind !== 'fx' ? isInstrumentWindow(t, pair) : fxSession != null
  const newsOk = !news
  const spreadOk = spreadPips <= maxSpread

  const utFlipLong = !!(ut && utPrev && ut.value > 0 && utPrev.value <= 0)
  const utFlipShort = !!(ut && utPrev && ut.value < 0 && utPrev.value >= 0)
  const sslLong = !!ssl && ssl.value > 0
  const sslShort = !!ssl && ssl.value < 0
  const emaLong = !requireEma || (!!ema21 && !!ema55 && ema21.value > ema55.value)
  const emaShort = !requireEma || (!!ema21 && !!ema55 && ema21.value < ema55.value)

  let longSetup = utFlipLong && sslLong && emaLong
  let shortSetup = utFlipShort && sslShort && emaShort
  if (requireVwap && vwap) {
    longSetup = longSetup && price >= vwap.value
    shortSetup = shortSetup && price <= vwap.value
  }
  const setup = longSetup || shortSetup ? 'UT Bot × SSL' : null

  const windowName =
    profile?.labelJa ??
    (pair?.id === 'NIKKEI'
      ? '日経帯'
      : pair?.id === 'USOIL'
        ? '原油帯'
        : pair && pair.kind !== 'fx'
          ? '米株帯'
          : '東京/ロンドン/NY')

  const windowDetail = profile
    ? `${profile.label} · ${profile.jst}`
    : pair && pair.kind !== 'fx'
      ? 'アクティブ時間帯'
      : '東京 09–15 / ロンドン 16–20 / NY 22–02 JST'

  const signals: IndicatorSignal[] = []

  signals.push({
    id: 'window',
    name: windowName,
    bias: windowOk ? (longSetup ? 'bull' : shortSetup ? 'bear' : 'neutral') : 'neutral',
    strength: windowOk ? 0.95 : 0.15,
    detail: windowOk ? windowDetail : 'エントリー帯外',
  })

  signals.push({
    id: 'utbot',
    name: `UT Bot (${utKey}/${utAtr})`,
    bias: ut ? (ut.value > 0 ? 'bull' : 'bear') : 'neutral',
    strength: utFlipLong || utFlipShort ? 1 : 0.7,
    detail: utFlipLong
      ? 'BUY flip'
      : utFlipShort
        ? 'SELL flip'
        : ut
          ? ut.value > 0
            ? '上昇トレイル'
            : '下降トレイル'
          : '未計算',
  })

  signals.push({
    id: 'ssl',
    name: 'SSL Channel',
    bias: ssl ? (ssl.value > 0 ? 'bull' : 'bear') : 'neutral',
    strength: 0.85,
    detail: ssl ? (ssl.value > 0 ? 'SSL 買い側' : 'SSL 売り側') : '未計算',
  })

  if (w1 && w2) {
    signals.push({
      id: 'wavetrend',
      name: 'WaveTrend',
      bias: w1.value > w2.value ? 'bull' : 'bear',
      strength: Math.min(1, Math.abs(w1.value) / 60),
      detail: `WT1 ${w1.value.toFixed(1)} / WT2 ${w2.value.toFixed(1)}`,
    })
  }

  if (vwap) {
    signals.push({
      id: 'vwap',
      name: 'Session VWAP',
      bias: price >= vwap.value ? 'bull' : 'bear',
      strength: Math.min(
        1,
        Math.abs(price - vwap.value) / (atrVal || price * 0.0005),
      ),
      detail:
        price >= vwap.value
          ? `VWAP上 ${vwap.value.toFixed(3)}`
          : `VWAP下 ${vwap.value.toFixed(3)}`,
    })
  }

  if (ema21 && ema55) {
    signals.push({
      id: 'ema',
      name: 'EMA 21/55',
      bias: ema21.value > ema55.value ? 'bull' : 'bear',
      strength: requireEma ? 0.85 : 0.6,
      detail: ema21.value > ema55.value ? '短期>長期' : '短期<長期',
    })
  }

  const gates: ApexGate[] = [
    {
      id: 'window',
      name: windowName,
      ok: windowOk,
      detail: windowOk ? windowDetail : '時間外',
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
      detail: `${spreadPips.toFixed(2)} ≤ ${maxSpread}`,
    },
    {
      id: 'utbot',
      name: 'UT Bot flip',
      ok: utFlipLong || utFlipShort,
      detail: utFlipLong ? 'BUY' : utFlipShort ? 'SELL' : '待ち',
    },
    {
      id: 'ssl',
      name: 'SSL確認',
      ok: (utFlipLong && sslLong) || (utFlipShort && sslShort),
      detail: sslLong ? '買い側' : sslShort ? '売り側' : 'なし',
    },
  ]

  if (requireVwap) {
    gates.push({
      id: 'vwap',
      name: 'VWAP側',
      ok: !!vwap && ((longSetup && price >= vwap.value) || (shortSetup && price <= vwap.value) || (!longSetup && !shortSetup && !!vwap)),
      detail: vwap
        ? price >= vwap.value
          ? '価格≥VWAP'
          : '価格<VWAP'
        : '未計算',
    })
  }

  if (requireEma) {
    gates.push({
      id: 'ema',
      name: 'EMAトレンド',
      ok: (utFlipLong && emaLong) || (utFlipShort && emaShort) || (!(utFlipLong || utFlipShort) && !!ema21),
      detail:
        ema21 && ema55
          ? ema21.value > ema55.value
            ? '上昇バイアス'
            : '下降バイアス'
          : '未計算',
    })
  }

  gates.push({
    id: 'setup',
    name: 'UT×SSL',
    ok: !!(longSetup || shortSetup),
    detail: setup ?? '未成立',
  })

  const baseOk = windowOk && newsOk && spreadOk
  let action: TradeAction = 'WAIT'
  if (baseOk && longSetup) action = 'LONG'
  else if (baseOk && shortSetup) action = 'SHORT'

  let score = 0
  if (ut) score += ut.value > 0 ? 20 : -20
  if (ssl) score += ssl.value > 0 ? 15 : -15
  if (vwap) score += price >= vwap.value ? 10 : -10
  if (windowOk) score += 15
  if (longSetup) score += 40
  if (shortSetup) score -= 40
  if (w1 && w2) score += w1.value > w2.value ? 8 : -8
  if (fxSession === 'tokyo') score += longSetup || shortSetup ? 4 : 0
  if (fxSession === 'ny') score += longSetup || shortSetup ? 4 : 0
  score = Math.max(-100, Math.min(100, Math.round(score)))

  const bias: Bias =
    action === 'LONG'
      ? 'bull'
      : action === 'SHORT'
        ? 'bear'
        : ut && ut.value > 0
          ? 'bull'
          : ut && ut.value < 0
            ? 'bear'
            : 'neutral'

  const sessTag = profile ? profile.labelJa : ''
  let label = 'APEX 待機'
  if (action === 'LONG') label = `APEX ロング · ${sessTag || 'UT×SSL'}`
  else if (action === 'SHORT') label = `APEX ショート · ${sessTag || 'UT×SSL'}`
  else if (!newsOk) label = `ニュース回避 (${news!.label})`
  else if (!spreadOk) label = 'スプレッド拡大'
  else if (!windowOk) label = `${windowName}外`
  else if (!(utFlipLong || utFlipShort)) label = 'UT Bot待ち'
  else if (requireEma && ((utFlipLong && !emaLong) || (utFlipShort && !emaShort)))
    label = 'EMA不一致'
  else label = 'SSL未一致'

  return {
    score,
    bias,
    label,
    signals,
    action,
    gates,
    atr: atrVal,
    stopDistance: slPips * pip,
    takeProfitDistance: tpPips * pip,
    sessionOpen: windowOk,
    spreadPips,
    newsLabel: news?.label ?? null,
    family: APEX_PARAMS.family,
    setup,
    session: fxSession,
    sessionLabel: profile ? `${profile.labelJa} (${profile.jst})` : null,
  }
}
