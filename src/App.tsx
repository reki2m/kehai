import { useEffect, useMemo, useRef, useState } from 'react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { NewsPanel } from './components/NewsPanel'
import { PriceChart, type OverlayId } from './components/PriceChart'
import { RulesPanel } from './components/RulesPanel'
import { SessionStatsPanel } from './components/SessionStatsPanel'
import { SimpleBoard } from './components/SimpleBoard'
import type { FxSession } from './lib/apex'
import { BIQUOTE_SYMBOLS, subscribeBiquoteTicks } from './lib/biquote'
import { histCandlesUrl, histSignalsUrl } from './lib/http'
import {
  applyLiveTick,
  fetchLiveCandles,
  fetchLiveQuote,
  mergeArchiveCandles,
  mergeRemoteCandles,
  sanitizeCandles,
  type LiveQuote,
} from './lib/liveRates'
import {
  HIST_FROM_UNIX,
  listHistoricalSignals,
  mergeHistSignals,
  type HistSignal,
} from './lib/signalHistory'
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
import { investigateShockCause, type ShockCauseReport } from './lib/shockCause'
import { ShockDetector } from './lib/shockDetect'
import {
  announceBriefNow,
  announceEntry,
  announceEventResult,
  announceEventWarning,
  announceHeadline,
  announceReady,
  announceShock,
  announceSpeech,
  announceUpcomingBrief,
  getVoicePrefs,
  isVoiceUnlocked,
  requestNotifyPermission,
  setEntrySoundOn,
  setNewsVoiceOn,
  setRateVoiceOn,
  setShockAlertOn,
  setVoiceVolume,
  speakRate,
  unlockAudio,
} from './lib/voice'
import './App.css'

const OVERLAYS: { id: OverlayId; label: string }[] = [
  { id: 'ut', label: 'UT' },
  { id: 'ssl', label: 'SSL' },
  { id: 'vwap', label: 'VWAP' },
  { id: 'ema', label: 'EMA' },
  { id: 'bb', label: 'BB' },
]

export default function App() {
  const [pairId, setPairId] = useState<PairId>('USDJPY')
  const [timeframe, setTimeframe] = useState<Timeframe>('1m')
  const [overlays, setOverlays] = useState<OverlayId[]>(['ut', 'ssl', 'vwap'])
  const [candles, setCandles] = useState<Candle[]>([])
  const [archiveSignals, setArchiveSignals] = useState<HistSignal[]>([])
  const [livePrice, setLivePrice] = useState<number | null>(null)
  const [liveBid, setLiveBid] = useState<number | null>(null)
  const [liveAsk, setLiveAsk] = useState<number | null>(null)
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
  const [shockAlert, setShockAlert] = useState(true)
  const [volume, setVolume] = useState(() => getVoicePrefs().voiceVolume)
  const [shockReport, setShockReport] = useState<{
    dir: 'UP' | 'DOWN'
    pips: number
    label: string
    cause: ShockCauseReport
    until: number
  } | null>(null)
  const [alertIds, setAlertIds] = useState<Set<string>>(() => new Set())
  const [stats, setStats] = useState<SessionStatsState>(() => loadSessionStats())
  const [statsRange, setStatsRange] = useState<14 | 0>(14)
  const [slipInput, setSlipInput] = useState('0.2')
  const [otherPnl, setOtherPnl] = useState('')
  const lastSpokenBar = useRef<number | null>(null)
  const lastEntryKey = useRef<string | null>(null)
  const lastReadyKey = useRef<string | null>(null)
  const warnedEvents = useRef<Set<string>>(new Set())
  const urgentWarned = useRef<Set<string>>(new Set())
  const spokenResults = useRef<Set<string>>(new Set())
  const spokenHeadlines = useRef<Set<string>>(new Set())
  const spokenSpeeches = useRef<Set<string>>(new Set())
  const briefDone = useRef(false)
  const shockRef = useRef<ShockDetector | null>(null)
  const eventsRef = useRef<CalendarEvent[]>([])
  const headlinesRef = useRef<Headline[]>([])
  const shockClearTimer = useRef<number | null>(null)
  /** 変動読み上げ用の価格履歴 {t:ms, price} */
  const priceHistRef = useRef<{ t: number; price: number }[]>([])
  const lastFiveSpoken = useRef<number | null>(null)
  const livePriceRef = useRef<number | null>(null)

  const pair = getPair(pairId)
  const inPosition = !!stats.open

  useEffect(() => {
    eventsRef.current = events
  }, [events])
  useEffect(() => {
    headlinesRef.current = headlines
  }, [headlines])

  useEffect(() => {
    const id = window.setTimeout(() => setBooted(true), 40)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: number | undefined
    let archive: Candle[] = []

    async function loadArchive() {
      if (pairId !== 'USDJPY' || timeframe !== '1m') {
        archive = []
        setArchiveSignals([])
        return
      }
      try {
        const [barsRes, sigRes] = await Promise.all([
          fetch(histCandlesUrl(pairId, timeframe)),
          fetch(histSignalsUrl(pairId, timeframe)),
        ])
        if (barsRes.ok) {
          const data = (await barsRes.json()) as { candles?: Candle[] }
          if (data.candles?.length) {
            archive = sanitizeCandles(
              data.candles.filter((c) => c.time >= HIST_FROM_UNIX),
            )
          }
        }
        if (sigRes.ok) {
          const data = (await sigRes.json()) as { signals?: HistSignal[] }
          if (data.signals?.length && !cancelled) {
            setArchiveSignals(
              data.signals.filter((s) => s.time >= HIST_FROM_UNIX),
            )
          }
        } else if (archive.length && !cancelled) {
          setArchiveSignals(
            listHistoricalSignals(archive, pair, HIST_FROM_UNIX),
          )
        }
      } catch {
        archive = []
      }
    }

    async function load(initial: boolean) {
      if (initial) setLiveLoading(true)
      try {
        if (initial) await loadArchive()
        const live = await fetchLiveCandles(pairId, timeframe)
        if (cancelled) return
        if (live.candles.length >= 30) {
          setCandles((prev) => {
            const tip =
              initial || prev.length < 30
                ? sanitizeCandles(live.candles)
                : mergeRemoteCandles(
                    live.candles,
                    prev.length > archive.length
                      ? prev.slice(-Math.max(400, live.candles.length + 50))
                      : prev,
                    timeframe,
                    livePriceRef.current,
                  )
            if (!archive.length) return tip
            return mergeArchiveCandles(archive, tip)
          })
          if (live.lastPrice != null && livePriceRef.current == null) {
            setLivePrice(live.lastPrice)
          }
          if (initial) {
            setLiveSource(
              archive.length
                ? `${live.source} · 11月〜履歴`
                : live.source,
            )
          }
          setLiveError(null)
        } else throw new Error('足が足りません')
      } catch (e) {
        if (cancelled) return
        setLiveError(e instanceof Error ? e.message : '取得失敗')
        if (initial) {
          setLiveSource(null)
          setCandles([])
          setArchiveSignals([])
        }
      } finally {
        if (!cancelled && initial) setLiveLoading(false)
      }
    }

    setLiveBid(null)
    setLiveAsk(null)
    setArchiveSignals([])
    void load(true)
    // 履歴だけゆっくり更新（形成中足はティック側が担当）
    timer = window.setInterval(() => void load(false), 60_000)
    return () => {
      cancelled = true
      if (timer) window.clearInterval(timer)
    }
  }, [pairId, timeframe, pair])

  // ペア変更時は急変検知・価格履歴をリセット（1分20p / 10分50p）
  useEffect(() => {
    shockRef.current = new ShockDetector({
      pip: pair.pip,
      rules: [
        { windowSec: 60, thresholdPips: 20, label: '1分', cooldownSec: 60 },
        { windowSec: 600, thresholdPips: 50, label: '10分', cooldownSec: 180 },
      ],
    })
    priceHistRef.current = []
    lastFiveSpoken.current = null
    setShockReport(null)
    if (shockClearTimer.current) {
      window.clearTimeout(shockClearTimer.current)
      shockClearTimer.current = null
    }
  }, [pairId, pair.pip])

  // ライブ価格を履歴に積む（変動読み上げ用・最大12分）
  useEffect(() => {
    livePriceRef.current = livePrice
    if (livePrice == null || !Number.isFinite(livePrice)) return
    const now = Date.now()
    const hist = priceHistRef.current
    hist.push({ t: now, price: livePrice })
    const cut = now - 12 * 60_000
    while (hist.length && hist[0].t < cut) hist.shift()
  }, [livePrice])

  // Live ticks: biquote SignalR push + multi-source REST fallback
  useEffect(() => {
    let cancelled = false
    let inFlight = false
    let streaming = false
    let lastStreamAt = 0

    function applyQuote(q: LiveQuote) {
      if (cancelled) return
      const px = q.price
      setLivePrice(px)
      if (q.bid != null) setLiveBid(q.bid)
      if (q.ask != null) setLiveAsk(q.ask)
      setCandles((prev) => {
        if (prev.length < 30) return prev
        return applyLiveTick(prev, px, timeframe)
      })
      const age = Math.max(0, Math.round(Date.now() / 1000 - q.at))
      const tag =
        q.source === 'biquote' && streaming
          ? 'biquote WS'
          : q.source
      setLiveSource(
        age <= 2 ? `ライブ ${tag}` : `ライブ ${tag} · ${age}秒前`,
      )
      setLiveError(null)

      if (shockAlert && shockRef.current) {
        const hit = shockRef.current.push(px)
        if (hit) {
          const cause = investigateShockCause({
            hit,
            events: eventsRef.current,
            headlines: headlinesRef.current,
          })
          announceShock({
            direction: hit.direction,
            pips: hit.pips,
            windowSec: hit.windowSec,
            label: hit.label,
            pairLabel: pair.label,
            causeSummary: cause.summary,
          })
          const until = Date.now() + 5 * 60_000
          setShockReport({
            dir: hit.direction,
            pips: hit.pips,
            label: hit.label,
            cause,
            until,
          })
          if (shockClearTimer.current) window.clearTimeout(shockClearTimer.current)
          shockClearTimer.current = window.setTimeout(() => {
            setShockReport(null)
            shockClearTimer.current = null
          }, 5 * 60_000)
        }
      }
    }

    const stopStream =
      BIQUOTE_SYMBOLS[pairId] != null
        ? subscribeBiquoteTicks(pairId, (q) => {
            streaming = true
            lastStreamAt = Date.now()
            applyQuote(q)
          })
        : () => {}

    async function poll() {
      if (inFlight) return
      // While WS is healthy, poll slower as a safety net only
      if (streaming && Date.now() - lastStreamAt < 4000) return
      inFlight = true
      try {
        const q = await fetchLiveQuote(pairId)
        if (cancelled || !q) return
        // Don't overwrite a fresher WS tick with a staler REST quote
        if (streaming && Date.now() - lastStreamAt < 1500 && q.source !== 'biquote') {
          return
        }
        applyQuote(q)
      } catch {
        /* keep chart; history still shown */
      } finally {
        inFlight = false
      }
    }

    void poll()
    // Poll is a safety net; early-return while biquote WS is healthy
    const id = window.setInterval(() => void poll(), 1000)
    const watch = window.setInterval(() => {
      if (streaming && Date.now() - lastStreamAt > 8000) streaming = false
    }, 2000)

    return () => {
      cancelled = true
      stopStream()
      window.clearInterval(id)
      window.clearInterval(watch)
    }
  }, [pairId, timeframe, pair.label, shockAlert])

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

  // Live board only needs a recent window — full Nov archive is for markers/chart.
  const raw = useMemo(() => {
    const window = candles.length > 600 ? candles.slice(-500) : candles
    return evaluateSimple(window, pair, stats.disabledSessions)
  }, [candles, pair, stats.disabledSessions])

  const histSignals = useMemo(() => {
    // Extra bars for indicator warmup, then only emit after warmup.
    const need = 1400
    const slice = candles.length > need ? candles.slice(-need) : candles
    const warmup = 100
    const from =
      slice.length > warmup
        ? Math.max(HIST_FROM_UNIX, slice[warmup].time)
        : HIST_FROM_UNIX
    const recent = listHistoricalSignals(slice, pair, from)
    return mergeHistSignals(archiveSignals, recent)
  }, [archiveSignals, candles, pair])
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
  const mid =
    livePrice != null && Number.isFinite(livePrice)
      ? livePrice
      : last
        ? last.close
        : NaN
  const halfSpread = ((raw.spreadPips || 0.2) * pair.pip) / 2
  const bidNum =
    liveBid != null && Number.isFinite(liveBid)
      ? liveBid
      : Number.isFinite(mid)
        ? mid - halfSpread
        : NaN
  const askNum =
    liveAsk != null && Number.isFinite(liveAsk)
      ? liveAsk
      : Number.isFinite(mid)
        ? mid + halfSpread
        : NaN
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
          grade: raw.grade,
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
        announceReady(side, raw.trailDistancePips, raw.entryPrice, pair.digits)
      }
    }
  }, [
    last,
    midText,
    raw.action,
    raw.entryPrice,
    raw.grade,
    raw.sessionLabel,
    raw.trailDistancePips,
    pair,
    voiceOn,
    inPosition,
  ])

  // 毎分: レート + 1分前比。5分おき: 5分間の変動も追加
  useEffect(() => {
    if (!voiceOn) return

    function priceAgo(msAgo: number): number | null {
      const hist = priceHistRef.current
      if (!hist.length) return null
      const target = Date.now() - msAgo
      let best: { t: number; price: number } | null = null
      for (const s of hist) {
        if (s.t <= target) best = s
        else break
      }
      // 目標時刻に近いサンプルが無い／古すぎる場合は先頭でも可（±20秒以内）
      if (best && target - best.t <= 20_000) return best.price
      if (!best && hist[0] && Math.abs(hist[0].t - target) <= 20_000) {
        return hist[0].price
      }
      return best?.price ?? null
    }

    const speakNow = () => {
      if (bid === '—' || ask === '—') return
      if (!Number.isFinite(Number(midText))) return
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
      const now = Date.now()
      const minuteKey = Math.floor(now / 60_000)
      if (lastSpokenBar.current === minuteKey) return
      lastSpokenBar.current = minuteKey

      const cur = Number(midText)
      const p1 = priceAgo(60_000)
      const p5 = priceAgo(5 * 60_000)
      const pips1m =
        p1 != null ? (cur - p1) / pair.pip : null
      const pips5m =
        p5 != null ? (cur - p5) / pair.pip : null

      const fiveKey = Math.floor(now / (5 * 60_000))
      const include5m = lastFiveSpoken.current !== fiveKey
      if (include5m) lastFiveSpoken.current = fiveKey

      speakRate(pair.label, midText, rateAct, { bid, ask }, {
        pips1m,
        pips5m,
        include5m,
      })
    }
    speakNow()
    const id = window.setInterval(speakNow, 60_000)
    return () => window.clearInterval(id)
  }, [voiceOn, bid, ask, midText, pair.label, pair.pip, raw.action, rateVoice])

  async function handleUnlockVoice() {
    unlockAudio()
    setVoiceOn(true)
    await requestNotifyPermission()
    const prefs = getVoicePrefs()
    setRateVoice(prefs.rateVoiceOn)
    setEntrySound(prefs.entrySoundOn)
    setNewsVoice(prefs.newsVoiceOn)
    setNewsVoiceOn(prefs.newsVoiceOn)
    setShockAlert(prefs.shockAlertOn)
    setShockAlertOn(prefs.shockAlertOn)
    setVolume(prefs.voiceVolume)
    setVoiceVolume(prefs.voiceVolume)
    briefDone.current = false
  }

  // 指標5分前・1分前・結果・要人・新着ニュースの読み上げ（20秒ごとに時刻チェック）
  useEffect(() => {
    if (!voiceOn || !newsVoice) return

    const tick = () => {
      const now = Date.now() / 1000

      const due = eventsDueSoon(events, now, 5 * 60, 3)
      for (const e of due) {
        if (warnedEvents.current.has(e.id)) continue
        warnedEvents.current.add(e.id)
        announceEventWarning(e, (e.time - now) / 60)
        setAlertIds((prev) => new Set(prev).add(e.id))
      }

      // 重要度4+ は1分前にも再アラート
      const urgent = eventsDueSoon(events, now, 60, 4)
      for (const e of urgent) {
        if (urgentWarned.current.has(e.id)) continue
        urgentWarned.current.add(e.id)
        announceEventWarning(e, (e.time - now) / 60, { urgent: true })
        setAlertIds((prev) => new Set(prev).add(e.id))
      }

      for (const e of events) {
        if (!e.actual) continue
        const key = `${e.id}|${e.actual}`
        if (spokenResults.current.has(key)) continue
        if (e.time < now - 2 * 3600 || e.time > now + 60) continue
        spokenResults.current.add(key)
        announceEventResult(e)
      }

      for (const e of events) {
        if (e.kind !== 'speech') continue
        if (e.importance < 3) continue
        if (spokenSpeeches.current.has(e.id)) continue
        const mins = (e.time - now) / 60
        if (mins > 60 || mins < -15) continue
        spokenSpeeches.current.add(e.id)
        announceSpeech(e, mins)
      }

      if (spokenHeadlines.current.size === 0 && headlines.length > 0) {
        for (const h of headlines.slice(0, 12)) spokenHeadlines.current.add(h.id)
      } else {
        for (const h of headlines.slice(0, 8)) {
          if (spokenHeadlines.current.has(h.id)) continue
          spokenHeadlines.current.add(h.id)
          announceHeadline(h.title)
          break
        }
      }

      if (!briefDone.current && events.length > 0) {
        const upcoming = events
          .filter(
            (e) =>
              e.importance >= 4 &&
              e.time >= now - 60 &&
              e.time <= now + 6 * 3600,
          )
          .slice(0, 4)
        briefDone.current = true
        if (upcoming.length) {
          window.setTimeout(() => announceUpcomingBrief(upcoming), 2500)
        }
      }
    }

    tick()
    const id = window.setInterval(tick, 20_000)
    return () => window.clearInterval(id)
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

      {shockReport && (
        <div
          className={`shock-top ${shockReport.dir === 'UP' ? 'up' : 'down'}`}
          role="alert"
        >
          <div className="shock-top-main">
            <strong>
              急変調査 · {shockReport.dir === 'UP' ? '急騰' : '急落'}{' '}
              {shockReport.pips.toFixed(0)}p / {shockReport.label}
            </strong>
            <span className={`shock-conf conf-${shockReport.cause.confidence}`}>
              確度
              {shockReport.cause.confidence === 'high'
                ? '高'
                : shockReport.cause.confidence === 'medium'
                  ? '中'
                  : '低'}
            </span>
            <button
              type="button"
              className="shock-dismiss"
              aria-label="閉じる"
              onClick={() => {
                setShockReport(null)
                if (shockClearTimer.current) {
                  window.clearTimeout(shockClearTimer.current)
                  shockClearTimer.current = null
                }
              }}
            >
              ×
            </button>
          </div>
          <p className="shock-top-summary">{shockReport.cause.summary}</p>
          {shockReport.cause.details.length > 0 && (
            <ul className="shock-top-details">
              {shockReport.cause.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          )}
          <p className="shock-top-ttl">約5分間トップに表示 · 手動で閉じることも可</p>
        </div>
      )}

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
                  title="1分ごとのレート読み上げ"
                >
                  レート
                </button>
                <button
                  type="button"
                  className={`voice-btn ${entrySound ? 'active' : ''}`}
                  onClick={() => {
                    const n = !entrySound
                    setEntrySound(n)
                    setEntrySoundOn(n)
                  }}
                  title="エントリー／準備の効果音"
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
                  title="指標・要人・ニュース読み上げ"
                >
                  指標
                </button>
                <button
                  type="button"
                  className={`voice-btn ${shockAlert ? 'active' : ''}`}
                  onClick={() => {
                    const n = !shockAlert
                    setShockAlert(n)
                    setShockAlertOn(n)
                  }}
                  title="1分20p / 10分50p の急変で警告音"
                >
                  急変
                </button>
                <button
                  type="button"
                  className="voice-btn"
                  title="直近の注目指標を今すぐ読み上げ"
                  onClick={() => {
                    const now = Date.now() / 1000
                    const upcoming = events
                      .filter(
                        (e) =>
                          e.importance >= 3 &&
                          e.time >= now - 60 &&
                          e.time <= now + 8 * 3600,
                      )
                      .slice(0, 5)
                    announceBriefNow(upcoming)
                  }}
                >
                  まとめ
                </button>
                <label className="voice-volume" title="読み上げ・警告音の音量">
                  <span>音量</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={Math.round(volume * 100)}
                    aria-label="音量"
                    onChange={(e) => {
                      const v = Number(e.target.value) / 100
                      setVolume(v)
                      setVoiceVolume(v)
                    }}
                  />
                  <em>{Math.round(volume * 100)}</em>
                </label>
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
              {histSignals.length > 0
                ? ` · 過去サイン ${histSignals.length}（11月〜）`
                : ''}
              {liveError ? ` · ${liveError}` : ''}
            </p>
          </div>
          {candles.length >= 30 ? (
            <ErrorBoundary>
              <PriceChart
                candles={candles}
                pair={pair}
                overlays={overlays}
                signalParams={{
                  utKey: raw.utKey,
                  utAtr: raw.utAtr,
                  sslLen: raw.sslLen,
                }}
                histSignals={histSignals}
              />
            </ErrorBoundary>
          ) : (
            <p className="sample-note" style={{ padding: '1.2rem' }}>
              {liveLoading ? 'チャート読み込み中…' : '足データ待ち…'}
            </p>
          )}
        </section>

        <div className="side-stack">
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
