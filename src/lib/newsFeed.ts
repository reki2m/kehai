export type NewsImpact = 'High' | 'Medium' | 'Low' | 'Holiday' | string

/** 1 = ほぼ無視 … 5 = 必須回避級 */
export type Importance = 1 | 2 | 3 | 4 | 5

export interface CalendarEvent {
  id: string
  time: number
  country: string
  title: string
  impact: NewsImpact
  importance: Importance
  forecast?: string
  previous?: string
  actual?: string
  kind: 'calendar' | 'speech' | 'headline'
}

export interface Headline {
  id: string
  time: number
  title: string
  link?: string
  kind: 'headline'
}

const SPEECH_RE =
  /speech|speak|speaks|remarks|testimony|press conference|FOMC|BoJ|BOJ|ECB|Fed |Powell|Ueda|Bailey|Lagarde|要人|講演|会見|声明/i

const TIER5_RE =
  /Non-Farm|NFP|Nonfarm|Interest Rate Decision|FOMC|Fed Rate|BoJ|BOJ Policy|Core PCE|CPI|GDP|Employment Change|Unemployment Rate|Powell|黒田|植田/i

const TIER4_RE =
  /Retail Sales|PPI|PMI|ISM|Durable Goods|Industrial Production|Consumer Confidence|JOLTS|Average Hourly|Building Permits|Housing Starts|Trade Balance|Flash GDP|Prelim GDP/i

interface FfRow {
  title?: string
  country?: string
  date?: string
  impact?: string
  forecast?: string
  previous?: string
  actual?: string
}

export function impactToImportance(
  impact: NewsImpact,
  title: string,
  kind: CalendarEvent['kind'],
): Importance {
  const speech = kind === 'speech' || SPEECH_RE.test(title)
  if (TIER5_RE.test(title) || (speech && /Powell|Ueda|FOMC|BoJ|BOJ|ECB|Fed Chair/i.test(title))) {
    return 5
  }
  if (impact === 'High' || (speech && impact === 'Medium')) {
    return TIER4_RE.test(title) || speech ? 5 : 4
  }
  if (impact === 'Medium' || TIER4_RE.test(title)) return 3
  if (impact === 'Low') return 2
  if (impact === 'Holiday') return 1
  return 2
}

/** Forex Factory calendar (USD/JPY focus) via faireconomy mirror. */
export async function fetchCalendarEvents(): Promise<CalendarEvent[]> {
  const res = await fetch('/api/ff/ff_calendar_thisweek.json')
  if (!res.ok) throw new Error(`calendar ${res.status}`)
  const rows = (await res.json()) as FfRow[]
  const out: CalendarEvent[] = []
  for (const r of rows) {
    const country = (r.country ?? '').toUpperCase()
    if (!['USD', 'JPY', 'EUR', 'GBP'].includes(country)) continue
    const impact = (r.impact ?? 'Low') as NewsImpact
    if (impact === 'Holiday') continue
    const title = r.title ?? ''
    const t = Date.parse(r.date ?? '')
    if (!Number.isFinite(t)) continue
    const speech = SPEECH_RE.test(title)
    const kind = speech ? 'speech' : 'calendar'
    const importance = impactToImportance(impact, title, kind)
    // Keep Low (2+) for display; UI filters further
    if (importance < 2 && impact === 'Low' && !speech) continue
    out.push({
      id: `${t}-${country}-${title}`,
      time: Math.floor(t / 1000),
      country,
      title,
      impact,
      importance,
      forecast: r.forecast || undefined,
      previous: r.previous || undefined,
      actual: r.actual || undefined,
      kind,
    })
  }
  out.sort((a, b) => a.time - b.time || b.importance - a.importance)
  return out
}

/** Events due within leadSec that meet minImportance (default 3). */
export function eventsDueSoon(
  events: CalendarEvent[],
  nowSec = Date.now() / 1000,
  leadSec = 5 * 60,
  minImportance: Importance = 3,
): CalendarEvent[] {
  return events.filter(
    (e) =>
      e.importance >= minImportance &&
      e.time - nowSec <= leadSec &&
      e.time - nowSec > -30,
  )
}

/** Investing.com FX news headlines (RSS). */
export async function fetchHeadlines(): Promise<Headline[]> {
  const res = await fetch('/api/investing-rss/rss/news_25.rss')
  if (!res.ok) throw new Error(`rss ${res.status}`)
  const xml = await res.text()
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 20)
  const out: Headline[] = []
  for (const m of items) {
    const block = m[1]
    const title = decode(pick(block, 'title'))
    const link = pick(block, 'link')
    const pub = pick(block, 'pubDate')
    const t = Date.parse(pub)
    if (!title) continue
    out.push({
      id: `${t}-${title.slice(0, 40)}`,
      time: Number.isFinite(t) ? Math.floor(t / 1000) : Date.now() / 1000,
      title,
      link: link || undefined,
      kind: 'headline',
    })
  }
  return out
}

function pick(block: string, tag: string): string {
  const m = block.match(
    new RegExp(
      `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    ),
  )
  return (m?.[1] ?? m?.[2] ?? '').trim()
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}
