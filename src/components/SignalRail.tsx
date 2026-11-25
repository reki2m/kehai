import type { Confluence } from '../lib/signals'

interface Props {
  confluence: Confluence
  bid: string
  change: number
  changePct: number
}

export function SignalRail({ confluence, bid, change, changePct }: Props) {
  const tone =
    confluence.bias === 'bull'
      ? 'bull'
      : confluence.bias === 'bear'
        ? 'bear'
        : 'neutral'

  return (
    <aside className="signal-rail" aria-label="インジケータ・シグナル">
      <div className={`confluence tone-${tone}`}>
        <p className="confluence-kicker">気配スコア</p>
        <div className="confluence-score">
          <span className="score-value">
            {confluence.score > 0 ? '+' : ''}
            {confluence.score}
          </span>
          <span className="score-label">{confluence.label}</span>
        </div>
        <div className="meter" aria-hidden>
          <div
            className="meter-fill"
            style={{
              width: `${Math.min(100, Math.abs(confluence.score))}%`,
              marginLeft:
                confluence.score < 0
                  ? `${50 - Math.min(50, Math.abs(confluence.score) / 2)}%`
                  : '50%',
              transform: confluence.score < 0 ? 'translateX(-100%)' : undefined,
            }}
          />
          <div className="meter-mid" />
        </div>
        <div className="live-quote">
          <span className="quote-bid">{bid}</span>
          <span className={`quote-chg ${change >= 0 ? 'up' : 'down'}`}>
            {change >= 0 ? '+' : ''}
            {change.toFixed(Math.max(3, bid.includes('.') ? bid.split('.')[1]?.length ?? 3 : 3))}{' '}
            ({changePct >= 0 ? '+' : ''}
            {changePct.toFixed(3)}%)
          </span>
        </div>
      </div>

      <ul className="signal-list">
        {confluence.signals.map((s, i) => (
          <li
            key={s.id}
            className={`signal-item bias-${s.bias}`}
            style={{ animationDelay: `${80 + i * 60}ms` }}
          >
            <div className="signal-head">
              <span className="signal-name">{s.name}</span>
              <span className="signal-bias">
                {s.bias === 'bull' ? 'BUY' : s.bias === 'bear' ? 'SELL' : 'FLAT'}
              </span>
            </div>
            <p className="signal-detail">{s.detail}</p>
            <div className="strength" aria-hidden>
              <div
                className="strength-fill"
                style={{ width: `${Math.round(s.strength * 100)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </aside>
  )
}
