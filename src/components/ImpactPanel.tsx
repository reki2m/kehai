import type { UsdJpyImpact } from '../lib/usdjpyImpact'
import { getPair } from '../lib/pairs'

interface Props {
  impact: UsdJpyImpact
  loading?: boolean
}

export function ImpactPanel({ impact, loading }: Props) {
  const tone =
    impact.bias === 'usd_bull' ? 'bull' : impact.bias === 'usd_bear' ? 'bear' : 'neutral'

  return (
    <section className={`impact-panel tone-${tone}`} aria-label="ドル円への影響評価">
      <div className="impact-head">
        <h2>ドル円への影響</h2>
        <p className="impact-lead">
          原油・日経・ダウ・VIXがドル円に与える短期圧力（監視のみ・非トレード）
        </p>
      </div>

      {loading && <p className="impact-status">関連銘柄を取得中…</p>}

      <div className="impact-score-row">
        <span className="impact-score">
          {impact.score > 0 ? '+' : ''}
          {impact.score}
        </span>
        <div>
          <p className="impact-label">{impact.label}</p>
          <p className="impact-summary">{impact.summary}</p>
        </div>
      </div>

      <ul className="impact-list">
        {impact.drivers.map((d) => {
          const pair = getPair(d.id)
          return (
            <li key={d.id} className={`impact-item ${d.score >= 0 ? 'push-up' : 'push-down'}`}>
              <div className="impact-item-head">
                <span className="impact-name">{d.label}</span>
                <span className="impact-chg">
                  {d.changePct >= 0 ? '+' : ''}
                  {d.changePct.toFixed(2)}%
                </span>
                <span className="impact-contrib">
                  {d.score > 0 ? '+' : ''}
                  {d.score}
                </span>
              </div>
              <p className="impact-why">{d.why}</p>
              {d.last != null && (
                <p className="impact-last">
                  現在値 {d.last.toFixed(pair.digits)}
                </p>
              )}
              <div className="impact-bar" aria-hidden>
                <div
                  className="impact-bar-fill"
                  style={{
                    width: `${Math.min(100, Math.abs(d.score))}%`,
                    marginLeft: d.score < 0 ? `${50 - Math.min(50, Math.abs(d.score) / 2)}%` : '50%',
                    transform: d.score < 0 ? 'translateX(-100%)' : undefined,
                  }}
                />
                <div className="impact-bar-mid" />
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
