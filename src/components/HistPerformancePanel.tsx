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
          11月〜 Yahoo M1 · ATR決済シミュ（0.2p・1本のみ）
        </p>
      </div>

      <div className="hist-perf-verified">
        <span>検証 {SIMPLE.verified.period}</span>
        <span>{SIMPLE.verified.tradesPerDay.toFixed(1)}回/日</span>
        <span>勝率 {SIMPLE.verified.winRate.toFixed(0)}%</span>
        <span className={SIMPLE.verified.evPips >= 0 ? 'up' : 'down'}>
          EV {fmtPips(SIMPLE.verified.evPips)}
        </span>
        <span className={SIMPLE.verified.netPips >= 0 ? 'up' : 'down'}>
          {fmtPips(SIMPLE.verified.netPips)}
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
              平均勝ち {fmtPips(summary.avgWin)} / 平均負け{' '}
              {fmtPips(summary.avgLoss)}
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
                    {t.prime ? ' · 推奨' : ''}
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
