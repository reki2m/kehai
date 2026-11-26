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
  const pad = Math.max((hi - lo) * 0.18, pip * 18)
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
        scaleMargins: { top: 0.1, bottom: 0.22 },
        autoScale: false,
        // Lock label column width — prevents whole plot shifting horizontally
        minimumWidth: 72,
        entireTextOnly: true,
      },
      timeScale: {
        borderColor: 'rgba(94, 234, 212, 0.08)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        shiftVisibleRangeOnNewBar: false,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      handleScroll: {
        vertTouchDrag: false,
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
      priceFormat: {
        type: 'price',
        precision: pair.digits,
        minMove: pair.pip,
      },
      // With autoScale:false we drive range manually — provider unused but safe
      autoscaleInfoProvider: (
        original: () => AutoscaleInfo | null,
      ): AutoscaleInfo | null => {
        const locked = stickyPrice.current
        if (locked) {
          return { priceRange: { minValue: locked.from, maxValue: locked.to } }
        }
        return original()
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
    chart.priceScale('macd').applyOptions({
      scaleMargins: { top: 0.78, bottom: 0.02 },
      borderVisible: false,
    })

    rsiLine.current = chart.addSeries(LineSeries, {
      color: '#94B9C6',
      lineWidth: 1,
      priceScaleId: 'rsi',
      ...OVERLAY_SCALE,
    })
    chart.priceScale('rsi').applyOptions({
      scaleMargins: { top: 0.78, bottom: 0.02 },
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
    force: boolean,
  ): void {
    if (!candleSeries.current) return
    const lookback = bars.slice(-100)
    const next = rangeFromBars(lookback, pair.pip)
    if (!next) return
    const prev = stickyPrice.current
    if (!force && prev) {
      const span = prev.to - prev.from
      const margin = span * 0.15
      // Price still comfortable inside locked window — do nothing
      if (price >= prev.from + margin && price <= prev.to - margin) return
      // Expand just enough; don't recentre every tick
      stickyPrice.current = {
        from: Math.min(prev.from, next.from),
        to: Math.max(prev.to, next.to),
      }
    } else {
      stickyPrice.current = next
    }
    const r = stickyPrice.current
    if (!r) return
    try {
      const scale = candleSeries.current.priceScale()
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

    // Fast path for tip updates — skip heavy overlay rebuilds + don't scroll
    if (
      !overlayChanged &&
      prevLen.current > 0 &&
      view.length >= Math.min(prevLen.current, 480) &&
      Math.abs(view.length - prevLen.current) <= 1
    ) {
      try {
        candleSeries.current.update(lastBar)
        prevLen.current = view.length
        lastBarTime.current = last.time
        // Keep Y locked; only expand when price nears the edge
        applyLockedRange(view, last.close, false)
        if (newBar) chartRef.current?.timeScale().scrollToRealTime()
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
        applyLockedRange(view, last.close, firstPaint || overlayChanged || newBar)
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

    // Initial / overlay rebuild only — avoid per-tick scroll jitter
    if (firstPaint || newBar) {
      chartRef.current?.timeScale().scrollToRealTime()
    }
  }, [candles, overlays, signalParams])

  useEffect(() => {
    if (!markersApi.current) return
    // Only markers that fall inside the visible chart window (~last 480 bars)
    const tMin = candles.length
      ? candles[Math.max(0, candles.length - 480)]!.time
      : 0
    const visible = histSignals.filter((s) => s.time >= tMin)
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
  }, [histSignals, candles])


  return <div className="chart-host" ref={hostRef} aria-label="価格チャート" />
}
