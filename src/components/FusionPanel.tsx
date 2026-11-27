import type { FusionConfluence } from '../lib/fusionConfluence'
import { FUSION } from '../lib/fusionSignal'

interface Props {
  fusion: FusionConfluence | null
  loading?: boolean
}

/** Watch-only desk: popular TV concepts as votes (Peak Drive stays the trigger). */
export function FusionPanel({ fusion, loading }: Props) {
  return (
    <section className="fusion-panel" aria-label="Fusion監視">
      <div className="fusion-head">
        <h2>Fusion監視</h2>
        <p className="fusion-lead">{FUSION.stack} · 監視のみ</p>
      </div>
      {loading && !fusion && <p className="fusion-empty">計算中…</p>}
      {fusion && (
        <>
          <p
            className={`fusion-score ${
              fusion.aligned === 'BUY'
                ? 'up'
                : fusion.aligned === 'SELL'
                  ? 'down'
                  : ''
            }`}
          >
            {fusion.aligned
              ? `合意 ${fusion.aligned}`
              : `票 ${fusion.bull}↑ ${fusion.bear}↓`}
            <span> score {fusion.score >= 0 ? '+' : ''}
              {fusion.score}</span>
          </p>
          <ul className="fusion-votes">
            {fusion.votes.map((v) => (
              <li key={v.id} className={`fusion-vote ${v.bias}`}>
                <span className="fusion-vote-name">
                  {v.name}
                  <em>{v.role}</em>
                </span>
                <span className="fusion-vote-detail">{v.detail}</span>
              </li>
            ))}
          </ul>
          <p className="fusion-note">
            5つANDは検証でPeak Driveに負けたため、エントリーはPeakのまま。ここは合意度の参考。
          </p>
        </>
      )}
    </section>
  )
}
