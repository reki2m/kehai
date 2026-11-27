import { useEffect, useRef } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  TickMarkType,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { Candle } from '../lib/marketData'
import type { PairMeta } from '../lib/pairs'

interface Props {
  candles: Candle[]
  pair: PairMeta
}

function toJstParts(sec: number) {
  const d = new Date(sec * 1000)
  const fmt = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(d)
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? ''
  return { m: get('month'), day: get('day'), h: get('hour'), min: get('minute') }
}

function jstTick(time: Time, type: TickMarkType): string | null {
  const sec =
    typeof time === 'number'
      ? time
      : typeof time === 'string'
        ? Math.floor(new Date(time).getTime() / 1000)
        : Date.UTC(time.year, time.month - 1, time.day) / 1000
  const p = toJstParts(sec)
  if (type === TickMarkType.DayOfMonth) return `${p.m}/${p.day}`
  return `${p.h}:${p.min}`
}

function toBars(candles: Candle[]): CandlestickData<Time>[] {
  return candles.map((c) => ({
    time: c.time as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }))
}

/** Compact context chart — no overlays, JST axis. */
export function MiniPriceChart({ candles, pair }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: 'rgba(214, 228, 232, 0.55)',
        fontFamily: "'IBM Plex Mono', monospace",
        fontSize: 10,
        attributionLogo: false,
      },
      localization: {
        locale: 'ja-JP',
        timeFormatter: (time: Time) => {
          const sec =
            typeof time === 'number'
              ? time
              : typeof time === 'string'
                ? Math.floor(new Date(time).getTime() / 1000)
                : Date.UTC(time.year, time.month - 1, time.day) / 1000
          const p = toJstParts(sec)
          return `${p.h}:${p.min}`
        },
      },
      grid: {
        vertLines: { color: 'rgba(148, 185, 198, 0.06)' },
        horzLines: { color: 'rgba(148, 185, 198, 0.08)' },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.08, bottom: 0.08 },
        minimumWidth: 48,
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
        barSpacing: 5,
        tickMarkFormatter: jstTick,
      },
      crosshair: { mode: 0 },
      width: el.clientWidth,
      height: el.clientHeight,
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#26A69A',
      downColor: '#EF5350',
      borderUpColor: '#26A69A',
      borderDownColor: '#EF5350',
      wickUpColor: '#26A69A',
      wickDownColor: '#EF5350',
      priceLineVisible: false,
      lastValueVisible: true,
      priceFormat: {
        type: 'price',
        precision: pair.digits,
        minMove: pair.pip,
      },
    })
    chartRef.current = chart
    seriesRef.current = series

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
      seriesRef.current = null
    }
  }, [pair.digits, pair.pip])

  useEffect(() => {
    if (!seriesRef.current || !chartRef.current) return
    const slice = candles.length > 90 ? candles.slice(-90) : candles
    if (slice.length < 2) return
    seriesRef.current.setData(toBars(slice))
    try {
      chartRef.current.timeScale().fitContent()
    } catch {
      /* ignore */
    }
  }, [candles])

  return <div className="mini-chart-host" ref={hostRef} />
}
