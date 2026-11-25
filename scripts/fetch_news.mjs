#!/usr/bin/env node
/** Fetch FF calendar + Investing RSS into public/live for GitHub Pages. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public', 'live')
mkdirSync(OUT, { recursive: true })

const SPEECH_RE =
  /speech|speak|speaks|remarks|testimony|press conference|FOMC|BoJ|BOJ|ECB|Fed |Powell|Ueda|Bailey|Lagarde|要人|講演|会見|声明/i
const TIER5_RE =
  /Non-Farm|NFP|Nonfarm|Interest Rate Decision|FOMC|Fed Rate|BoJ|BOJ Policy|Core PCE|CPI|GDP|Employment Change|Unemployment Rate|Powell|黒田|植田/i
const TIER4_RE =
  /Retail Sales|PPI|PMI|ISM|Durable Goods|Industrial Production|Consumer Confidence|JOLTS|Average Hourly|Building Permits|Housing Starts|Trade Balance|Flash GDP|Prelim GDP/i

function impactToImportance(impact, title, kind) {
  const speech = kind === 'speech' || SPEECH_RE.test(title)
  if (
    TIER5_RE.test(title) ||
    (speech && /Powell|Ueda|FOMC|BoJ|BOJ|ECB|Fed Chair/i.test(title))
  ) {
    return 5
  }
  if (impact === 'High' || (speech && impact === 'Medium')) {
    return TIER4_RE.test(title) || speech ? 5 : 4
  }
  if (impact === 'Medium' || TIER4_RE.test(title)) return 3
  if (impact === 'Low') return 2
  return 2
}

function pick(block, tag) {
  const m = block.match(
    new RegExp(
      `<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`,
    ),
  )
  return (m?.[1] ?? m?.[2] ?? '').trim()
}

function decode(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

const fetchedAt = Math.floor(Date.now() / 1000)

const calRes = await fetch(
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  { headers: { 'User-Agent': 'Mozilla/5.0 KEHAI-news' } },
)
if (!calRes.ok) throw new Error(`calendar ${calRes.status}`)
const rows = await calRes.json()
const events = []
for (const r of rows) {
  const country = (r.country ?? '').toUpperCase()
  if (!['USD', 'JPY', 'EUR', 'GBP'].includes(country)) continue
  const impact = r.impact ?? 'Low'
  if (impact === 'Holiday') continue
  const title = r.title ?? ''
  const t = Date.parse(r.date ?? '')
  if (!Number.isFinite(t)) continue
  const speech = SPEECH_RE.test(title)
  const kind = speech ? 'speech' : 'calendar'
  const importance = impactToImportance(impact, title, kind)
  if (importance < 2 && impact === 'Low' && !speech) continue
  events.push({
    id: `${Math.floor(t / 1000)}-${country}-${title}`,
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
events.sort((a, b) => a.time - b.time || b.importance - a.importance)

let headlines = []
try {
  const rssRes = await fetch('https://www.investing.com/rss/news_25.rss', {
    headers: { 'User-Agent': 'Mozilla/5.0 KEHAI-news' },
  })
  if (rssRes.ok) {
    const xml = await rssRes.text()
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 20)
    for (const m of items) {
      const block = m[1]
      const title = decode(pick(block, 'title'))
      const link = pick(block, 'link')
      const pub = pick(block, 'pubDate')
      const t = Date.parse(pub)
      if (!title) continue
      headlines.push({
        id: `${Number.isFinite(t) ? Math.floor(t / 1000) : fetchedAt}-${title.slice(0, 40)}`,
        time: Number.isFinite(t) ? Math.floor(t / 1000) : fetchedAt,
        title,
        link: link || undefined,
        kind: 'headline',
      })
    }
  }
} catch (e) {
  console.error('headlines fail', e.message || e)
}

writeFileSync(
  join(OUT, 'calendar.json'),
  JSON.stringify({ fetchedAt, events }),
)
writeFileSync(
  join(OUT, 'headlines.json'),
  JSON.stringify({ fetchedAt, headlines }),
)
console.log('news ok', {
  events: events.length,
  headlines: headlines.length,
  fetchedAt,
})
