import { useEffect, useRef } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
  type AutoscaleInfo,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
  type WhitespaceData,
} from 'lightweight-charts'
import type { Candle } from '../lib/marketData'
import {
  bollinger,
  ema,
  macd,
  rsi,
  sessionVwap,
  sslChannel,
  utBotTrail,
} from '../lib/indicators'
import type { PairMeta } from '../lib/pairs'
import type { HistSignal } from '../lib/signalHistory'

export type OverlayId = 'ut' | 'ssl' | 'vwap' | 'ema' | 'bb' | 'macd' | 'rsi'

export interface ChartSignalParams {
  utKey: number
  utAtr: number
  sslLen: number
}

interface Props {
  candles: Candle[]
  pair: PairMeta
  overlays: OverlayId[]
  signalParams?: ChartSignalParams
  /** Past BUY/SELL markers (e.g. from November). */
  histSignals?: HistSignal[]
}

function toLine(pts: { time: number; value: number }[]): LineData<Time>[] {
  return pts.map((p) => ({
    time: p.time as UTCTimestamp,
    value: p.value,
  }))
}

function toVolumeBars(bars: Candle[]): HistogramData<Time>[] {
  return bars.map((c) => ({
    time: c.time as UTCTimestamp,
    value: Math.max(0, c.volume || 0),
    color:
      c.close >= c.open
        ? 'rgba(94, 234, 212, 0.55)'
        : 'rgba(240, 113, 103, 0.55)',
  }))
}

/** How many M1 bars fill the viewport — fewer = fatter / taller-looking candles. */
const VISIBLE_BARS = 40

function fitVisibleBars(chart: IChartApi, barCount: number): void {
  if (barCount <= 0) return
  const from = Math.max(-0.5, barCount - VISIBLE_BARS)
  try {
    chart.timeScale().setVisibleLogicalRange({
      from,
      to: barCount + 1.5,
    })
  } catch {
    /* ignore */
  }
}

/** Overlays must not drive the Y-axis — that was a main source of jitter. */
const OVERLAY_SCALE = {
  priceLineVisible: false,
  lastValueVisible: false,
  crosshairMarkerVisible: false,
  autoscaleInfoProvider: () => null,
} as const

function rangeFromBars(
  bars: Candle[],
  pip: number,
): { from: number; to: number } | null {
  if (!bars.length) return null
  let lo = Infinity
  let hi = -Infinity
  for (const c of bars) {
    if (!Number.isFinite(c.low) || !Number.isFinite(c.high)) continue
    lo = Math.min(lo, c.low)
    hi = Math.max(hi, c.high)
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return null
  // Tight pad — previous 40-pip pad flattened M1 bodies into horizontal lines
  const span = hi - lo
  const pad = Math.max(span * 0.1, pip * 5)
  // Enforce a readable minimum window (~18 pips) without over-zooming noise
  const minSpan = pip * 18
  if (span + pad * 2 < minSpan) {
    const mid = (hi + lo) / 2
    return { from: mid - minSpan / 2, to: mid + minSpan / 2 }
  }
  return { from: lo - pad, to: hi + pad }
}

/** Split trail into up/down segments with gaps at flips. */
function splitTrailByDir(
  trail: { time: number; value: number }[],
  direction: { time: number; value: number }[],
): {
  up: (LineData<Time> | WhitespaceData<Time>)[]
  down: (LineData<Time> | WhitespaceData<Time>)[]
} {
  const dirMap = new Map(direction.map((d) => [d.time, d.value]))
  const up: (LineData<Time> | WhitespaceData<Time>)[] = []
  const down: (LineData<Time> | WhitespaceData<Time>)[] = []
  let prevDir: number | null = null
  for (const p of trail) {
    const d = dirMap.get(p.time) ?? 0
    const point: LineData<Time> = {
      time: p.time as UTCTimestamp,
      value: p.value,
    }
    if (prevDir != null && prevDir !== d) {
      const gap: WhitespaceData<Time> = { time: point.time }
      if (d > 0) up.push(gap)
      else down.push(gap)
    }
    if (d > 0) up.push(point)
    else down.push(point)
    prevDir = d
  }
  return { up, down }
}

export function PriceChart({
  candles,
  pair,
  overlays,
  signalParams,
  histSignals = [],
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const markersApi = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
  const utUp = useRef<ISeriesApi<'Line'> | null>(null)
  const utDown = useRef<ISeriesApi<'Line'> | null>(null)
  const sslHi = useRef<ISeriesApi<'Line'> | null>(null)
  const sslLo = useRef<ISeriesApi<'Line'> | null>(null)
  const vwapLine = useRef<ISeriesApi<'Line'> | null>(null)
  const emaFast = useRef<ISeriesApi<'Line'> | null>(null)
  const emaSlow = useRef<ISeriesApi<'Line'> | null>(null)
  const bbUpper = useRef<ISeriesApi<'Line'> | null>(null)
  const bbMid = useRef<ISeriesApi<'Line'> | null>(null)
  const bbLower = useRef<ISeriesApi<'Line'> | null>(null)
  const macdHist = useRef<ISeriesApi<'Histogram'> | null>(null)
  const macdLine = useRef<ISeriesApi<'Line'> | null>(null)
  const macdSignal = useRef<ISeriesApi<'Line'> | null>(null)
  const rsiLine = useRef<ISeriesApi<'Line'> | null>(null)
  const volHist = useRef<ISeriesApi<'Histogram'> | null>(null)
  /** Locked visible Y range — updated only near edges / new bars. */
  const stickyPrice = useRef<{ from: number; to: number } | null>(null)
  const lastBarTime = useRef<number | null>(null)
  const markersKey = useRef('')
  const sizeRef = useRef({ w: 0, h: 0 })

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    stickyPrice.current = null
    lastBarTime.current = null
    markersKey.current = ''
    sizeRef.current = { w: 0, h: 0 }

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(214, 228, 232, 0.55)',
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(94, 234, 212, 0.04)' },
        horzLines: { color: 'rgba(94, 234, 212, 0.05)' },
      },
      crosshair: {
        vertLine: {
          color: 'rgba(232, 196, 124, 0.35)',
          labelBackgroundColor: '#1A2E34',
        },
        horzLine: {
          color: 'rgba(232, 196, 124, 0.35)',
          labelBackgroundColor: '#1A2E34',
        },
      },
      rightPriceScale: {
        borderColor: 'rgba(94, 234, 212, 0.08)',
        // Leave the bottom ~22% for the volume pane
        scaleMargins: { top: 0.04, bottom: 0.24 },
        autoScale: false,
        // Lock label column width — prevents whole plot shifting horizontally
        minimumWidth: 80,
        entireTextOnly: true,
      },
      timeScale: {
        borderColor: 'rgba(94, 234, 212, 0.08)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
        barSpacing: 16,
        minBarSpacing: 10,
        shiftVisibleRangeOnNewBar: false,
        fixLeftEdge: false,
        fixRightEdge: true,
      },
      handleScroll: {
        vertTouchDrag: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        mouseWheel: true,
      },
      handleScale: {
        axisPressedMouseMove: { time: true, price: false },
        axisDoubleClickReset: { time: true, price: false },
        mouseWheel: true,
        pinch: false,
      },
      width: el.clientWidth,
      height: el.clientHeight,
    })

    candleSeries.current = chart.addSeries(CandlestickSeries, {
      upColor: '#5EEAD4',
      downColor: '#F07167',
      borderUpColor: '#5EEAD4',
      borderDownColor: '#F07167',
      wickUpColor: 'rgba(94, 234, 212, 0.85)',
      wickDownColor: 'rgba(240, 113, 103, 0.85)',
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: {
        type: 'price',
        precision: pair.digits,
        minMove: pair.pip,
      },
      // Always report the frozen window so LWC never auto-recentres on ticks
      autoscaleInfoProvider: (): AutoscaleInfo | null => {
        const locked = stickyPrice.current
        if (!locked) return null
        return { priceRange: { minValue: locked.from, maxValue: locked.to } }
      },
    })
    markersApi.current = createSeriesMarkers(candleSeries.current, [], {
      zOrder: 'top',
    })

    // No series titles / last-value badges — they cover the M1 candles on the right.
    utUp.current = chart.addSeries(LineSeries, {
      color: 'rgba(94, 234, 212, 0.85)',
      lineWidth: 2,
      ...OVERLAY_SCALE,
    })
    utDown.current = chart.addSeries(LineSeries, {
      color: 'rgba(240, 113, 103, 0.85)',
      lineWidth: 2,
      ...OVERLAY_SCALE,
    })
    sslHi.current = chart.addSeries(LineSeries, {
      color: 'rgba(94, 234, 212, 0.4)',
      lineWidth: 1,
      lineStyle: 2,
      ...OVERLAY_SCALE,
    })
    sslLo.current = chart.addSeries(LineSeries, {
      color: 'rgba(240, 113, 103, 0.4)',
      lineWidth: 1,
      lineStyle: 2,
      ...OVERLAY_SCALE,
    })
    vwapLine.current = chart.addSeries(LineSeries, {
      color: 'rgba(232, 196, 124, 0.75)',
      lineWidth: 1,
      lineStyle: 0,
      ...OVERLAY_SCALE,
    })

    emaFast.current = chart.addSeries(LineSeries, {
      color: '#E8C47C',
      lineWidth: 2,
      ...OVERLAY_SCALE,
    })
    emaSlow.current = chart.addSeries(LineSeries, {
      color: 'rgba(148, 185, 198, 0.9)',
      lineWidth: 2,
      ...OVERLAY_SCALE,
    })
    bbUpper.current = chart.addSeries(LineSeries, {
      color: 'rgba(94, 234, 212, 0.35)',
      lineWidth: 1,
      lineStyle: 2,
      ...OVERLAY_SCALE,
    })
    bbMid.current = chart.addSeries(LineSeries, {
      color: 'rgba(232, 196, 124, 0.45)',
      lineWidth: 1,
      ...OVERLAY_SCALE,
    })
    bbLower.current = chart.addSeries(LineSeries, {
      color: 'rgba(240, 113, 103, 0.35)',
      lineWidth: 1,
      lineStyle: 2,
      ...OVERLAY_SCALE,
    })

    // Volume always sits in the bottom strip (tick / broker activity per bar)
    volHist.current = chart.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: true,
      base: 0,
    })
    chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.8, bottom: 0.02 },
      borderVisible: false,
      entireTextOnly: true,
    })

    macdHist.current = chart.addSeries(HistogramSeries, {
      priceScaleId: 'macd',
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: () => null,
    })
    macdLine.current = chart.addSeries(LineSeries, {
      color: '#94B9C6',
      lineWidth: 1,
      priceScaleId: 'macd',
      ...OVERLAY_SCALE,
    })
    macdSignal.current = chart.addSeries(LineSeries, {
      color: '#E8C47C',
      lineWidth: 1,
      priceScaleId: 'macd',
      ...OVERLAY_SCALE,
    })
    // MACD sits above volume when enabled
    chart.priceScale('macd').applyOptions({
      scaleMargins: { top: 0.58, bottom: 0.24 },
      borderVisible: false,
    })

    rsiLine.current = chart.addSeries(LineSeries, {
      color: '#94B9C6',
      lineWidth: 1,
      priceScaleId: 'rsi',
      ...OVERLAY_SCALE,
    })
    chart.priceScale('rsi').applyOptions({
      scaleMargins: { top: 0.58, bottom: 0.24 },
      borderVisible: false,
    })

    chartRef.current = chart

    let resizeTimer: number | null = null
    const ro = new ResizeObserver(() => {
      if (!hostRef.current || !chartRef.current) return
      const w = hostRef.current.clientWidth
      const h = hostRef.current.clientHeight
      // Ignore sub-pixel / 1px thrash from layout
      if (
        Math.abs(w - sizeRef.current.w) < 2 &&
        Math.abs(h - sizeRef.current.h) < 2
      ) {
        return
      }
      if (resizeTimer != null) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null
        if (!hostRef.current || !chartRef.current) return
        const nw = hostRef.current.clientWidth
        const nh = hostRef.current.clientHeight
        sizeRef.current = { w: nw, h: nh }
        chartRef.current.applyOptions({ width: nw, height: nh })
      }, 120)
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      if (resizeTimer != null) window.clearTimeout(resizeTimer)
      markersApi.current?.detach()
      markersApi.current = null
      chart.remove()
      chartRef.current = null
    }
  }, [pair.digits, pair.pip])

  const prevLen = useRef(0)
  const overlayKeyRef = useRef('')

  function applyLockedRange(
    bars: Candle[],
    price: number,
    mode: 'init' | 'guard',
  ): void {
    if (!candleSeries.current) return
    const prev = stickyPrice.current

    // After first paint: never recentre mid-bar. Only expand if price left the window.
    if (mode === 'guard' && prev) {
      const margin = (prev.to - prev.from) * 0.08
      if (price >= prev.from + margin && price <= prev.to - margin) return
      const chunk = Math.max((prev.to - prev.from) * 0.12, pair.pip * 6)
      stickyPrice.current = {
        from: price < prev.from + margin ? Math.min(prev.from, price - chunk) : prev.from,
        to: price > prev.to - margin ? Math.max(prev.to, price + chunk) : prev.to,
      }
    } else {
      // Fit Y to the same window the user sees (~40 bars) so bodies look tall
      const lookback = bars.slice(-VISIBLE_BARS)
      const next = rangeFromBars(lookback, pair.pip)
      if (!next) return
      stickyPrice.current = next
    }

    const r = stickyPrice.current
    if (!r) return
    try {
      const scale = candleSeries.current.priceScale()
      scale.applyOptions({ autoScale: false })
      scale.setAutoScale(false)
      scale.setVisibleRange({ from: r.from, to: r.to })
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    if (!candleSeries.current || candles.length === 0) return

    // Live chart only needs a recent window — full Nov archive makes redraws heavy
    const view =
      candles.length > 480 ? candles.slice(-480) : candles

    const last = view[view.length - 1]
    const lastBar: CandlestickData<Time> = {
      time: last.time as UTCTimestamp,
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
    }
    const newBar =
      lastBarTime.current != null && last.time !== lastBarTime.current
    const firstPaint = lastBarTime.current == null
    const overlayKey = `${overlays.join(',')}|${signalParams?.utKey ?? ''}/${signalParams?.utAtr ?? ''}/${signalParams?.sslLen ?? ''}`
    const overlayChanged = overlayKeyRef.current !== overlayKey
    overlayKeyRef.current = overlayKey

    // Fast path for tip updates — skip heavy overlay rebuilds + don't touch Y
    if (
      !overlayChanged &&
      prevLen.current > 0 &&
      view.length >= Math.min(prevLen.current, 480) &&
      Math.abs(view.length - prevLen.current) <= 1
    ) {
      try {
        candleSeries.current.update(lastBar)
        volHist.current?.update({
          time: last.time as UTCTimestamp,
          value: Math.max(0, last.volume || 0),
          color:
            last.close >= last.open
              ? 'rgba(94, 234, 212, 0.55)'
              : 'rgba(240, 113, 103, 0.55)',
        })
        prevLen.current = view.length
        lastBarTime.current = last.time
        // New bar: refit Y to last ~40 bars so candles stay tall; tip: guard only
        applyLockedRange(view, last.close, newBar ? 'init' : 'guard')
        if (newBar && chartRef.current) fitVisibleBars(chartRef.current, view.length)
        return
      } catch {
        /* fall through to full setData */
      }
    }

    {
      const seen = new Set<number>()
      const candleData: CandlestickData<Time>[] = []
      for (const c of view) {
        if (!Number.isFinite(c.time) || seen.has(c.time)) continue
        seen.add(c.time)
        candleData.push({
          time: c.time as UTCTimestamp,
          open: c.open,
          high: Math.max(c.open, c.high, c.close),
          low: Math.min(c.open, c.low, c.close),
          close: c.close,
        })
      }
      try {
        candleSeries.current.setData(candleData)
        prevLen.current = view.length
        lastBarTime.current = last.time
        // Recentre Y on first paint, overlay change, or new bar (keeps M1 tall)
        applyLockedRange(
          view,
          last.close,
          firstPaint || overlayChanged || newBar ? 'init' : 'guard',
        )
      } catch {
        prevLen.current = 0
        return
      }
    }

    const showUt = overlays.includes('ut')
    const showSsl = overlays.includes('ssl')
    const showVwap = overlays.includes('vwap')
    const showEma = overlays.includes('ema')
    const showBb = overlays.includes('bb')
    const showMacd = overlays.includes('macd')
    const showRsi = overlays.includes('rsi')

    const utKey = signalParams?.utKey ?? 2
    const utAtr = signalParams?.utAtr ?? 7
    const sslLen = signalParams?.sslLen ?? 10
    const overlaySrc = view

    if (utUp.current && utDown.current) {
      if (showUt) {
        const { direction, trail } = utBotTrail(overlaySrc, utKey, utAtr)
        const { up, down } = splitTrailByDir(trail, direction)
        utUp.current.setData(up)
        utDown.current.setData(down)
      } else {
        utUp.current.setData([])
        utDown.current.setData([])
      }
    }

    if (sslHi.current && sslLo.current) {
      if (showSsl) {
        const ch = sslChannel(overlaySrc, sslLen)
        sslHi.current.setData(toLine(ch.high))
        sslLo.current.setData(toLine(ch.low))
      } else {
        sslHi.current.setData([])
        sslLo.current.setData([])
      }
    }

    if (vwapLine.current) {
      if (showVwap) {
        vwapLine.current.setData(toLine(sessionVwap(overlaySrc)))
      } else {
        vwapLine.current.setData([])
      }
    }

    if (emaFast.current && emaSlow.current) {
      if (showEma) {
        emaFast.current.setData(toLine(ema(overlaySrc, 21)))
        emaSlow.current.setData(toLine(ema(overlaySrc, 55)))
      } else {
        emaFast.current.setData([])
        emaSlow.current.setData([])
      }
    }

    if (bbUpper.current && bbMid.current && bbLower.current) {
      if (showBb) {
        const bands = bollinger(overlaySrc)
        bbUpper.current.setData(
          bands.map((p) => ({
            time: p.time as UTCTimestamp,
            value: p.upper,
          })) as LineData<Time>[],
        )
        bbMid.current.setData(
          bands.map((p) => ({
            time: p.time as UTCTimestamp,
            value: p.middle,
          })) as LineData<Time>[],
        )
        bbLower.current.setData(
          bands.map((p) => ({
            time: p.time as UTCTimestamp,
            value: p.lower,
          })) as LineData<Time>[],
        )
      } else {
        bbUpper.current.setData([])
        bbMid.current.setData([])
        bbLower.current.setData([])
      }
    }

    if (macdHist.current && macdLine.current && macdSignal.current) {
      if (showMacd && !showRsi) {
        const m = macd(overlaySrc)
        macdHist.current.setData(
          m.map((p) => ({
            time: p.time as UTCTimestamp,
            value: p.histogram,
            color:
              p.histogram >= 0
                ? 'rgba(94, 234, 212, 0.45)'
                : 'rgba(240, 113, 103, 0.45)',
          })) as HistogramData<Time>[],
        )
        macdLine.current.setData(
          m.map((p) => ({
            time: p.time as UTCTimestamp,
            value: p.macd,
          })) as LineData<Time>[],
        )
        macdSignal.current.setData(
          m.map((p) => ({
            time: p.time as UTCTimestamp,
            value: p.signal,
          })) as LineData<Time>[],
        )
      } else {
        macdHist.current.setData([])
        macdLine.current.setData([])
        macdSignal.current.setData([])
      }
    }

    if (rsiLine.current) {
      if (showRsi) {
        rsiLine.current.setData(toLine(rsi(overlaySrc)))
      } else {
        rsiLine.current.setData([])
      }
    }

    if (volHist.current) {
      volHist.current.setData(toVolumeBars(overlaySrc))
    }

    // Zoom to ~72 fat M1 bars on first paint / new bar (not every tick)
    if ((firstPaint || newBar) && chartRef.current) {
      fitVisibleBars(chartRef.current, view.length)
    }
  }, [candles, overlays, signalParams])

  // Depend on histSignals + window start only — not every live tick
  const markerWindowStart =
    candles.length > 0
      ? candles[Math.max(0, candles.length - 480)]!.time
      : 0

  useEffect(() => {
    if (!markersApi.current) return
    const visible = histSignals.filter((s) => s.time >= markerWindowStart)
    const key = visible.map((s) => `${s.time}:${s.side}:${s.prime ? 1 : 0}`).join('|')
    if (key === markersKey.current) return
    markersKey.current = key
    // 推奨 (prime/A/S) = bright + large; 標準 = softer but still visible
    const markers: SeriesMarker<Time>[] = visible.map((s) => {
      const recommended =
        s.prime === true || s.grade === 'S' || s.grade === 'A'
      if (s.side === 'BUY') {
        return {
          time: s.time as UTCTimestamp,
          position: 'belowBar' as const,
          shape: 'arrowUp' as const,
          color: recommended ? '#FFE566' : '#C4B87A',
          text: recommended ? '買い★' : '買い',
          size: recommended ? 2 : 1,
        }
      }
      return {
        time: s.time as UTCTimestamp,
        position: 'aboveBar' as const,
        shape: 'arrowDown' as const,
        color: recommended ? '#FF4D9A' : '#C47A9A',
        text: recommended ? '売り★' : '売り',
        size: recommended ? 2 : 1,
      }
    })
    markersApi.current.setMarkers(markers)
  }, [histSignals, markerWindowStart])


  return <div className="chart-host" ref={hostRef} aria-label="価格チャート" />
}
