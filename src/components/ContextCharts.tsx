import { MiniPriceChart } from './MiniPriceChart'
import { getPair, type PairId } from '../lib/pairs'
import type { Candle } from '../lib/marketData'
import type { ContextLink } from '../lib/contextWatch'

interface Props {
  links: ContextLink[]
  series: Partial<Record<PairId, Candle[]>>
  loading?: boolean
}

/** Related context charts — top-right, watch only. */
export function ContextCharts({ links, series, loading }: Props) {
  const active = links.filter((l) => l.active)

  return (
    <section
      className={`context-charts context-charts-side${active.length ? ' has-active' : ''}`}
      aria-label="関連コンテキストチャート"
    >
      <div className="context-charts-head">
        <h2>関連</h2>
        <p className="context-charts-lead">
          {active.length > 0
            ? `原油・日経・ダウ・VIX · ${active.length}件ヒット`
            : '原油・日経・ダウ・VIX · 関連時のみ表示'}
        </p>
      </div>
      {loading && active.length === 0 && (
        <p className="context-charts-empty">監視中…</p>
      )}
      {!loading && active.length === 0 && (
        <p className="context-charts-empty">いま関連なし</p>
      )}
      {active.length > 0 && (
        <div className="context-charts-grid">
          {active.map((link) => {
            const pair = getPair(link.id)
            const candles = series[link.id] ?? []
            return (
              <article key={link.id} className="context-chart-card">
                <header className="context-chart-meta">
                  <h3>{pair.label}</h3>
                  <span
                    className={`context-corr ${link.corr >= 0 ? 'up' : 'down'}`}
                  >
                    {link.corr >= 0 ? '+' : ''}
                    {link.corr.toFixed(2)}
                  </span>
                  <span className="context-chg">
                    {link.changePct >= 0 ? '+' : ''}
                    {link.changePct.toFixed(2)}%
                  </span>
                </header>
                {candles.length >= 20 ? (
                  <MiniPriceChart candles={candles} pair={pair} />
                ) : (
                  <p className="context-charts-empty">足不足</p>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
