import { useEffect, useRef } from 'react'
import type { PairId, Timeframe } from '../lib/pairs'

/** TradingView symbols — realtime feed in the browser (no API key). */
export const TV_SYMBOLS: Record<PairId, string> = {
  USDJPY: 'FX_IDC:USDJPY',
  EURUSD: 'FX_IDC:EURUSD',
  GBPJPY: 'FX_IDC:GBPJPY',
  EURJPY: 'FX_IDC:EURJPY',
  AUDUSD: 'FX_IDC:AUDUSD',
  USDCHF: 'FX_IDC:USDCHF',
  USOIL: 'TVC:USOIL',
  NIKKEI: 'OANDA:JP225USD',
  DOW: 'TVC:DJI',
  VIX: 'TVC:VIX',
}

const TV_INTERVAL: Record<Timeframe, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '1H': '60',
  '4H': '240',
  '1D': 'D',
}

declare global {
  interface Window {
    TradingView?: {
      widget: new (opts: Record<string, unknown>) => unknown
    }
  }
}

let tvScriptPromise: Promise<void> | null = null

function loadTvScript(): Promise<void> {
  if (window.TradingView) return Promise.resolve()
  if (tvScriptPromise) return tvScriptPromise
  tvScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = 'https://s3.tradingview.com/tv.js'
    s.async = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('TradingView script failed'))
    document.head.appendChild(s)
  })
  return tvScriptPromise
}

interface Props {
  pairId: PairId
  timeframe: Timeframe
}

export function TradingViewChart({ pairId, timeframe }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const idRef = useRef(`tv_${Math.random().toString(36).slice(2, 10)}`)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let cancelled = false

    host.innerHTML = ''
    const container = document.createElement('div')
    container.id = idRef.current
    container.style.width = '100%'
    container.style.height = '100%'
    host.appendChild(container)

    void loadTvScript()
      .then(() => {
        if (cancelled || !window.TradingView) return
        // eslint-disable-next-line no-new
        new window.TradingView.widget({
          autosize: true,
          symbol: TV_SYMBOLS[pairId],
          interval: TV_INTERVAL[timeframe] ?? '1',
          timezone: 'Asia/Tokyo',
          theme: 'dark',
          style: '1',
          locale: 'ja',
          toolbar_bg: '#0b1418',
          enable_publishing: false,
          hide_top_toolbar: false,
          hide_legend: false,
          save_image: false,
          container_id: idRef.current,
          backgroundColor: 'rgba(11, 20, 24, 1)',
          gridColor: 'rgba(94, 234, 212, 0.06)',
          studies: ['STD;EMA', 'STD;EMA'],
          // Realtime streaming from TradingView
          withdateranges: false,
          allow_symbol_change: false,
        })
      })
      .catch(() => {
        if (host) {
          host.innerHTML =
            '<p style="padding:1rem;color:#f07167">TradingViewチャートを読み込めませんでした</p>'
        }
      })

    return () => {
      cancelled = true
      host.innerHTML = ''
    }
  }, [pairId, timeframe])

  return (
    <div className="chart-host tv-host" ref={hostRef} aria-label="TradingViewリアルタイムチャート" />
  )
}
