import { useEffect, useRef } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineSeries,
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
import { jstTickMarkFormatter, jstTimeFormatter } from '../lib/jstTime'
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

const UP = '#26A69A'
const DOWN = '#EF5350'
const UP_VOL = 'rgba(38, 166, 154, 0.55)'
const DOWN_VOL = 'rgba(239, 83, 80, 0.55)'

/** Fewer bars on a tall PC pane → fat readable M1 bodies (≈50–55 min). */
const VISIBLE_BARS = 52

/** Overlays must not drive the Y-axis. */
const OVERLAY_SCALE = {
  priceLineVisible: false,
  lastValueVisible: false,
  crosshairMarkerVisible: false,
  autoscaleInfoProvider: () => null,
} as const

function toLine(pts: { time: number; value: number }[]): LineData<Time>[] {
  return pts.map((p) => ({
    time: p.time as UTCTimestamp,
    value: p.value,
  }))
}

/**
 * FX feeds often ship volume=0. Prefer real tick/notional volume when present;
 * otherwise synthesize activity from bar range so the pane stays readable.
 */
function barActivity(c: Candle, pip: number): number {
  const v = c.volume || 0
  if (v > 0) return v
  const p = pip > 0 ? pip : 0.001
  const range = Math.max(0, (c.high - c.low) / p)
  const body = Math.abs(c.close - c.open) / p
  return Math.max(1, Math.round(range * 8 + body * 12 + 2))
}

function toVolumeBars(
  bars: Candle[],
  pip: number,
): HistogramData<Time>[] {
  return bars.map((c) => ({
    time: c.time as UTCTimestamp,
    value: barActivity(c, pip),
    color: c.close >= c.open ? UP_VOL : DOWN_VOL,
  }))
}

function fitVisibleBars(chart: IChartApi, barCount: number): void {
  if (barCount <= 0) return
  try {
    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(-0.5, barCount - VISIBLE_BARS),
      to: barCount + 2,
    })
  } catch {
    /* ignore */
  }
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
  const lastBarTime = useRef<number | null>(null)
  const markersKey = useRef('')
  const sizeRef = useRef({ w: 0, h: 0 })
  const prevLen = useRef(0)
  const overlayKeyRef = useRef('')

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    lastBarTime.current = null
    markersKey.current = ''
    sizeRef.current = { w: 0, h: 0 }
    prevLen.current = 0

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(214, 228, 232, 0.62)',
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 11,
        attributionLogo: false,
      },
      localization: {
        locale: 'ja-JP',
        dateFormat: 'MM/dd',
        timeFormatter: jstTimeFormatter,
      },
      grid: {
        vertLines: { color: 'rgba(148, 185, 198, 0.08)' },
        horzLines: { color: 'rgba(148, 185, 198, 0.1)' },
      },
      crosshair: {
        mode: 1,
        vertLine: {
          color: 'rgba(148, 185, 198, 0.35)',
          labelBackgroundColor: '#1A2E34',
          width: 1,
          style: 3,
        },
        horzLine: {
          color: 'rgba(148, 185, 198, 0.35)',
          labelBackgroundColor: '#1A2E34',
          width: 1,
          style: 3,
        },
      },
      rightPriceScale: {
        borderColor: 'rgba(148, 185, 198, 0.14)',
        // Keep volume thin so M1 bodies stay readable on PC
        scaleMargins: { top: 0.04, bottom: 0.1 },
        autoScale: true,
        minimumWidth: 72,
        entireTextOnly: true,
      },
      timeScale: {
        borderColor: 'rgba(148, 185, 198, 0.14)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
        barSpacing: 16,
        minBarSpacing: 10,
        shiftVisibleRangeOnNewBar: true,
        fixLeftEdge: false,
        fixRightEdge: true,
        tickMarkFormatter: jstTickMarkFormatter,
      },
      handleScroll: {
        vertTouchDrag: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        mouseWheel: true,
      },
      handleScale: {
        axisPressedMouseMove: { time: true, price: true },
        axisDoubleClickReset: { time: true, price: true },
        mouseWheel: true,
        pinch: true,
      },
      width: el.clientWidth,
      height: el.clientHeight,
    })

    // Force JST again — some LWC paths keep UTC until applyOptions.
    chart.applyOptions({
      localization: {
        locale: 'ja-JP',
        dateFormat: 'MM/dd',
        timeFormatter: jstTimeFormatter,
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: jstTickMarkFormatter,
      },
    })

    candleSeries.current = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
      // TradingView-style last price tag on the right
      priceLineVisible: true,
      priceLineWidth: 1,
      priceLineColor: 'rgba(38, 166, 154, 0.55)',
      lastValueVisible: true,
      priceFormat: {
        type: 'price',
        precision: pair.digits,
        minMove: pair.pip,
      },
    })
    markersApi.current = createSeriesMarkers(candleSeries.current, [], {
      zOrder: 'top',
    })

    utUp.current = chart.addSeries(LineSeries, {
      color: 'rgba(94, 234, 212, 0.75)',
      lineWidth: 2,
      ...OVERLAY_SCALE,
    })
    utDown.current = chart.addSeries(LineSeries, {
      color: 'rgba(240, 113, 103, 0.75)',
      lineWidth: 2,
      ...OVERLAY_SCALE,
    })
    sslHi.current = chart.addSeries(LineSeries, {
      color: 'rgba(94, 234, 212, 0.35)',
      lineWidth: 1,
      lineStyle: 2,
      ...OVERLAY_SCALE,
    })
    sslLo.current = chart.addSeries(LineSeries, {
      color: 'rgba(240, 113, 103, 0.35)',
      lineWidth: 1,
      lineStyle: 2,
      ...OVERLAY_SCALE,
    })
    vwapLine.current = chart.addSeries(LineSeries, {
      color: 'rgba(232, 196, 124, 0.7)',
      lineWidth: 1,
      ...OVERLAY_SCALE,
    })
    emaFast.current = chart.addSeries(LineSeries, {
      color: '#E8C47C',
      lineWidth: 2,
      ...OVERLAY_SCALE,
    })
    emaSlow.current = chart.addSeries(LineSeries, {
      color: 'rgba(148, 185, 198, 0.85)',
      lineWidth: 2,
      ...OVERLAY_SCALE,
    })
    bbUpper.current = chart.addSeries(LineSeries, {
      color: 'rgba(94, 234, 212, 0.3)',
      lineWidth: 1,
      lineStyle: 2,
      ...OVERLAY_SCALE,
    })
    bbMid.current = chart.addSeries(LineSeries, {
      color: 'rgba(232, 196, 124, 0.4)',
      lineWidth: 1,
      ...OVERLAY_SCALE,
    })
    bbLower.current = chart.addSeries(LineSeries, {
      color: 'rgba(240, 113, 103, 0.3)',
      lineWidth: 1,
      lineStyle: 2,
      ...OVERLAY_SCALE,
    })

    volHist.current = chart.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
      lastValueVisible: true,
      base: 0,
    })
    chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.9, bottom: 0.01 },
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
    chart.priceScale('macd').applyOptions({
      scaleMargins: { top: 0.55, bottom: 0.26 },
      borderVisible: false,
    })

    rsiLine.current = chart.addSeries(LineSeries, {
      color: '#94B9C6',
      lineWidth: 1,
      priceScaleId: 'rsi',
      ...OVERLAY_SCALE,
    })
    chart.priceScale('rsi').applyOptions({
      scaleMargins: { top: 0.55, bottom: 0.26 },
      borderVisible: false,
    })

    chartRef.current = chart

    let resizeTimer: number | null = null
    const ro = new ResizeObserver(() => {
      if (!hostRef.current || !chartRef.current) return
      const w = hostRef.current.clientWidth
      const h = hostRef.current.clientHeight
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

  useEffect(() => {
    if (!candleSeries.current || candles.length === 0) return

    const view = candles.length > 480 ? candles.slice(-480) : candles
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

    const bull = last.close >= last.open
    candleSeries.current.applyOptions({
      priceLineColor: bull ? 'rgba(38, 166, 154, 0.55)' : 'rgba(239, 83, 80, 0.55)',
    })

    // Fast tip path — autoScale keeps bodies readable like TradingView
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
          value: barActivity(last, pair.pip),
          color: bull ? UP_VOL : DOWN_VOL,
        })
        prevLen.current = view.length
        lastBarTime.current = last.time
        // Only nudge to realtime on a new bar — never refit (refit jumps the tip)
        if (newBar && chartRef.current) {
          try {
            chartRef.current.timeScale().scrollToRealTime()
          } catch {
            /* ignore */
          }
        }
        return
      } catch {
        /* fall through */
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
      vwapLine.current.setData(showVwap ? toLine(sessionVwap(overlaySrc)) : [])
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
                ? 'rgba(38, 166, 154, 0.45)'
                : 'rgba(239, 83, 80, 0.45)',
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
      rsiLine.current.setData(showRsi ? toLine(rsi(overlaySrc)) : [])
    }

    volHist.current?.setData(toVolumeBars(overlaySrc, pair.pip))

    // Fit only on first paint / overlay change. Refitting every new bar rewinds the tip.
    if ((firstPaint || overlayChanged) && chartRef.current) {
      fitVisibleBars(chartRef.current, view.length)
    } else if (newBar && chartRef.current) {
      try {
        chartRef.current.timeScale().scrollToRealTime()
      } catch {
        /* ignore */
      }
    }
  }, [candles, overlays, signalParams, pair.digits, pair.pip])

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

  return (
    <div className="chart-shell">
      <span className="chart-vol-tag" aria-hidden>
        出来高
      </span>
      <div className="chart-host" ref={hostRef} aria-label="価格チャート" />
    </div>
  )
}
