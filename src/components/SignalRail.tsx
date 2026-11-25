import type { EdgeSignal } from '../lib/edge'

interface Props {
  edge: EdgeSignal
  bid: string
  change: number
  changePct: number
  digits: number
}

export function SignalRail({ edge, bid, change, changePct, digits }: Props) {
  const tone =
    edge.action === 'LONG'
      ? 'bull'
      : edge.action === 'SHORT'
        ? 'bear'
        : edge.bias === 'bull'
          ? 'bull'
          : edge.bias === 'bear'
            ? 'bear'
            : 'neutral'

  return (
    <aside className="signal-rail" aria-label="KEHAI Edge シグナル">
      <div className={`confluence tone-${tone}`}>
        <p className="confluence-kicker">KEHAI Edge · スキャル</p>
        <div className="confluence-score">
          <span className="score-value">
            {edge.score > 0 ? '+' : ''}
            {edge.score}
          </span>
          <span className="score-label">{edge.label}</span>
        </div>

        <div className={`action-badge action-${edge.action.toLowerCase()}`}>
          {edge.action === 'LONG'
            ? 'LONG ENTRY'
            : edge.action === 'SHORT'
              ? 'SHORT ENTRY'
              : 'WAIT'}
        </div>

        <div className="meter" aria-hidden>
          <div
            className="meter-fill"
            style={{
              width: `${Math.min(100, Math.abs(edge.score))}%`,
              marginLeft:
                edge.score < 0
                  ? `${50 - Math.min(50, Math.abs(edge.score) / 2)}%`
                  : '50%',
              transform: edge.score < 0 ? 'translateX(-100%)' : undefined,
            }}
          />
          <div className="meter-mid" />
        </div>

        <div className="live-quote">
          <span className="quote-bid">{bid}</span>
          <span className={`quote-chg ${change >= 0 ? 'up' : 'down'}`}>
            {change >= 0 ? '+' : ''}
            {change.toFixed(digits)} ({changePct >= 0 ? '+' : ''}
            {changePct.toFixed(3)}%)
          </span>
        </div>

        {edge.atr > 0 && (
          <p className="risk-line">
            SL {edge.stopDistance.toFixed(digits)} · TP{' '}
            {edge.takeProfitDistance.toFixed(digits)}
            <span className="risk-hint">（ATR×1.2 / ×2.0）</span>
          </p>
        )}
      </div>

      <ul className="gate-list" aria-label="エントリーゲート">
        {edge.gates.map((g) => (
          <li key={g.id} className={g.ok ? 'gate-ok' : 'gate-off'}>
            <span className="gate-dot" aria-hidden />
            <span className="gate-name">{g.name}</span>
            <span className="gate-detail">{g.detail}</span>
          </li>
        ))}
      </ul>

      <ul className="signal-list">
        {edge.signals.map((s, i) => (
          <li
            key={`${s.id}-${i}`}
            className={`signal-item bias-${s.bias}`}
            style={{ animationDelay: `${80 + i * 40}ms` }}
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
