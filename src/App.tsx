import { useEffect, useMemo, useState } from 'react'
import { PriceChart, type OverlayId } from './components/PriceChart'
import { SignalRail } from './components/SignalRail'
import { evaluateApex } from './lib/apex'
import { advanceCandle, generateCandles, type Candle } from './lib/marketData'
import { getPair, PAIRS, TIMEFRAMES, type PairId, type Timeframe } from './lib/pairs'
import './App.css'

const OVERLAYS: { id: OverlayId; label: string }[] = [
  { id: 'ema', label: 'EMA' },
  { id: 'bb', label: 'BB' },
  { id: 'macd', label: 'MACD' },
  { id: 'rsi', label: 'RSI' },
]

export default function App() {
  const [pairId, setPairId] = useState<PairId>('USDJPY')
  const [timeframe, setTimeframe] = useState<Timeframe>('1m')
  const [overlays, setOverlays] = useState<OverlayId[]>(['ema', 'bb'])
  const [candles, setCandles] = useState<Candle[]>(() =>
    generateCandles(getPair('USDJPY'), '1m', 320),
  )
  const [booted, setBooted] = useState(false)

  const pair = getPair(pairId)

  useEffect(() => {
    setCandles(generateCandles(pair, timeframe, timeframe === '1m' ? 320 : 240))
  }, [pair, timeframe])

  useEffect(() => {
    const id = window.setTimeout(() => setBooted(true), 40)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => {
      setCandles((prev) => advanceCandle(prev, pair, timeframe))
    }, 900)
    return () => window.clearInterval(id)
  }, [pair, timeframe])

  const edge = useMemo(() => evaluateApex(candles), [candles])

  const first = candles[0]
  const last = candles[candles.length - 1]
  const change = last && first ? last.close - first.close : 0
  const changePct = last && first ? (change / first.close) * 100 : 0
  const bid = last ? last.close.toFixed(pair.digits) : '—'

  function toggleOverlay(id: OverlayId) {
    setOverlays((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (id === 'macd') return [...prev.filter((x) => x !== 'rsi'), id]
      if (id === 'rsi') return [...prev.filter((x) => x !== 'macd'), id]
      return [...prev, id]
    })
  }

  return (
    <div className={`app ${booted ? 'is-ready' : ''}`}>
      <div className="atmosphere" aria-hidden />
      <div className="tide" aria-hidden />

      <header className="topbar">
        <div className="brand-block">
          <p className="brand">KEHAI</p>
          <p className="tagline">UT Bot × SSL — TV有名スタック</p>
        </div>

        <div className="controls" role="toolbar" aria-label="チャート設定">
          <label className="control">
            <span>通貨ペア</span>
            <select
              value={pairId}
              onChange={(e) => setPairId(e.target.value as PairId)}
            >
              {PAIRS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <div className="segmented" role="group" aria-label="時間足">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.id}
                type="button"
                className={timeframe === tf.id ? 'active' : ''}
                onClick={() => setTimeframe(tf.id)}
              >
                {tf.label}
              </button>
            ))}
          </div>

          <div className="segmented overlays" role="group" aria-label="インジケータ">
            {OVERLAYS.map((o) => (
              <button
                key={o.id}
                type="button"
                className={overlays.includes(o.id) ? 'active' : ''}
                onClick={() => toggleOverlay(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="workspace">
        <section className="hero-chart">
          <div className="chart-meta">
            <h1>
              {pair.label}
              <span className="tf-chip">
                {TIMEFRAMES.find((t) => t.id === timeframe)?.label} · Apex
              </span>
            </h1>
            <p className="sample-note">
              サンプル気配 · UT Bot×SSL（London Mid / VWAP / スプレッド0.2p / 固定2.5·5p）· 実口座API未接続
            </p>
          </div>
          <PriceChart candles={candles} pair={pair} overlays={overlays} />
        </section>

        <SignalRail
          edge={edge}
          bid={bid}
          change={change}
          changePct={changePct}
          digits={pair.digits}
        />
      </main>
    </div>
  )
}
