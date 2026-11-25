export type PairId =
  | 'USDJPY'
  | 'EURUSD'
  | 'GBPJPY'
  | 'EURJPY'
  | 'AUDUSD'
  | 'USDCHF'

export type Timeframe = '1m' | '5m' | '15m' | '1H' | '4H' | '1D'

export interface PairMeta {
  id: PairId
  label: string
  base: string
  quote: string
  pip: number
  digits: number
  seed: number
  open: number
}

export const PAIRS: PairMeta[] = [
  {
    id: 'USDJPY',
    label: 'USD/JPY',
    base: 'USD',
    quote: 'JPY',
    pip: 0.01,
    digits: 3,
    seed: 1542,
    open: 151.25,
  },
  {
    id: 'EURUSD',
    label: 'EUR/USD',
    base: 'EUR',
    quote: 'USD',
    pip: 0.0001,
    digits: 5,
    seed: 8831,
    open: 1.0842,
  },
  {
    id: 'GBPJPY',
    label: 'GBP/JPY',
    base: 'GBP',
    quote: 'JPY',
    pip: 0.01,
    digits: 3,
    seed: 2204,
    open: 191.48,
  },
  {
    id: 'EURJPY',
    label: 'EUR/JPY',
    base: 'EUR',
    quote: 'JPY',
    pip: 0.01,
    digits: 3,
    seed: 6677,
    open: 164.12,
  },
  {
    id: 'AUDUSD',
    label: 'AUD/USD',
    base: 'AUD',
    quote: 'USD',
    pip: 0.0001,
    digits: 5,
    seed: 4410,
    open: 0.6528,
  },
  {
    id: 'USDCHF',
    label: 'USD/CHF',
    base: 'USD',
    quote: 'CHF',
    pip: 0.0001,
    digits: 5,
    seed: 9912,
    open: 0.8745,
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
