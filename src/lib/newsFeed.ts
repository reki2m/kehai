export type NewsImpact = 'High' | 'Medium' | 'Low' | 'Holiday' | string

export interface CalendarEvent {
  id: string
  time: number
  country: string
  title: string
  impact: NewsImpact
  forecast?: string
  previous?: string
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

interface FfRow {
  title?: string
  country?: string
  date?: string
  impact?: string
  forecast?: string
  previous?: string
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
    const impact = r.impact ?? 'Low'
    if (impact !== 'High' && impact !== 'Medium') continue
    const title = r.title ?? ''
    const t = Date.parse(r.date ?? '')
    if (!Number.isFinite(t)) continue
    const speech = SPEECH_RE.test(title)
    out.push({
      id: `${t}-${country}-${title}`,
      time: Math.floor(t / 1000),
      country,
      title,
      impact,
      forecast: r.forecast,
      previous: r.previous,
      kind: speech ? 'speech' : 'calendar',
    })
  }
  out.sort((a, b) => a.time - b.time)
  return out
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
  const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`))
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
