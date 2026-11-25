import type { CalendarEvent, Headline } from '../lib/newsFeed'

interface Props {
  events: CalendarEvent[]
  headlines: Headline[]
  loading?: boolean
  error?: string | null
  alertIds?: Set<string>
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

function ImpBadge({ n }: { n: number }) {
  return (
    <span className={`imp-badge imp-${n}`} title={`重要度 ${n}/5`}>
      {n}
    </span>
  )
}

export function NewsPanel({ events, headlines, loading, error, alertIds }: Props) {
  const now = Date.now() / 1000
  const upcoming = events
    .filter((e) => e.time >= now - 3600)
    .sort((a, b) => a.time - b.time || b.importance - a.importance)
    .slice(0, 14)
  const speeches = events
    .filter((e) => e.kind === 'speech' && e.time >= now - 3600)
    .slice(0, 8)
  const soon = upcoming.filter((e) => e.time - now <= 5 * 60 && e.time >= now - 60)

  return (
    <aside className="news-panel" aria-label="ニュースと要人発言">
      <div className="news-head">
        <h2>News / Speeches</h2>
        <p className="news-source">
          重要度1–5 · 5分前/結果/要人/新着を読み上げ · FF · Investing · JST
        </p>
      </div>

      {loading && <p className="news-status">読み込み中…</p>}
      {error && <p className="news-status err">{error}</p>}

      {soon.length > 0 && (
        <section className="news-section news-soon">
          <h3>まもなく（5分以内）</h3>
          <ul className="news-list">
            {soon.map((e) => (
              <li
                key={`soon-${e.id}`}
                className={`news-item soon imp-row-${e.importance} ${alertIds?.has(e.id) ? 'alerted' : ''}`}
              >
                <ImpBadge n={e.importance} />
                <span className="news-time">{fmt(e.time)}</span>
                <span className="news-ccy">{e.country}</span>
                <span className="news-title">{e.title}</span>
                <span className="news-meta">
                  {e.previous ? `前 ${e.previous}` : ''}
                  {e.forecast ? ` · 予 ${e.forecast}` : ''}
                  {e.actual ? ` · 結 ${e.actual}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="news-section">
        <h3>要人発言・ハイインパクト</h3>
        <ul className="news-list">
          {(speeches.length
            ? speeches
            : upcoming.filter((e) => e.importance >= 4)
          )
            .slice(0, 6)
            .map((e) => (
              <li key={e.id} className={`news-item imp-row-${e.importance}`}>
                <ImpBadge n={e.importance} />
                <span className="news-time">{fmt(e.time)}</span>
                <span className="news-ccy">{e.country}</span>
                <span className="news-title">
                  {e.kind === 'speech' ? 'SPEECH · ' : ''}
                  {e.title}
                </span>
              </li>
            ))}
          {!loading && speeches.length === 0 && upcoming.filter((e) => e.importance >= 4).length === 0 && (
            <li className="news-item muted">直近の高重要度予定なし</li>
          )}
        </ul>
      </section>

      <section className="news-section">
        <h3>経済指標（重要度順）</h3>
        <ul className="news-list">
          {upcoming.slice(0, 10).map((e) => (
            <li key={`cal-${e.id}`} className={`news-item imp-row-${e.importance}`}>
              <ImpBadge n={e.importance} />
              <span className="news-time">{fmt(e.time)}</span>
              <span className="news-ccy">{e.country}</span>
              <span className="news-title">{e.title}</span>
              {(e.forecast || e.previous || e.actual) && (
                <span className="news-meta">
                  {e.previous ? `前 ${e.previous}` : ''}
                  {e.forecast ? ` · 予 ${e.forecast}` : ''}
                  {e.actual ? ` · 結 ${e.actual}` : ''}
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
