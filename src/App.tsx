import { useEffect, useMemo, useRef, useState } from 'react'
import { NewsPanel } from './components/NewsPanel'
import { PriceChart, type OverlayId } from './components/PriceChart'
import { RulesPanel } from './components/RulesPanel'
import { SessionStatsPanel } from './components/SessionStatsPanel'
import { SimpleBoard } from './components/SimpleBoard'
import type { FxSession } from './lib/apex'
import { fetchLiveCandles } from './lib/liveRates'
import { advanceCandle, generateCandles, type Candle } from './lib/marketData'
import {
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
  cancelOpen,
  clearSessionStats,
  closeTradeWithSlip,
  loadSessionStats,
  openTrade,
  toggleSessionDisabled,
  type SessionStatsState,
} from './lib/sessionStats'
import { evaluateSimple, SIMPLE } from './lib/simpleSignal'
import {
  announceEntry,
  getVoicePrefs,
  isVoiceUnlocked,
  requestNotifyPermission,
  setEntrySoundOn,
  setRateVoiceOn,
  speakRate,
  unlockAudio,
} from './lib/voice'
import './App.css'

const OVERLAYS: { id: OverlayId; label: string }[] = [
  { id: 'ema', label: 'EMA' },
  { id: 'bb', label: 'BB' },
]

export default function App() {
  const [pairId, setPairId] = useState<PairId>('USDJPY')
  const [timeframe, setTimeframe] = useState<Timeframe>('1m')
  const [overlays, setOverlays] = useState<OverlayId[]>(['ema'])
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
  const [stats, setStats] = useState<SessionStatsState>(() => loadSessionStats())
  const [statsRange, setStatsRange] = useState<14 | 0>(14)
  const [slipInput, setSlipInput] = useState('0.2')
  const [otherPnl, setOtherPnl] = useState('')
  const lastSpokenBar = useRef<number | null>(null)
  const lastEntryKey = useRef<string | null>(null)

  const pair = getPair(pairId)
  const inPosition = !!stats.open

  useEffect(() => {
    const id = window.setTimeout(() => setBooted(true), 40)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined

    async function load(initial: boolean) {
      if (initial) setLiveLoading(true)
      try {
        const live = await fetchLiveCandles(pairId, timeframe)
        if (cancelled) return
        if (live.candles.length >= 30) {
          setCandles(live.candles)
          setLiveSource(live.source)
          setLiveError(null)
        } else throw new Error('足が足りません')
      } catch (e) {
        if (cancelled) return
        setLiveError(e instanceof Error ? e.message : '取得失敗')
        setLiveSource(null)
        if (initial) {
          setCandles(
            generateCandles(pair, timeframe, timeframe === '1m' ? 320 : 240),
          )
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

  useEffect(() => {
    if (liveSource) return
    const id = window.setInterval(() => {
      setCandles((prev) => advanceCandle(prev, pair, timeframe))
    }, 900)
    return () => window.clearInterval(id)
  }, [pair, timeframe, liveSource])

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

  const raw = useMemo(
    () => evaluateSimple(candles, pair, stats.disabledSessions),
    [candles, pair, stats.disabledSessions],
  )
  const signal = useMemo(() => {
    if (!inPosition) return raw
    return {
      ...raw,
      action: 'WAIT' as const,
      label: 'WAIT',
      reason: '建玉中 · 新規サイン無視',
    }
  }, [raw, inPosition])

  function handleEntry() {
    if (raw.action !== 'BUY' && raw.action !== 'SELL') return
    if (!raw.session) return
    const expected = Number(bid)
    if (!Number.isFinite(expected)) return
    setStats((s) =>
      openTrade(s, {
        session: raw.session as FxSession,
        side: raw.action as 'BUY' | 'SELL',
        expectedEntry: expected,
        pairId,
      }),
    )
  }

  function handleClose(kind: 'TP' | 'SL' | 'OTHER') {
    const slip = Math.max(0, Number(slipInput) || 0)
    let pnl =
      kind === 'TP' ? SIMPLE.tpPips : kind === 'SL' ? -SIMPLE.slPips : Number(otherPnl)
    if (kind === 'OTHER' && !Number.isFinite(pnl)) return
    // Adverse slip reduces net for winners / worsens losers slightly on entry
    if (kind === 'TP') pnl = Math.max(0, pnl - slip)
    if (kind === 'SL') pnl = pnl - slip
    setStats((s) =>
      closeTradeWithSlip(s, {
        exit: kind,
        pnlPips: Math.round(pnl * 10) / 10,
        slipPips: slip,
      }),
    )
    setOtherPnl('')
  }

  const first = candles[0]
  const last = candles[candles.length - 1]
  const change = last && first ? last.close - first.close : 0
  const changePct = last && first ? (change / first.close) * 100 : 0
  const bid = last ? last.close.toFixed(pair.digits) : '—'

  useEffect(() => {
    if (!last || !voiceOn) return
    const bar = last.time
    if (!inPosition && (raw.action === 'BUY' || raw.action === 'SELL')) {
      const key = `${bar}-${raw.action}`
      if (lastEntryKey.current !== key) {
        lastEntryKey.current = key
        lastSpokenBar.current = bar
        announceEntry(raw.action === 'BUY' ? 'LONG' : 'SHORT', bid, {
          sl: SIMPLE.slPips,
          tp: SIMPLE.tpPips,
          unit: unitLabel(pair),
          session: raw.sessionLabel ?? undefined,
        })
      }
      return
    }
    if (lastSpokenBar.current !== bar) {
      lastSpokenBar.current = bar
      speakRate(
        pair.label,
        bid,
        raw.action === 'BUY' ? 'LONG' : raw.action === 'SELL' ? 'SHORT' : 'WAIT',
      )
    }
  }, [last, bid, raw.action, raw.sessionLabel, pair, voiceOn, inPosition])

  async function handleUnlockVoice() {
    unlockAudio()
    setVoiceOn(true)
    await requestNotifyPermission()
    const prefs = getVoicePrefs()
    setRateVoice(prefs.rateVoiceOn)
    setEntrySound(prefs.entrySoundOn)
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
          <p className="tagline">
            {SIMPLE.stack} · 手動サイン · SL{SIMPLE.slPips}/TP{SIMPLE.tpPips}
          </p>
        </div>

        <div className="controls" role="toolbar" aria-label="設定">
          <label className="control">
            <span>銘柄</span>
            <select
              value={pairId}
              onChange={(e) => {
                setPairId(e.target.value as PairId)
                setStats((s) => cancelOpen(s))
              }}
            >
              <optgroup label="FX">
                {PAIRS.filter((p) => p.kind === 'fx').map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
              <optgroup label="その他">
                {PAIRS.filter((p) => p.kind !== 'fx').map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>

          <div className="segmented" role="group" aria-label="時間足">
            {TIMEFRAMES.filter((t) => t.id === '1m' || t.id === '5m').map((tf) => (
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

          <div className="segmented overlays" role="group" aria-label="表示">
            {OVERLAYS.map((o) => (
              <button
                key={o.id}
                type="button"
                className={overlays.includes(o.id) ? 'active' : ''}
                onClick={() =>
                  setOverlays((prev) =>
                    prev.includes(o.id)
                      ? prev.filter((x) => x !== o.id)
                      : [...prev, o.id],
                  )
                }
              >
                {o.label}
              </button>
            ))}
          </div>

          <div className="voice-controls" role="group" aria-label="ポジション">
            {!inPosition ? (
              <button
                type="button"
                className="voice-btn primary"
                disabled={raw.action === 'WAIT' || !raw.session}
                onClick={handleEntry}
              >
                エントリーした
              </button>
            ) : (
              <span className="voice-btn active">建玉中 → 右の成績で決済</span>
            )}
            {!isVoiceUnlocked() && !voiceOn ? (
              <button
                type="button"
                className="voice-btn"
                onClick={() => void handleUnlockVoice()}
              >
                音声オン
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className={`voice-btn ${rateVoice ? 'active' : ''}`}
                  onClick={() => {
                    const n = !rateVoice
                    setRateVoice(n)
                    setRateVoiceOn(n)
                  }}
                >
                  読上
                </button>
                <button
                  type="button"
                  className={`voice-btn ${entrySound ? 'active' : ''}`}
                  onClick={() => {
                    const n = !entrySound
                    setEntrySound(n)
                    setEntrySoundOn(n)
                  }}
                >
                  音
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
                {timeframe} · {SIMPLE.stack}
              </span>
            </h1>
            <p className="sample-note">
              {sourceLabel}
              {signal.sessionLabel ? ` · ${signal.sessionLabel}` : ' · セッション外'}
              {' · '}BUY/SELLのみ · 1本
            </p>
          </div>
          <PriceChart candles={candles} pair={pair} overlays={overlays} />
        </section>

        <div className="side-stack">
          <SimpleBoard
            signal={signal}
            bid={bid}
            change={change}
            changePct={changePct}
            pair={pair}
            inPosition={inPosition}
          />
          <SessionStatsPanel
            stats={stats}
            rangeDays={statsRange}
            onRange={setStatsRange}
            onToggleSession={(s) => setStats((st) => toggleSessionDisabled(st, s))}
            onClear={() => {
              if (window.confirm('成績記録をすべて消しますか？')) {
                setStats(clearSessionStats())
              }
            }}
            slipInput={slipInput}
            onSlipInput={setSlipInput}
            onClose={handleClose}
            otherPnl={otherPnl}
            onOtherPnl={setOtherPnl}
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
