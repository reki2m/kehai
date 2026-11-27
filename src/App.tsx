import { useEffect, useMemo, useRef, useState } from 'react'
import { ErrorBoundary } from './components/ErrorBoundary'
import { NewsPanel } from './components/NewsPanel'
import { PriceChart, type OverlayId } from './components/PriceChart'
import { BookPanel } from './components/BookPanel'
import { ContextCharts } from './components/ContextCharts'
import { HistPerformancePanel } from './components/HistPerformancePanel'
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
  preserveLiveTip,
  sanitizeCandles,
  type LiveQuote,
} from './lib/liveRates'
import { simulateHistTrades } from './lib/histTrades'
import {
  scanPeakBook,
  type BookScanResult,
} from './lib/peakBook'
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
import {
  CONTEXT_WATCH_IDS,
  evaluateContextWatch,
  isContextOnly,
  isTradeablePair,
  type ContextWatchState,
} from './lib/contextWatch'
import { BROKER_SPREAD_PIPS } from './lib/filters'
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
  const [pairId, setPairId] = useState<PairId>(() => {
    return 'USDJPY'
  })
  const [contextSeries, setContextSeries] = useState<
    Partial<Record<PairId, Candle[]>>
  >({})
  const [contextWatch, setContextWatch] = useState<ContextWatchState | null>(
    null,
  )
  const [contextLoading, setContextLoading] = useState(false)
  const contextActiveRef = useRef<Set<PairId>>(new Set())
  const [timeframe, setTimeframe] = useState<Timeframe>('1m')
  // Clean TradingView-style candles by default; UT/SSL etc. are opt-in
  const [overlays, setOverlays] = useState<OverlayId[]>([])
  const [candles, setCandles] = useState<Candle[]>([])
  const [archiveSignals, setArchiveSignals] = useState<HistSignal[]>([])
  const [livePrice, setLivePrice] = useState<number | null>(null)
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
  const [book, setBook] = useState<BookScanResult | null>(null)
  const [bookLoading, setBookLoading] = useState(false)
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
  /** Throttle chart candle writes — board price still updates every tick. */
  const pendingTickRef = useRef<number | null>(null)
  const tickFlushTimer = useRef<number | null>(null)

  // Context assets are watch-only — never stay selected as the trade pair.
  useEffect(() => {
    if (isContextOnly(pairId) || !isTradeablePair(pairId)) {
      setPairId('USDJPY')
    }
  }, [pairId])

  const pair = getPair(pairId)
  const inPosition = !!stats.open
  /** Keep last BUY/SELL actionable for a few minutes so entry button stays pressable. */
  const stickyOfferRef = useRef<{
    action: 'BUY' | 'SELL'
    session: FxSession
    sessionLabel: string | null
    slPips: number
    tpPips: number
    grade: string
    prime: boolean
    until: number
  } | null>(null)
  const [, bumpSticky] = useState(0)

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
              60,
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
            const step =
              TIMEFRAMES.find((t) => t.id === timeframe)?.seconds ?? 60
            const tip =
              initial || prev.length < 30
                ? sanitizeCandles(live.candles, step)
                : mergeRemoteCandles(
                    live.candles,
                    prev.length > archive.length
                      ? prev.slice(-Math.max(400, live.candles.length + 50))
                      : prev,
                    timeframe,
                    livePriceRef.current,
                  )
            const merged = archive.length
              ? mergeArchiveCandles(archive, tip, step)
              : tip
            return preserveLiveTip(prev, merged, livePriceRef.current)
          })
          if (live.lastPrice != null && livePriceRef.current == null) {
            setLivePrice(live.lastPrice)
          }
          if (initial) {
            setLiveSource(live.source)
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

    function flushTickToChart() {
      tickFlushTimer.current = null
      const px = pendingTickRef.current
      if (px == null || !Number.isFinite(px)) return
      setCandles((prev) => {
        if (prev.length < 30) return prev
        return applyLiveTick(prev, px, timeframe)
      })
    }

    function applyQuote(q: LiveQuote) {
      if (cancelled) return
      const px = q.price
      setLivePrice(px)
      // Chart: coalesce WS spam. Board bid/ask = mid ± fixed 0.2p.
      pendingTickRef.current = px
      if (tickFlushTimer.current == null) {
        tickFlushTimer.current = window.setTimeout(flushTickToChart, 500)
      }
      const tag =
        q.source === 'biquote' && streaming
          ? 'biquote WS'
          : q.source
      // Stable label only — age/sec text used to reflow chart-meta every tick
      setLiveSource((prev) => (prev === tag ? prev : tag))
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
      if (tickFlushTimer.current != null) {
        window.clearTimeout(tickFlushTimer.current)
        tickFlushTimer.current = null
      }
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

  // Sticky entry offer: UT flip is 1-bar; keep pressable for 5 minutes.
  useEffect(() => {
    if (raw.action === 'BUY' || raw.action === 'SELL') {
      if (!raw.session) return
      stickyOfferRef.current = {
        action: raw.action,
        session: raw.session,
        sessionLabel: raw.sessionLabel,
        slPips: raw.slPips,
        tpPips: raw.tpPips,
        grade: raw.grade,
        prime: raw.prime,
        until: Date.now() + 5 * 60_000,
      }
      bumpSticky((n) => n + 1)
      return
    }
    const offer = stickyOfferRef.current
    if (offer && Date.now() > offer.until) {
      stickyOfferRef.current = null
      bumpSticky((n) => n + 1)
    }
  }, [raw])

  useEffect(() => {
    const id = window.setInterval(() => {
      const offer = stickyOfferRef.current
      if (offer && Date.now() > offer.until) {
        stickyOfferRef.current = null
        bumpSticky((n) => n + 1)
      }
    }, 15_000)
    return () => window.clearInterval(id)
  }, [])

  const stickyOffer =
    stickyOfferRef.current && Date.now() <= stickyOfferRef.current.until
      ? stickyOfferRef.current
      : null
  const entryAction =
    raw.action === 'BUY' || raw.action === 'SELL'
      ? raw.action
      : stickyOffer?.action ?? null
  const entrySession =
    raw.action === 'BUY' || raw.action === 'SELL'
      ? raw.session
      : stickyOffer?.session ?? null
  const canMarkEntry = !inPosition && !!entryAction && !!entrySession

  // Tip ticks must not rebuild markers — only when a new bar opens
  const lastCandleTime = candles[candles.length - 1]?.time ?? 0
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
    // candles read intentionally; invalidate on bar time / length only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archiveSignals, lastCandleTime, pair, candles.length])

  const histPerf = useMemo(() => {
    if (candles.length < 80 || histSignals.length === 0) return null
    return simulateHistTrades(candles, histSignals, pair)
  }, [candles, histSignals, pair])

  useEffect(() => {
    let cancelled = false
    async function scan() {
      setBookLoading(true)
      try {
        const res = await scanPeakBook(stats.disabledSessions)
        if (!cancelled) setBook(res)
      } catch {
        if (!cancelled) setBook(null)
      } finally {
        if (!cancelled) setBookLoading(false)
      }
    }
    void scan()
    const id = window.setInterval(() => void scan(), 60_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [stats.disabledSessions])

  // Context watch: oil/Nikkei/Dow/VIX — charts only while related to USDJPY.
  useEffect(() => {
    let cancelled = false
    async function loadContext() {
      setContextLoading(true)
      try {
        const results = await Promise.all(
          CONTEXT_WATCH_IDS.map(async (id) => {
            try {
              const live = await fetchLiveCandles(id, '1m')
              return [id, live.candles] as const
            } catch {
              return [id, [] as Candle[]] as const
            }
          }),
        )
        if (cancelled) return
        const series: Partial<Record<PairId, Candle[]>> = {}
        for (const [id, bars] of results) series[id] = bars
        setContextSeries(series)

        let base = candles
        if (pairId !== 'USDJPY' || timeframe !== '1m' || candles.length < 80) {
          try {
            const uj = await fetchLiveCandles('USDJPY', '1m')
            base = uj.candles
          } catch {
            /* keep candles */
          }
        }
        if (cancelled) return
        const watch = evaluateContextWatch(
          base,
          series,
          contextActiveRef.current,
        )
        contextActiveRef.current = new Set(watch.activeIds)
        setContextWatch(watch)
      } catch {
        if (!cancelled) setContextWatch(null)
      } finally {
        if (!cancelled) setContextLoading(false)
      }
    }
    void loadContext()
    const id = window.setInterval(() => void loadContext(), 60_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
    // Re-poll on pair/tf change; candle length only kicks first fill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairId, timeframe])

  // Re-score correlation on each new USDJPY bar without refetching drivers.
  useEffect(() => {
    if (pairId !== 'USDJPY' || timeframe !== '1m') return
    if (candles.length < 80) return
    if (!CONTEXT_WATCH_IDS.some((id) => (contextSeries[id]?.length ?? 0) > 40))
      return
    const watch = evaluateContextWatch(
      candles,
      contextSeries,
      contextActiveRef.current,
    )
    contextActiveRef.current = new Set(watch.activeIds)
    setContextWatch(watch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastCandleTime])

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
    const side = entryAction
    const session = entrySession
    if (!side || !session) return
    // BUY pays ask, SELL hits bid
    const expected = side === 'BUY' ? askNum : bidNum
    if (!Number.isFinite(expected)) return
    const sl =
      raw.action === side ? raw.slPips : (stickyOffer?.slPips ?? SIMPLE.slPips)
    const tp =
      raw.action === side ? raw.tpPips : (stickyOffer?.tpPips ?? SIMPLE.tpPips)
    setStats((s) =>
      openTrade(s, {
        session,
        side,
        expectedEntry: expected,
        pairId,
        slPips: sl,
        tpPips: tp,
      }),
    )
    stickyOfferRef.current = null
    bumpSticky((n) => n + 1)
  }

  function handleClose(kind: 'TP' | 'SL' | 'OTHER') {
    const slip = Math.max(0, Number(slipInput) || 0)
    const openSl = stats.open?.slPips ?? SIMPLE.slPips
    const openTp = stats.open?.tpPips ?? SIMPLE.tpPips
    let pnl =
      kind === 'TP' ? openTp : kind === 'SL' ? -openSl : Number(otherPnl)
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

  function handleResetOpen() {
    setStats((s) => cancelOpen(s))
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
  // Display bid/ask always at fixed broker spread (0.2p) — ignore live BBO width
  const halfSpread = (BROKER_SPREAD_PIPS * pair.pip) / 2
  const bidNum = Number.isFinite(mid) ? mid - halfSpread : NaN
  const askNum = Number.isFinite(mid) ? mid + halfSpread : NaN
  const bid = Number.isFinite(bidNum) ? bidNum.toFixed(pair.digits) : '—'
  const ask = Number.isFinite(askNum) ? askNum.toFixed(pair.digits) : '—'
  const midText = Number.isFinite(mid) ? mid.toFixed(pair.digits) : '—'

  /** Live open ±pips vs mark (BUY→bid exit, SELL→ask exit). */
  const openPips = (() => {
    const o = stats.open
    if (!o || !Number.isFinite(mid)) return null
    const mark = o.side === 'BUY' ? bidNum : askNum
    if (!Number.isFinite(mark)) return null
    const raw =
      o.side === 'BUY'
        ? (mark - o.expectedEntry) / pair.pip
        : (o.expectedEntry - mark) / pair.pip
    return Math.round(raw * 10) / 10
  })()

  // Entry / READY alerts on signal change
  useEffect(() => {
    if (!last || !voiceOn) return
    const bar = last.time
    if (!inPosition && (raw.action === 'BUY' || raw.action === 'SELL')) {
      const key = `${bar}-${raw.action}`
      if (lastEntryKey.current !== key) {
        lastEntryKey.current = key
        announceEntry(raw.action === 'BUY' ? 'LONG' : 'SHORT', midText, {
          sl: raw.slPips,
          tp: raw.tpPips,
          unit: unitLabel(pair),
          session: raw.sessionLabel ?? undefined,
          grade: raw.grade,
          prime: raw.prime,
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
    raw.prime,
    raw.slPips,
    raw.tpPips,
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

  // Never show "ライブ ライブ …" even if a source string already starts with ライブ
  const sourceLabel = (() => {
    if (liveLoading && !liveSource) return 'レート取得中…'
    if (!liveSource) {
      return liveError ? 'レート取得失敗 · 再読み込み' : 'レート待機中'
    }
    const cleaned = liveSource.replace(/^ライブ\s*[·•.\-:]?\s*/u, '').trim()
    return cleaned ? `ライブ · ${cleaned}` : 'ライブ'
  })()

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
            {SIMPLE.stack} · 手動サイン · SL/TP ATR連動
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
              <optgroup label="FX（トレード対象）">
                {PAIRS.filter((p) => p.kind === 'fx').map((p) => (
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
                disabled={!canMarkEntry}
                onClick={handleEntry}
                title={
                  canMarkEntry
                    ? stickyOffer && raw.action !== 'BUY' && raw.action !== 'SELL'
                      ? `直近${stickyOffer.action}を5分保持中`
                      : `${entryAction}を記録`
                    : 'BUY/SELLサイン待ち'
                }
              >
                エントリーした
                {canMarkEntry && entryAction ? ` · ${entryAction}` : ''}
              </button>
            ) : (
              <>
                <span
                  className={`voice-btn active open-pips ${
                    openPips != null && openPips >= 0 ? 'up' : 'down'
                  }`}
                  title={`建値 ${stats.open?.expectedEntry.toFixed(pair.digits) ?? '—'} · ${stats.open?.side ?? ''}`}
                >
                  建玉 {stats.open?.side}
                  {openPips != null
                    ? ` ${openPips >= 0 ? '+' : ''}${openPips.toFixed(1)}p`
                    : ''}
                </span>
                <button
                  type="button"
                  className="voice-btn"
                  onClick={() => handleClose('TP')}
                  title="利確として記録"
                >
                  TP
                </button>
                <button
                  type="button"
                  className="voice-btn"
                  onClick={() => handleClose('SL')}
                  title="損切として記録"
                >
                  SL
                </button>
                <button
                  type="button"
                  className="voice-btn"
                  onClick={handleResetOpen}
                  title="ブローカーで切ったあと建玉表示を消す（成績に載せない）"
                >
                  リセット
                </button>
              </>
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
            <div className="chart-meta-row">
              <h1>
                {pair.label}
                <span className="tf-chip">
                  {timeframe} · Drive · JST
                </span>
              </h1>
              <div className="chart-rates" aria-label="買い値と売り値">
                <div className="chart-rate ask">
                  <span className="chart-rate-label">買</span>
                  <span className="chart-rate-num">{ask}</span>
                </div>
                <div className="chart-rate bid">
                  <span className="chart-rate-label">売</span>
                  <span className="chart-rate-num">{bid}</span>
                </div>
                {inPosition && openPips != null && (
                  <div
                    className={`chart-rate open ${openPips >= 0 ? 'up' : 'down'}`}
                  >
                    <span className="chart-rate-label">建玉</span>
                    <span className="chart-rate-num">
                      {openPips >= 0 ? '+' : ''}
                      {openPips.toFixed(1)}p
                    </span>
                  </div>
                )}
              </div>
            </div>
            <p
              className="sample-note"
              title={[
                sourceLabel,
                signal.sessionLabel ?? 'セッション外',
                candles.length
                  ? `出来高 ${Math.round(candles[candles.length - 1]?.volume ?? 0).toLocaleString('ja-JP')}`
                  : null,
                histSignals.length > 0
                  ? `過去サイン ${histSignals.length}（11月〜）`
                  : null,
                liveError,
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              {sourceLabel}
              {' · '}
              {signal.sessionLabel ?? 'セッション外'}
              {candles.length
                ? ` · 出来高 ${Math.round(candles[candles.length - 1]?.volume ?? 0).toLocaleString('ja-JP')}`
                : ''}
              {histSignals.length > 0
                ? ` · 過去 ${histSignals.length}`
                : ''}
              {` · 仲値 ${midText}`}
              <span className={`quote-chg ${change >= 0 ? 'up' : 'down'}`}>
                {' '}
                {change >= 0 ? '+' : ''}
                {change.toFixed(pair.digits)} ({changePct >= 0 ? '+' : ''}
                {changePct.toFixed(3)}%)
              </span>
            </p>
          </div>
          <div className="main-chart-slot">
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
          </div>
          <ContextCharts
            links={contextWatch?.links ?? []}
            series={contextSeries}
            loading={contextLoading}
          />
        </section>

        <div className="side-stack">
          <SimpleBoard
            signal={signal}
            pair={pair}
            inPosition={inPosition}
            openPips={openPips}
          />
          <BookPanel
            book={book}
            loading={bookLoading}
            activePair={pairId}
            onSelectPair={setPairId}
          />
          <HistPerformancePanel summary={histPerf} />
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
