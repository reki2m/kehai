import { useEffect, useMemo, useRef, useState } from 'react'
import { NewsPanel } from './components/NewsPanel'
import { RulesPanel } from './components/RulesPanel'
import { SessionStatsPanel } from './components/SessionStatsPanel'
import { SimpleBoard } from './components/SimpleBoard'
import type { FxSession } from './lib/apex'
import {
  applyLiveTick,
  fetchLiveCandles,
  fetchLiveTick,
} from './lib/liveRates'
import type { Candle } from './lib/marketData'
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
  announceEventResult,
  announceEventWarning,
  announceHeadline,
  announceReady,
  announceSpeech,
  announceUpcomingBrief,
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

export default function App() {
  const [pairId, setPairId] = useState<PairId>('USDJPY')
  const [timeframe, setTimeframe] = useState<Timeframe>('1m')
  const [candles, setCandles] = useState<Candle[]>([])
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
  const [stats, setStats] = useState<SessionStatsState>(() => loadSessionStats())
  const [statsRange, setStatsRange] = useState<14 | 0>(14)
  const [slipInput, setSlipInput] = useState('0.2')
  const [otherPnl, setOtherPnl] = useState('')
  const lastSpokenBar = useRef<number | null>(null)
  const lastEntryKey = useRef<string | null>(null)
  const lastReadyKey = useRef<string | null>(null)
  const warnedEvents = useRef<Set<string>>(new Set())
  const spokenResults = useRef<Set<string>>(new Set())
  const spokenHeadlines = useRef<Set<string>>(new Set())
  const spokenSpeeches = useRef<Set<string>>(new Set())
  const briefDone = useRef(false)

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
        // Do not paint fake 151-yen sample as if it were live.
        if (initial) setCandles([])
      } finally {
        if (!cancelled && initial) setLiveLoading(false)
      }
    }

    void load(true)
    // History refresh (Actions snapshot) — CDN/cron can be slow
    timer = window.setInterval(() => void load(false), 60_000)
    return () => {
      cancelled = true
      if (timer) window.clearInterval(timer)
    }
  }, [pairId, timeframe, pair])

  // Live tick ~1s — scalp needs sub-10s movement
  useEffect(() => {
    let cancelled = false
    let inFlight = false
    async function tick() {
      if (inFlight) return
      inFlight = true
      try {
        const px = await fetchLiveTick(pairId)
        if (cancelled || px == null) return
        setCandles((prev) => {
          if (prev.length < 30) return prev
          return applyLiveTick(prev, px, timeframe)
        })
        setLiveSource('ライブ 約1秒更新')
        setLiveError(null)
      } catch {
        /* keep chart; history still shown */
      } finally {
        inFlight = false
      }
    }
    void tick()
    const id = window.setInterval(() => void tick(), 1_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [pairId, timeframe])

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
  const mid = last ? last.close : NaN
  const halfSpread = ((raw.spreadPips || 0.2) * pair.pip) / 2
  const bidNum = Number.isFinite(mid) ? mid - halfSpread : NaN
  const askNum = Number.isFinite(mid) ? mid + halfSpread : NaN
  const bid = Number.isFinite(bidNum) ? bidNum.toFixed(pair.digits) : '—'
  const ask = Number.isFinite(askNum) ? askNum.toFixed(pair.digits) : '—'
  const midText = Number.isFinite(mid) ? mid.toFixed(pair.digits) : '—'

  // Entry / READY alerts on signal change
  useEffect(() => {
    if (!last || !voiceOn) return
    const bar = last.time
    if (!inPosition && (raw.action === 'BUY' || raw.action === 'SELL')) {
      const key = `${bar}-${raw.action}`
      if (lastEntryKey.current !== key) {
        lastEntryKey.current = key
        announceEntry(raw.action === 'BUY' ? 'LONG' : 'SHORT', midText, {
          sl: SIMPLE.slPips,
          tp: SIMPLE.tpPips,
          unit: unitLabel(pair),
          session: raw.sessionLabel ?? undefined,
        })
      }
      return
    }
    if (
      !inPosition &&
      (raw.action === 'READY_BUY' || raw.action === 'READY_SELL')
    ) {
      const side = raw.action === 'READY_BUY' ? 'BUY' : 'SELL'
      const key = `${side}-${Math.floor(bar / 180)}`
      if (lastReadyKey.current !== key) {
        lastReadyKey.current = key
        announceReady(side, raw.trailDistancePips)
      }
    }
  }, [
    last,
    midText,
    raw.action,
    raw.sessionLabel,
    raw.trailDistancePips,
    pair,
    voiceOn,
    inPosition,
  ])

  // Exactly every 1 minute: read bid / ask numbers
  useEffect(() => {
    if (!voiceOn) return
    const speakNow = () => {
      if (bid === '—' || ask === '—') return
      const rateAct =
        raw.action === 'BUY'
          ? 'LONG'
          : raw.action === 'SELL'
            ? 'SHORT'
            : raw.action === 'READY_BUY'
              ? 'READY_BUY'
              : raw.action === 'READY_SELL'
                ? 'READY_SELL'
                : 'WAIT'
      const minuteKey = Math.floor(Date.now() / 60_000)
      if (lastSpokenBar.current === minuteKey) return
      lastSpokenBar.current = minuteKey
      speakRate(pair.label, midText, rateAct, { bid, ask })
    }
    speakNow()
    const id = window.setInterval(speakNow, 60_000)
    return () => window.clearInterval(id)
  }, [voiceOn, bid, ask, midText, pair.label, raw.action, rateVoice])

  async function handleUnlockVoice() {
    unlockAudio()
    setVoiceOn(true)
    await requestNotifyPermission()
    const prefs = getVoicePrefs()
    setRateVoice(prefs.rateVoiceOn)
    setEntrySound(prefs.entrySoundOn)
    setNewsVoice(prefs.newsVoiceOn)
    setNewsVoiceOn(prefs.newsVoiceOn)
    briefDone.current = false
  }

  // 指標5分前・結果・要人・新着ニュースの読み上げ
  useEffect(() => {
    if (!voiceOn || !newsVoice) return
    const now = Date.now() / 1000

    const due = eventsDueSoon(events, now, 5 * 60, 3)
    for (const e of due) {
      if (warnedEvents.current.has(e.id)) continue
      warnedEvents.current.add(e.id)
      announceEventWarning(e, (e.time - now) / 60)
      setAlertIds((prev) => new Set(prev).add(e.id))
    }

    for (const e of events) {
      if (!e.actual) continue
      const key = `${e.id}|${e.actual}`
      if (spokenResults.current.has(key)) continue
      // only announce if event is recent (within 2h)
      if (e.time < now - 2 * 3600 || e.time > now + 60) continue
      spokenResults.current.add(key)
      announceEventResult(e)
    }

    for (const e of events) {
      if (e.kind !== 'speech') continue
      if (e.importance < 3) continue
      if (spokenSpeeches.current.has(e.id)) continue
      const mins = (e.time - now) / 60
      // announce once when within 60 minutes (or just started)
      if (mins > 60 || mins < -15) continue
      spokenSpeeches.current.add(e.id)
      announceSpeech(e, mins)
    }

    // New headlines (skip first paint flood — mark existing, then speak new)
    if (spokenHeadlines.current.size === 0 && headlines.length > 0) {
      for (const h of headlines.slice(0, 12)) spokenHeadlines.current.add(h.id)
    } else {
      for (const h of headlines.slice(0, 8)) {
        if (spokenHeadlines.current.has(h.id)) continue
        spokenHeadlines.current.add(h.id)
        announceHeadline(h.title)
        break // one at a time
      }
    }

    if (!briefDone.current && events.length > 0) {
      const upcoming = events
        .filter((e) => e.importance >= 4 && e.time >= now - 60 && e.time <= now + 6 * 3600)
        .slice(0, 4)
      if (upcoming.length) {
        briefDone.current = true
        window.setTimeout(() => announceUpcomingBrief(upcoming), 2500)
      } else {
        briefDone.current = true
      }
    }
  }, [events, headlines, voiceOn, newsVoice])

  const sourceLabel = liveSource
    ? `ライブ ${liveSource}`
    : liveLoading
      ? 'レート取得中…'
      : liveError
        ? `レート取得失敗（${liveError}）· 再読み込みしてください`
        : 'レート待機中'

  return (
    <div className={`app ${booted ? 'is-ready' : ''}`}>
      <div className="atmosphere" aria-hidden />
      <div className="tide" aria-hidden />

      <header className="topbar">
        <div className="brand-block">
          <p className="brand">KEHAI</p>
          <p className="tagline">
            {SIMPLE.stack} · GMO併用サイン · SL{SIMPLE.slPips}/TP{SIMPLE.tpPips}
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


          <div className="voice-controls" role="group" aria-label="ポジション">
            {!inPosition ? (
              <button
                type="button"
                className="voice-btn primary"
                disabled={
                  (raw.action !== 'BUY' && raw.action !== 'SELL') || !raw.session
                }
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
                <button
                  type="button"
                  className={`voice-btn ${newsVoice ? 'active' : ''}`}
                  onClick={() => {
                    const n = !newsVoice
                    setNewsVoice(n)
                    setNewsVoiceOn(n)
                  }}
                >
                  ニュース
                </button>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="workspace workspace-signal">
        <section className="hero-signal">
          <div className="chart-meta">
            <h1>
              {pair.label}
              <span className="tf-chip">
                {timeframe} · {SIMPLE.stack}
              </span>
            </h1>
            <p className="sample-note">
              レート・チャートはGMOで見る · ここはBUY/SELLサインと読み上げ
              {signal.sessionLabel ? ` · ${signal.sessionLabel}` : ' · セッション外'}
            </p>
            <p className="sample-note">
              参考フィード {sourceLabel}
              {liveError ? ` · ${liveError}` : ''}
            </p>
          </div>
          <SimpleBoard
            signal={signal}
            bid={bid}
            ask={ask}
            mid={midText}
            change={change}
            changePct={changePct}
            pair={pair}
            inPosition={inPosition}
          />
        </section>

        <div className="side-stack">
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
            alertIds={alertIds}
          />
        </div>
      </main>
    </div>
  )
}
