/**
 * 急変時の原因推定（指標・要人・ヘッドライン・時間帯）。
 * 確定診断ではなく、その場で使える仮説を返す。
 */

import { newsBlackout } from './filters'
import type { CalendarEvent, Headline } from './newsFeed'
import type { ShockHit } from './shockDetect'

export interface ShockCauseReport {
  /** トップ表示用の一行要約 */
  summary: string
  /** 補足（最大3） */
  details: string[]
  confidence: 'high' | 'medium' | 'low'
  primaryTitle?: string
}

function parseFigure(v?: string): number | null {
  if (!v) return null
  const n = Number.parseFloat(v.replace(/[%KMB,]/gi, '').trim())
  return Number.isFinite(n) ? n : null
}

function resultNote(e: CalendarEvent): string | null {
  if (!e.actual) return null
  const a = parseFigure(e.actual)
  const f = parseFigure(e.forecast)
  const base = `結果 ${e.actual}`
  if (a == null || f == null) {
    return e.forecast ? `${base}（予想 ${e.forecast}）` : base
  }
  if (Math.abs(a - f) < 1e-9) return `${base}・予想どおり`
  return a > f ? `${base}・予想上振れ` : `${base}・予想下振れ`
}

function sessionHintJa(nowSec: number): string {
  const jst = new Date((nowSec + 9 * 3600) * 1000)
  const hm = jst.getUTCHours() * 60 + jst.getUTCMinutes()
  // rough JST bands
  if (hm >= 9 * 60 && hm < 12 * 60) return '東京時間帯'
  if (hm >= 15 * 60 && hm < 17 * 60) return '欧州オープン前後'
  if (hm >= 17 * 60 && hm < 19 * 60) return 'ロンドン時間帯'
  if (hm >= 21 * 60 && hm < 23 * 60) return 'NYオープン前後'
  if (hm >= 23 * 60 || hm < 60) return 'NY時間帯'
  if (hm >= 2 * 60 && hm < 6 * 60) return '流動性の薄い時間帯'
  return '通常時間帯'
}

function minsAgo(eventSec: number, nowSec: number): string {
  const m = Math.round((nowSec - eventSec) / 60)
  if (m <= 0) return '直前'
  if (m < 60) return `${m}分前`
  return `${Math.round(m / 60)}時間前`
}

const HEADLINE_RE =
  /ドル|円|ドル円|FRB|FOMC|日銀|金利|雇用|CPI|PCE|利上げ|利下げ|パウエル|植田|介入|債券|米国債/i

/**
 * 急変ヒットに対し、カレンダー・ニュースから原因候補を組み立てる。
 */
export function investigateShockCause(opts: {
  hit: ShockHit
  events: CalendarEvent[]
  headlines: Headline[]
  nowSec?: number
}): ShockCauseReport {
  const now = opts.nowSec ?? Date.now() / 1000
  const lookback = Math.max(opts.hit.windowSec, 60) + 15 * 60
  const lookfwd = 3 * 60
  const dirJa = opts.hit.direction === 'UP' ? '急騰' : '急落'
  const details: string[] = []

  const nearby = opts.events
    .filter(
      (e) =>
        e.importance >= 3 &&
        e.time >= now - lookback &&
        e.time <= now + lookfwd,
    )
    .sort((a, b) => {
      const prox = Math.abs(a.time - now) - Math.abs(b.time - now)
      if (prox !== 0) return prox
      return b.importance - a.importance
    })

  const primary = nearby[0]
  const blackout = newsBlackout(now)
  const session = sessionHintJa(now)

  let summary: string
  let confidence: ShockCauseReport['confidence'] = 'low'
  let primaryTitle: string | undefined

  if (primary) {
    primaryTitle = primary.title
    const when =
      primary.time <= now
        ? minsAgo(primary.time, now)
        : `約${Math.max(0, Math.round((primary.time - now) / 60))}分後`
    const kind = primary.kind === 'speech' ? '要人発言' : '経済指標'
    const result = resultNote(primary)
    confidence = primary.importance >= 4 || result ? 'high' : 'medium'
    summary = result
      ? `${dirJa}の主因候補: ${primary.country} ${primary.title}（${when}・${result}）`
      : `${dirJa}の主因候補: ${kind}「${primary.country} ${primary.title}」（${when}・重要度${primary.importance}）`
    details.push(
      `${kind} · 重要度${primary.importance} · ${when}`,
    )
    if (result) details.push(result)
    if (primary.forecast && !primary.actual) {
      details.push(`予想 ${primary.forecast}${primary.previous ? ` · 前回 ${primary.previous}` : ''}`)
    }
  } else if (blackout) {
    confidence = 'medium'
    summary = `${dirJa}の主因候補: 高インパクト窓「${blackout.label}」中の値動き`
    details.push(`ブラックアウト帯: ${blackout.label}`)
  } else {
    summary = `${dirJa}の主因: 明確な指標トリガーは未検出（${session}のフロー急変の可能性）`
    details.push('直近の高重要度指標・発言と時刻が一致せず')
  }

  // 追加の近傍イベント
  for (const e of nearby.slice(1, 3)) {
    const note = resultNote(e)
    details.push(
      `併発: ${e.country} ${e.title}${note ? `（${note}）` : ''}`,
    )
  }

  const freshHead = opts.headlines
    .filter((h) => h.time >= now - 45 * 60 && HEADLINE_RE.test(h.title))
    .sort((a, b) => b.time - a.time)[0]
  if (freshHead) {
    details.push(`関連ニュース: ${freshHead.title}`)
    if (confidence === 'low') {
      confidence = 'medium'
      summary = `${dirJa}の主因候補: ニュース「${freshHead.title}」`
      primaryTitle = freshHead.title
    }
  }

  details.push(
    `変動 ${opts.hit.pips.toFixed(0)}p / ${opts.hit.label} · ${session}`,
  )

  return {
    summary,
    details: details.slice(0, 4),
    confidence,
    primaryTitle,
  }
}
