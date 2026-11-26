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

  useEffect(() => {
    const el = hostRef.current
    if (!el) return

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
        scaleMargins: { top: 0.08, bottom: 0.22 },
      },
      timeScale: {
        borderColor: 'rgba(94, 234, 212, 0.08)',
        timeVisible: true,
        secondsVisible: false,
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
    })
    markersApi.current = createSeriesMarkers(candleSeries.current, [], {
      zOrder: 'top',
    })

    // No series titles / last-value badges — they cover the M1 candles on the right.
    utUp.current = chart.addSeries(LineSeries, {
      color: 'rgba(94, 234, 212, 0.85)',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    utDown.current = chart.addSeries(LineSeries, {
      color: 'rgba(240, 113, 103, 0.85)',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    sslHi.current = chart.addSeries(LineSeries, {
      color: 'rgba(94, 234, 212, 0.4)',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    sslLo.current = chart.addSeries(LineSeries, {
      color: 'rgba(240, 113, 103, 0.4)',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    vwapLine.current = chart.addSeries(LineSeries, {
      color: 'rgba(232, 196, 124, 0.75)',
      lineWidth: 1,
      lineStyle: 0,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })

    emaFast.current = chart.addSeries(LineSeries, {
      color: '#E8C47C',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    emaSlow.current = chart.addSeries(LineSeries, {
      color: 'rgba(148, 185, 198, 0.9)',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    bbUpper.current = chart.addSeries(LineSeries, {
      color: 'rgba(94, 234, 212, 0.35)',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    bbMid.current = chart.addSeries(LineSeries, {
      color: 'rgba(232, 196, 124, 0.45)',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    bbLower.current = chart.addSeries(LineSeries, {
      color: 'rgba(240, 113, 103, 0.35)',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })

    macdHist.current = chart.addSeries(HistogramSeries, {
      priceScaleId: 'macd',
      priceLineVisible: false,
      lastValueVisible: false,
    })
    macdLine.current = chart.addSeries(LineSeries, {
      color: '#94B9C6',
      lineWidth: 1,
      priceScaleId: 'macd',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    macdSignal.current = chart.addSeries(LineSeries, {
      color: '#E8C47C',
      lineWidth: 1,
      priceScaleId: 'macd',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    chart.priceScale('macd').applyOptions({
      scaleMargins: { top: 0.78, bottom: 0.02 },
      borderVisible: false,
    })

    rsiLine.current = chart.addSeries(LineSeries, {
      color: '#94B9C6',
      lineWidth: 1,
      priceScaleId: 'rsi',
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    })
    chart.priceScale('rsi').applyOptions({
      scaleMargins: { top: 0.78, bottom: 0.02 },
      borderVisible: false,
    })

    chartRef.current = chart

    const ro = new ResizeObserver(() => {
      if (!hostRef.current || !chartRef.current) return
      chartRef.current.applyOptions({
        width: hostRef.current.clientWidth,
        height: hostRef.current.clientHeight,
      })
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      markersApi.current?.detach()
      markersApi.current = null
      chart.remove()
      chartRef.current = null
    }
  }, [pair.digits, pair.pip])

  const prevLen = useRef(0)

  useEffect(() => {
    if (!candleSeries.current || candles.length === 0) return

    const last = candles[candles.length - 1]
    const lastBar: CandlestickData<Time> = {
      time: last.time as UTCTimestamp,
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
    }

    // Fast path for tip updates — skip heavy overlay rebuilds
    if (
      prevLen.current > 0 &&
      candles.length >= prevLen.current &&
      candles.length - prevLen.current <= 1
    ) {
      try {
        candleSeries.current.update(lastBar)
        prevLen.current = candles.length
        chartRef.current?.timeScale().scrollToRealTime()
        return
      } catch {
        /* fall through to full setData */
      }
    }

    {
      const seen = new Set<number>()
      const candleData: CandlestickData<Time>[] = []
      for (const c of candles) {
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
        prevLen.current = candles.length
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
    // Overlay math on full Nov archive is too heavy — tip window is enough.
    const overlaySrc =
      candles.length > 2200 ? candles.slice(-2000) : candles

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

    chartRef.current?.timeScale().scrollToRealTime()
  }, [candles, overlays, signalParams])

  useEffect(() => {
    if (!markersApi.current) return
    // High-contrast vs candle teal/coral — gold / hot pink + larger size
    const markers: SeriesMarker<Time>[] = histSignals.map((s) =>
      s.side === 'BUY'
        ? {
            time: s.time as UTCTimestamp,
            position: 'belowBar' as const,
            shape: 'arrowUp' as const,
            color: '#FFE566',
            text: '買い',
            size: 2,
          }
        : {
            time: s.time as UTCTimestamp,
            position: 'aboveBar' as const,
            shape: 'arrowDown' as const,
            color: '#FF4D9A',
            text: '売り',
            size: 2,
          },
    )
    markersApi.current.setMarkers(markers)
  }, [histSignals])

  return <div className="chart-host" ref={hostRef} aria-label="価格チャート" />
}
