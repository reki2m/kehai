import type { CalendarEvent, Headline } from '../lib/newsFeed'

interface Props {
  events: CalendarEvent[]
  headlines: Headline[]
  loading?: boolean
  error?: string | null
}

function fmt(ts: number) {
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ts * 1000))
}

export function NewsPanel({ events, headlines, loading, error }: Props) {
  const now = Date.now() / 1000
  const upcoming = events.filter((e) => e.time >= now - 3600).slice(0, 12)
  const speeches = events.filter((e) => e.kind === 'speech').slice(0, 8)

  return (
    <aside className="news-panel" aria-label="ニュースと要人発言">
      <div className="news-head">
        <h2>News / Speeches</h2>
        <p className="news-source">FFカレンダー · Investing FX · Asia/Tokyo</p>
      </div>

      {loading && <p className="news-status">読み込み中…</p>}
      {error && <p className="news-status err">{error}</p>}

      <section className="news-section">
        <h3>要人発言・ハイインパクト</h3>
        <ul className="news-list">
          {(speeches.length ? speeches : upcoming.filter((e) => e.impact === 'High'))
            .slice(0, 6)
            .map((e) => (
              <li key={e.id} className={`news-item impact-${e.impact.toLowerCase()}`}>
                <span className="news-time">{fmt(e.time)}</span>
                <span className="news-ccy">{e.country}</span>
                <span className="news-title">
                  {e.kind === 'speech' ? 'SPEECH · ' : ''}
                  {e.title}
                </span>
              </li>
            ))}
          {!loading && speeches.length === 0 && upcoming.length === 0 && (
            <li className="news-item muted">直近の高インパクト予定なし</li>
          )}
        </ul>
      </section>

      <section className="news-section">
        <h3>経済指標（USD/JPY関連）</h3>
        <ul className="news-list">
          {upcoming.slice(0, 8).map((e) => (
            <li key={`cal-${e.id}`} className={`news-item impact-${e.impact.toLowerCase()}`}>
              <span className="news-time">{fmt(e.time)}</span>
              <span className="news-ccy">{e.country}</span>
              <span className="news-title">{e.title}</span>
              {(e.forecast || e.previous) && (
                <span className="news-meta">
                  {e.forecast ? `予 ${e.forecast}` : ''}
                  {e.previous ? ` · 前 ${e.previous}` : ''}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="news-section">
        <h3>FXヘッドライン</h3>
        <ul className="news-list">
          {headlines.slice(0, 8).map((h) => (
            <li key={h.id} className="news-item">
              <span className="news-time">{fmt(h.time)}</span>
              {h.link ? (
                <a className="news-title link" href={h.link} target="_blank" rel="noreferrer">
                  {h.title}
                </a>
              ) : (
                <span className="news-title">{h.title}</span>
              )}
            </li>
          ))}
          {!loading && headlines.length === 0 && (
            <li className="news-item muted">ヘッドライン未取得</li>
          )}
        </ul>
      </section>
    </aside>
  )
}
