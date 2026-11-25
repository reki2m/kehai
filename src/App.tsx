import { useEffect, useMemo, useRef, useState } from 'react'
import { ImpactPanel } from './components/ImpactPanel'
import { NewsPanel } from './components/NewsPanel'
import { PriceChart, type OverlayId } from './components/PriceChart'
import { RulesPanel } from './components/RulesPanel'
import { SignalRail } from './components/SignalRail'
import { fetchLiveCandles } from './lib/liveRates'
import { advanceCandle, generateCandles, type Candle } from './lib/marketData'
import { decideMultiTf } from './lib/multiTf'
import {
  eventsDueSoon,
  fetchCalendarEvents,
  fetchHeadlines,
  type CalendarEvent,
  type Headline,
} from './lib/newsFeed'
import {
  getPair,
  PAIRS,
  TIMEFRAMES,
  unitLabel,
  type PairId,
  type Timeframe,
} from './lib/pairs'
import {
  applyImpactGate,
  evaluateUsdJpyImpact,
  IMPACT_DRIVERS,
} from './lib/usdjpyImpact'
import {
  announceEntry,
  announceEventResult,
  announceEventWarning,
  getVoicePrefs,
  isVoiceUnlocked,
  requestNotifyPermission,
  setEntrySoundOn,
  setNewsVoiceOn,
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
  const [candles1m, setCandles1m] = useState<Candle[]>(() =>
    generateCandles(getPair('USDJPY'), '1m', 320),
  )
  const [candles5m, setCandles5m] = useState<Candle[]>(() =>
    generateCandles(getPair('USDJPY'), '5m', 240),
  )
  const [driverSeries, setDriverSeries] = useState<Partial<Record<PairId, Candle[]>>>(
    () => {
      const init: Partial<Record<PairId, Candle[]>> = {}
      for (const id of IMPACT_DRIVERS) {
        init[id] = generateCandles(getPair(id), '5m', 80)
      }
      return init
    },
  )
  const [impactLoading, setImpactLoading] = useState(false)
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
  const [newsVoice, setNewsVoice] = useState(true)
  const [alertIds, setAlertIds] = useState<Set<string>>(() => new Set())
  const lastSpokenBar = useRef<number | null>(null)
  const lastEntryKey = useRef<string | null>(null)
  const warnedIds = useRef<Set<string>>(new Set())
  const resultSpoken = useRef<Set<string>>(new Set())
  const prevActual = useRef<Map<string, string | undefined>>(new Map())

  const pair = getPair(pairId)

  useEffect(() => {
    const id = window.setTimeout(() => setBooted(true), 40)
    return () => window.clearTimeout(id)
  }, [])

  // Live Yahoo: always keep 1m + 5m for multi-TF; chart follows user TF
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    async function load(initial: boolean) {
      if (initial) setLiveLoading(true)
      try {
        const [m1, m5] = await Promise.all([
          fetchLiveCandles(pairId, '1m'),
          fetchLiveCandles(pairId, '5m'),
        ])
        if (cancelled) return
        if (m1.candles.length >= 30 && m5.candles.length >= 20) {
          setCandles1m(m1.candles)
          setCandles5m(m5.candles)
          setLiveSource(m1.source)
          setLiveError(null)
        } else {
          throw new Error('足が足りません')
        }
      } catch (e) {
        if (cancelled) return
        setLiveError(e instanceof Error ? e.message : '取得失敗')
        setLiveSource(null)
        if (initial) {
          setCandles1m(generateCandles(pair, '1m', 320))
          setCandles5m(generateCandles(pair, '5m', 240))
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
  }, [pairId, pair])

  // Related markets → USD/JPY impact (5m)
  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    async function loadDrivers(initial: boolean) {
      if (initial) setImpactLoading(true)
      const next: Partial<Record<PairId, Candle[]>> = {}
      await Promise.all(
        IMPACT_DRIVERS.map(async (id) => {
          try {
            const { candles } = await fetchLiveCandles(id, '5m')
            if (candles.length >= 20) next[id] = candles
            else next[id] = generateCandles(getPair(id), '5m', 80)
          } catch {
            next[id] = generateCandles(getPair(id), '5m', 80)
          }
        }),
      )
      if (cancelled) return
      setDriverSeries((prev) => ({ ...prev, ...next }))
      if (initial) setImpactLoading(false)
    }

    void loadDrivers(true)
    timer = window.setInterval(() => void loadDrivers(false), 60_000)
    return () => {
      cancelled = true
      if (timer) window.clearInterval(timer)
    }
  }, [])

  // Soft tick only when live feed is down
  useEffect(() => {
    if (liveSource) return
    const id = window.setInterval(() => {
      setCandles1m((prev) => advanceCandle(prev, pair, '1m'))
      setCandles5m((prev) => advanceCandle(prev, pair, '5m'))
    }, 900)
    return () => window.clearInterval(id)
  }, [pair, liveSource])

  // News / speeches
  useEffect(() => {
    let cancelled = false
    async function loadNews() {
      setNewsLoading(true)
      setNewsError(null)
      try {
        const [cal, head] = await Promise.all([
          fetchCalendarEvents(),
          fetchHeadlines().catch(() => [] as Headline[]),
        ])
        if (cancelled) return

        // Detect newly published actuals for TTS
        for (const e of cal) {
          const prev = prevActual.current.get(e.id)
          if (e.actual && e.actual !== prev && !resultSpoken.current.has(e.id)) {
            resultSpoken.current.add(e.id)
            if (voiceOn && newsVoice) announceEventResult(e)
          }
          prevActual.current.set(e.id, e.actual)
        }

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
    const id = window.setInterval(() => void loadNews(), 2 * 60_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [voiceOn, newsVoice])

  // ~5 min pre-alerts for importance >= 3
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!voiceOn || !newsVoice) return
      const due = eventsDueSoon(events, Date.now() / 1000, 5 * 60, 3)
      let changed = false
      for (const e of due) {
        if (warnedIds.current.has(e.id)) continue
        warnedIds.current.add(e.id)
        changed = true
        const mins = (e.time - Date.now() / 1000) / 60
        announceEventWarning(e, mins)
      }
      if (changed) setAlertIds(new Set(warnedIds.current))
    }, 15_000)
    return () => window.clearInterval(id)
  }, [events, voiceOn, newsVoice])

  const preferTf = timeframe === '5m' ? '5m' : timeframe === '1m' ? '1m' : undefined
  const multi = useMemo(
    () => decideMultiTf(candles1m, candles5m, preferTf, pair),
    [candles1m, candles5m, preferTf, pair],
  )
  const impact = useMemo(() => evaluateUsdJpyImpact(driverSeries, 12), [driverSeries])
  const edge = useMemo(() => {
    if (pairId !== 'USDJPY') return multi.edge
    return applyImpactGate(multi.edge, impact)
  }, [multi.edge, impact, pairId])

  // Chart follows multi-TF winner (1m/5m Apex stack)
  const chartTf: Timeframe = multi.activeTf
  const candles = multi.activeTf === '5m' ? candles5m : candles1m

  const first = candles[0]
  const last = candles[candles.length - 1]
  const change = last && first ? last.close - first.close : 0
  const changePct = last && first ? (change / first.close) * 100 : 0
  const bid = last ? last.close.toFixed(pair.digits) : '—'

  // Rate TTS + entry (on active TF bar)
  useEffect(() => {
    if (!last || !voiceOn) return
    const bar = last.time
    if (edge.action === 'LONG' || edge.action === 'SHORT') {
      const action = edge.action
      const key = `${multi.activeTf}-${bar}-${action}`
      if (lastEntryKey.current !== key) {
        lastEntryKey.current = key
        lastSpokenBar.current = bar
        announceEntry(action, bid, {
          sl: Number((edge.stopDistance / pair.pip).toFixed(1)),
          tp: Number((edge.takeProfitDistance / pair.pip).toFixed(1)),
          unit: unitLabel(pair),
          session: edge.sessionLabel ?? undefined,
        })
      }
      return
    }
    if (lastSpokenBar.current !== bar) {
      lastSpokenBar.current = bar
      speakRate(pair.label, bid, edge.action)
    }
  }, [last, bid, edge.action, pair, voiceOn, multi.activeTf])

  function toggleOverlay(id: OverlayId) {
    setOverlays((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id)
      if (id === 'macd') return [...prev.filter((x) => x !== 'rsi'), id]
      if (id === 'rsi') return [...prev.filter((x) => x !== 'macd'), id]
      return [...prev, id]
    })
  }

  async function handleUnlockVoice() {
    unlockAudio()
    setVoiceOn(true)
    await requestNotifyPermission()
    const prefs = getVoicePrefs()
    setRateVoice(prefs.rateVoiceOn)
    setEntrySound(prefs.entrySoundOn)
    setNewsVoice(prefs.newsVoiceOn)
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

  function toggleNewsVoice() {
    const next = !newsVoice
    setNewsVoice(next)
    setNewsVoiceOn(next)
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
          <p className="tagline">Triple Session — 東京 / ロンドン / NY</p>
        </div>

        <div className="controls" role="toolbar" aria-label="チャート設定">
          <label className="control">
            <span>通貨ペア</span>
            <select
              value={pairId}
              onChange={(e) => setPairId(e.target.value as PairId)}
            >
              <optgroup label="FX">
                {PAIRS.filter((p) => p.kind === 'fx').map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="コモディティ・指数">
                {PAIRS.filter((p) => p.kind !== 'fx').map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>

          <div className="segmented" role="group" aria-label="時間足">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.id}
                type="button"
                className={
                  timeframe === tf.id ||
                  ((timeframe === '1m' || timeframe === '5m') && chartTf === tf.id)
                    ? 'active'
                    : ''
                }
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
              <button type="button" className="voice-btn primary" onClick={() => void handleUnlockVoice()}>
                音声オン
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={`voice-btn ${rateVoice ? 'active' : ''}`}
                  onClick={toggleRateVoice}
                >
                  レート読上
                </button>
                <button
                  type="button"
                  className={`voice-btn ${entrySound ? 'active' : ''}`}
                  onClick={toggleEntrySound}
                >
                  エントリー音
                </button>
                <button
                  type="button"
                  className={`voice-btn ${newsVoice ? 'active' : ''}`}
                  onClick={toggleNewsVoice}
                >
                  指標通知
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
                {chartTf} · Apex · 優勢 {multi.activeTf}
              </span>
            </h1>
            <p className="sample-note">
              {sourceLabel}
              {edge.sessionLabel ? ` · ${edge.sessionLabel}` : ' · セッション外'}
              {' · '}1m/5m優勢 · ドル円インパクト · 指標1–5
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
            pair={pair}
            multi={multi}
          />
          <ImpactPanel impact={impact} loading={impactLoading} />
          <RulesPanel />
          <NewsPanel
            events={events}
            headlines={headlines}
            loading={newsLoading}
            error={newsError}
            alertIds={alertIds}
          />
        </div>
      </main>
    </div>
  )
}
