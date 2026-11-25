import { useEffect, useMemo, useRef, useState } from 'react'
import { NewsPanel } from './components/NewsPanel'
import { PriceChart, type OverlayId } from './components/PriceChart'
import { RulesPanel } from './components/RulesPanel'
import { SignalRail } from './components/SignalRail'
import { evaluateApex } from './lib/apex'
import { fetchLiveCandles } from './lib/liveRates'
import { advanceCandle, generateCandles, type Candle } from './lib/marketData'
import {
  fetchCalendarEvents,
  fetchHeadlines,
  type CalendarEvent,
  type Headline,
} from './lib/newsFeed'
import { getPair, PAIRS, TIMEFRAMES, type PairId, type Timeframe } from './lib/pairs'
import {
  announceEntry,
  getVoicePrefs,
  isVoiceUnlocked,
  setEntrySoundOn,
  setRateVoiceOn,
  speakRate,
  unlockAudio,
} from './lib/voice'
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
  const [liveSource, setLiveSource] = useState<string | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [liveLoading, setLiveLoading] = useState(false)
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [headlines, setHeadlines] = useState<Headline[]>([])
  const [newsLoading, setNewsLoading] = useState(false)
  const [newsError, setNewsError] = useState<string | null>(null)
  const [voiceOn, setVoiceOn] = useState(false)
  const [rateVoice, setRateVoice] = useState(true)
  const [entrySound, setEntrySound] = useState(true)
  const lastSpokenBar = useRef<number | null>(null)
  const lastEntryKey = useRef<string | null>(null)

  const pair = getPair(pairId)

  useEffect(() => {
    const id = window.setTimeout(() => setBooted(true), 40)
    return () => window.clearTimeout(id)
  }, [])

  // Live Yahoo candles — poll every 30s; fallback to synthetic on failure
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    async function load(initial: boolean) {
      if (initial) setLiveLoading(true)
      try {
        const { candles: live, source } = await fetchLiveCandles(pairId, timeframe)
        if (cancelled) return
        if (live.length >= 30) {
          setCandles(live)
          setLiveSource(source)
          setLiveError(null)
        } else {
          throw new Error('足が足りません')
        }
      } catch (e) {
        if (cancelled) return
        setLiveError(e instanceof Error ? e.message : '取得失敗')
        setLiveSource(null)
        if (initial) {
          setCandles(generateCandles(pair, timeframe, timeframe === '1m' ? 320 : 240))
        }
      } finally {
        if (!cancelled && initial) setLiveLoading(false)
      }
    }

    void load(true)
    timer = window.setInterval(() => void load(false), 30_000)
    return () => {
      cancelled = true
      if (timer) window.clearInterval(timer)
    }
  }, [pairId, timeframe, pair])

  // Soft tick only when live feed is down (keeps demo alive)
  useEffect(() => {
    if (liveSource) return
    const id = window.setInterval(() => {
      setCandles((prev) => advanceCandle(prev, pair, timeframe))
    }, 900)
    return () => window.clearInterval(id)
  }, [pair, timeframe, liveSource])

  // News / speeches
  useEffect(() => {
    let cancelled = false
    async function loadNews() {
      setNewsLoading(true)
      setNewsError(null)
      try {
        const [cal, head] = await Promise.all([
          fetchCalendarEvents().catch((e) => {
            throw e
          }),
          fetchHeadlines().catch(() => [] as Headline[]),
        ])
        if (cancelled) return
        setEvents(cal)
        setHeadlines(head)
      } catch (e) {
        if (cancelled) return
        setNewsError(e instanceof Error ? e.message : 'ニュース取得失敗')
      } finally {
        if (!cancelled) setNewsLoading(false)
      }
    }
    void loadNews()
    const id = window.setInterval(() => void loadNews(), 5 * 60_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [])

  const edge = useMemo(() => evaluateApex(candles), [candles])

  const first = candles[0]
  const last = candles[candles.length - 1]
  const change = last && first ? last.close - first.close : 0
  const changePct = last && first ? (change / first.close) * 100 : 0
  const bid = last ? last.close.toFixed(pair.digits) : '—'

  // 1-minute rate TTS + entry beep/announce
  useEffect(() => {
    if (!last || !voiceOn) return
    const bar = last.time
    if (edge.action === 'LONG' || edge.action === 'SHORT') {
      const action = edge.action
      const key = `${bar}-${action}`
      if (lastEntryKey.current !== key) {
        lastEntryKey.current = key
        lastSpokenBar.current = bar
        announceEntry(action, bid)
      }
      return
    }
    if (lastSpokenBar.current !== bar) {
      lastSpokenBar.current = bar
      speakRate(pair.label, bid, edge.action)
    }
  }, [last, bid, edge.action, pair.label, voiceOn])

  function toggleOverlay(id: OverlayId) {
    setOverlays((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (id === 'macd') return [...prev.filter((x) => x !== 'rsi'), id]
      if (id === 'rsi') return [...prev.filter((x) => x !== 'macd'), id]
      return [...prev, id]
    })
  }

  function handleUnlockVoice() {
    unlockAudio()
    setVoiceOn(true)
    const prefs = getVoicePrefs()
    setRateVoice(prefs.rateVoiceOn)
    setEntrySound(prefs.entrySoundOn)
  }

  function toggleRateVoice() {
    const next = !rateVoice
    setRateVoice(next)
    setRateVoiceOn(next)
  }

  function toggleEntrySound() {
    const next = !entrySound
    setEntrySound(next)
    setEntrySoundOn(next)
  }

  const sourceLabel = liveSource
    ? `ライブ ${liveSource}`
    : liveLoading
      ? 'レート取得中…'
      : liveError
        ? `フォールバック（${liveError}）`
        : 'サンプル気配'

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

          <div className="voice-controls" role="group" aria-label="音声">
            {!isVoiceUnlocked() && !voiceOn ? (
              <button type="button" className="voice-btn primary" onClick={handleUnlockVoice}>
                音声オン
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={`voice-btn ${rateVoice ? 'active' : ''}`}
                  onClick={toggleRateVoice}
                >
                  1分読上
                </button>
                <button
                  type="button"
                  className={`voice-btn ${entrySound ? 'active' : ''}`}
                  onClick={toggleEntrySound}
                >
                  エントリー音
                </button>
              </>
            )}
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
              {sourceLabel} · UT Bot×SSL（London Mid / VWAP / スプレッド0.2p / SL2.5·TP5p）
            </p>
          </div>
          <PriceChart candles={candles} pair={pair} overlays={overlays} />
        </section>

        <div className="side-stack">
          <SignalRail
            edge={edge}
            bid={bid}
            change={change}
            changePct={changePct}
            digits={pair.digits}
          />
          <RulesPanel />
          <NewsPanel
            events={events}
            headlines={headlines}
            loading={newsLoading}
            error={newsError}
          />
        </div>
      </main>
    </div>
  )
}
