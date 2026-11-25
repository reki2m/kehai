import { useEffect, useRef } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type HistogramData,
  type LineData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { Candle } from '../lib/marketData'
import { bollinger, ema, macd, rsi } from '../lib/indicators'
import type { PairMeta } from '../lib/pairs'

export type OverlayId = 'ema' | 'bb' | 'macd' | 'rsi'

interface Props {
  candles: Candle[]
  pair: PairMeta
  overlays: OverlayId[]
}

export function PriceChart({ candles, pair, overlays }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null)
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
      chart.remove()
      chartRef.current = null
    }
  }, [pair.digits, pair.pip])

  const prevLen = useRef(0)
  const prevOverlays = useRef('')

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

    const overlayKey = overlays.slice().sort().join(',')
    // Fast path for 1s ticks: append/update last bar only
    if (
      prevLen.current > 0 &&
      overlayKey === prevOverlays.current &&
      candles.length >= prevLen.current &&
      candles.length - prevLen.current <= 1
    ) {
      candleSeries.current.update(lastBar)
      prevLen.current = candles.length
      chartRef.current?.timeScale().scrollToRealTime()
      return
    }
    prevOverlays.current = overlayKey

    const candleData: CandlestickData<Time>[] = candles.map((c) => ({
      time: c.time as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }))
    candleSeries.current.setData(candleData)
    prevLen.current = candles.length

    const showEma = overlays.includes('ema')
    const showBb = overlays.includes('bb')
    const showMacd = overlays.includes('macd')
    const showRsi = overlays.includes('rsi')

    if (emaFast.current && emaSlow.current) {
      if (showEma) {
        emaFast.current.setData(
          ema(candles, 21).map((p) => ({
            time: p.time as UTCTimestamp,
            value: p.value,
          })) as LineData<Time>[],
        )
        emaSlow.current.setData(
          ema(candles, 55).map((p) => ({
            time: p.time as UTCTimestamp,
            value: p.value,
          })) as LineData<Time>[],
        )
      } else {
        emaFast.current.setData([])
        emaSlow.current.setData([])
      }
    }

    if (bbUpper.current && bbMid.current && bbLower.current) {
      if (showBb) {
        const bands = bollinger(candles)
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
        const m = macd(candles)
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
        rsiLine.current.setData(
          rsi(candles).map((p) => ({
            time: p.time as UTCTimestamp,
            value: p.value,
          })) as LineData<Time>[],
        )
      } else {
        rsiLine.current.setData([])
      }
    }

    chartRef.current?.timeScale().scrollToRealTime()
  }, [candles, overlays])

  return <div className="chart-host" ref={hostRef} aria-label="価格チャート" />
}
