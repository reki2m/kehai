import type { HistTradeSummary } from '../lib/histTrades'
import { SIMPLE } from '../lib/simpleSignal'

interface Props {
  summary: HistTradeSummary | null
  loading?: boolean
}

function fmtPips(v: number): string {
  const s = v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1)
  return `${s}p`
}

function fmtTime(unix: number): string {
  return new Date(unix * 1000).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function HistPerformancePanel({ summary, loading }: Props) {
  const recent = summary?.trades.slice(-12).reverse() ?? []

  return (
    <section className="hist-perf" aria-label="過去トレード成績">
      <div className="hist-perf-head">
        <h2>過去成績</h2>
        <p className="hist-perf-lead">
          表示ペア · Peak Hunter · SL{SIMPLE.slPips}/TP{SIMPLE.tpPips} シミュ
        </p>
      </div>

      <div className="hist-perf-verified">
        <span>単ペア {SIMPLE.verified.period}</span>
        <span>{SIMPLE.verified.tradesPerDay.toFixed(1)}回/日</span>
        <span className="up">日次約{fmtPips(SIMPLE.verified.dailyPips)}</span>
        <span className="up">EV {fmtPips(SIMPLE.verified.evPips)}</span>
      </div>
      <div className="hist-perf-verified book">
        <span>Hunter {SIMPLE.hunter.pairs}FX</span>
        <span>目安{SIMPLE.hunter.tradesPerDay}回/日</span>
        <span className="up">
          日次目標+{SIMPLE.hunter.dailyPipsTarget}p
        </span>
        <span className="up">
          期待+{SIMPLE.hunter.dailyPipsExpected}p
        </span>
      </div>

      {loading && <p className="hist-perf-empty">集計中…</p>}
      {!loading && (!summary || summary.n === 0) && (
        <p className="hist-perf-empty">まだシミュできるサインがありません</p>
      )}

      {summary && summary.n > 0 && (
        <>
          <div className="hist-perf-total">
            <span className={summary.netPips >= 0 ? 'up' : 'down'}>
              合計 {fmtPips(summary.netPips)}
            </span>
            <span>勝率 {summary.winRate.toFixed(0)}%</span>
            <span className={summary.evPips >= 0 ? 'up' : 'down'}>
              EV {fmtPips(summary.evPips)}
            </span>
            <span>
              {summary.tradesPerDay.toFixed(1)}回/日 · {summary.n}本
            </span>
          </div>
          <div className="hist-perf-sub">
            <span>
              日次平均{' '}
              {summary.days
                ? fmtPips(
                    Math.round((summary.netPips / summary.days) * 10) / 10,
                  )
                : '—'}
            </span>
            <span>
              {summary.wins}勝 {summary.losses}敗 · {summary.days}営業日
            </span>
          </div>

          <ul className="hist-perf-rows">
            {recent.map((t) => (
              <li key={`${t.entryTime}-${t.side}`} className="hist-perf-row">
                <div className="hist-perf-row-top">
                  <strong className={t.side === 'BUY' ? 'up' : 'down'}>
                    {t.side}
                  </strong>
                  <span className={t.pnlPips >= 0 ? 'up' : 'down'}>
                    {fmtPips(t.pnlPips)}
                  </span>
                  <span className="hist-perf-reason">{t.reason}</span>
                </div>
                <div className="hist-perf-row-meta">
                  <span>{fmtTime(t.entryTime)}</span>
                  <span>
                    SL{t.slPips}/TP{t.tpPips}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}
