import { MiniPriceChart } from './MiniPriceChart'
import { getPair, type PairId } from '../lib/pairs'
import type { Candle } from '../lib/marketData'
import type { ContextLink } from '../lib/contextWatch'

interface Props {
  links: ContextLink[]
  series: Partial<Record<PairId, Candle[]>>
  loading?: boolean
}

/** Related context charts — watch only, never trade. */
export function ContextCharts({ links, series, loading }: Props) {
  const active = links.filter((l) => l.active)
  if (!loading && active.length === 0) return null

  return (
    <section className="context-charts" aria-label="関連コンテキストチャート">
      <div className="context-charts-head">
        <h2>関連チャート</h2>
        <p className="context-charts-lead">
          原油・日経・ダウ・VIX · トレード対象外 · ドル円と動きが関連するときだけ表示
        </p>
      </div>
      {loading && active.length === 0 && (
        <p className="context-charts-empty">関連銘柄を監視中…</p>
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
                    corr {link.corr >= 0 ? '+' : ''}
                    {link.corr.toFixed(2)}
                  </span>
                  <span className="context-chg">
                    {link.changePct >= 0 ? '+' : ''}
                    {link.changePct.toFixed(2)}%
                  </span>
                </header>
                <p className="context-reason">{link.reason}</p>
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
