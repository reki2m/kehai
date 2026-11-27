/**
 * Asia/Tokyo formatters for lightweight-charts axis + crosshair.
 * Candle times stay unix UTC; only labels are converted.
 */
import { TickMarkType, type Time } from 'lightweight-charts'

function pad2(n: string | number): string {
  return String(n).padStart(2, '0')
}

/** Resolve chart Time → unix seconds. */
export function timeToUnixSec(time: Time): number {
  if (typeof time === 'number' && Number.isFinite(time)) return time
  if (typeof time === 'string') {
    const ms = Date.parse(time)
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0
  }
  if (time && typeof time === 'object' && 'year' in time) {
    return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000)
  }
  return 0
}

export function toJstParts(unixSec: number): {
  y: string
  m: string
  day: string
  h: string
  min: string
} {
  const d = new Date(unixSec * 1000)
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
  const parts = fmt.formatToParts(d)
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? '00'
  return {
    y: get('year'),
    m: pad2(get('month')),
    day: pad2(get('day')),
    h: pad2(get('hour')),
    min: pad2(get('minute')),
  }
}

/** Crosshair / tooltip label — always JST. */
export function jstTimeFormatter(time: Time): string {
  const p = toJstParts(timeToUnixSec(time))
  return `${p.m}/${p.day} ${p.h}:${p.min}`
}

/** Time-axis tick labels — always JST (never fall back to UTC). */
export function jstTickMarkFormatter(
  time: Time,
  tickMarkType: TickMarkType | number,
  _locale: string,
): string {
  const p = toJstParts(timeToUnixSec(time))
  const kind = Number(tickMarkType)
  if (kind === TickMarkType.Year || kind === 0) return p.y
  if (kind === TickMarkType.Month || kind === 1) return `${p.y}/${p.m}`
  if (kind === TickMarkType.DayOfMonth || kind === 2) return `${p.m}/${p.day}`
  // Time / TimeWithSeconds / unknown → HH:mm JST
  return `${p.h}:${p.min}`
}

/** Wall-clock now in JST for the header. */
export function formatJstNow(ms: number = Date.now()): string {
  const p = toJstParts(Math.floor(ms / 1000))
  return `${p.h}:${p.min}`
}
