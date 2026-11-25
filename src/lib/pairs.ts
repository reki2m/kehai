export type PairId =
  | 'USDJPY'
  | 'EURUSD'
  | 'GBPJPY'
  | 'EURJPY'
  | 'AUDUSD'
  | 'USDCHF'
  | 'USOIL'
  | 'NIKKEI'
  | 'DOW'
  | 'VIX'

export type AssetKind = 'fx' | 'energy' | 'index' | 'vol'

export type Timeframe = '1m' | '5m' | '15m' | '1H' | '4H' | '1D'

export interface PairMeta {
  id: PairId
  label: string
  base: string
  quote: string
  kind: AssetKind
  /** Minimum price increment (1 pip / 1 pt). */
  pip: number
  digits: number
  /** Stop / take in pip (or point) units. */
  sl: number
  tp: number
  unit: 'pips' | 'pts'
  seed: number
  open: number
  /** Synthetic series relative volatility hint. */
  volFrac: number
}

export const PAIRS: PairMeta[] = [
  {
    id: 'USDJPY',
    label: 'USD/JPY',
    base: 'USD',
    quote: 'JPY',
    kind: 'fx',
    pip: 0.01,
    digits: 3,
    sl: 2.5,
    tp: 5.0,
    unit: 'pips',
    seed: 1542,
    open: 151.25,
    volFrac: 0.00035,
  },
  {
    id: 'EURUSD',
    label: 'EUR/USD',
    base: 'EUR',
    quote: 'USD',
    kind: 'fx',
    pip: 0.0001,
    digits: 5,
    sl: 2.5,
    tp: 5.0,
    unit: 'pips',
    seed: 8831,
    open: 1.0842,
    volFrac: 0.00055,
  },
  {
    id: 'GBPJPY',
    label: 'GBP/JPY',
    base: 'GBP',
    quote: 'JPY',
    kind: 'fx',
    pip: 0.01,
    digits: 3,
    sl: 2.5,
    tp: 5.0,
    unit: 'pips',
    seed: 2204,
    open: 191.48,
    volFrac: 0.0004,
  },
  {
    id: 'EURJPY',
    label: 'EUR/JPY',
    base: 'EUR',
    quote: 'JPY',
    kind: 'fx',
    pip: 0.01,
    digits: 3,
    sl: 2.5,
    tp: 5.0,
    unit: 'pips',
    seed: 6677,
    open: 164.12,
    volFrac: 0.00038,
  },
  {
    id: 'AUDUSD',
    label: 'AUD/USD',
    base: 'AUD',
    quote: 'USD',
    kind: 'fx',
    pip: 0.0001,
    digits: 5,
    sl: 2.5,
    tp: 5.0,
    unit: 'pips',
    seed: 4410,
    open: 0.6528,
    volFrac: 0.00055,
  },
  {
    id: 'USDCHF',
    label: 'USD/CHF',
    base: 'USD',
    quote: 'CHF',
    kind: 'fx',
    pip: 0.0001,
    digits: 5,
    sl: 2.5,
    tp: 5.0,
    unit: 'pips',
    seed: 9912,
    open: 0.8745,
    volFrac: 0.0005,
  },
  {
    id: 'USOIL',
    label: '原油 WTI',
    base: 'CL',
    quote: 'USD',
    kind: 'energy',
    pip: 0.01,
    digits: 2,
    sl: 8,
    tp: 16,
    unit: 'pts',
    seed: 7103,
    open: 78.5,
    volFrac: 0.0045,
  },
  {
    id: 'NIKKEI',
    label: '日経先物',
    base: 'NK',
    quote: 'JPY',
    kind: 'index',
    pip: 5,
    digits: 0,
    sl: 40,
    tp: 80,
    unit: 'pts',
    seed: 3344,
    open: 39000,
    volFrac: 0.0012,
  },
  {
    id: 'DOW',
    label: 'ダウ先物',
    base: 'YM',
    quote: 'USD',
    kind: 'index',
    pip: 1,
    digits: 0,
    sl: 20,
    tp: 40,
    unit: 'pts',
    seed: 5566,
    open: 42500,
    volFrac: 0.001,
  },
  {
    id: 'VIX',
    label: '恐怖指数 VIX',
    base: 'VIX',
    quote: 'IDX',
    kind: 'vol',
    pip: 0.01,
    digits: 2,
    sl: 25,
    tp: 50,
    unit: 'pts',
    seed: 8890,
    open: 18.5,
    volFrac: 0.012,
  },
]

export const TIMEFRAMES: { id: Timeframe; label: string; seconds: number }[] = [
  { id: '1m', label: '1分', seconds: 60 },
  { id: '5m', label: '5分', seconds: 300 },
  { id: '15m', label: '15分', seconds: 900 },
  { id: '1H', label: '1時間', seconds: 3600 },
  { id: '4H', label: '4時間', seconds: 14400 },
  { id: '1D', label: '日足', seconds: 86400 },
]

export function getPair(id: PairId): PairMeta {
  return PAIRS.find((p) => p.id === id) ?? PAIRS[0]
}

export function unitLabel(pair: PairMeta): string {
  return pair.unit === 'pips' ? 'ピプス' : 'ポイント'
}
