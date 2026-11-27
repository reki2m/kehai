import { SESSION_PROFILES } from '../lib/apex'
import { BROKER_SPREAD_PIPS } from '../lib/filters'
import { expectedBookPace } from '../lib/peakBook'
import { SIMPLE } from '../lib/simpleSignal'

export function RulesPanel() {
  const sessions = [
    SESSION_PROFILES.tokyo,
    SESSION_PROFILES.london,
    SESSION_PROFILES.ny,
  ]
  const book = expectedBookPace()
  return (
    <section className="rules-panel" aria-label="ルール">
      <h2>ルール</h2>
      <p className="rules-lead">
        {SIMPLE.stack} · 手動 · ペアごと1本 · スプレッド前提{' '}
        {BROKER_SPREAD_PIPS}p
      </p>
      <ol className="rules-list">
        <li>
          <strong>目標</strong>
          <span>
            日次+{SIMPLE.hunter.dailyPipsTarget}p帯 · Peak品質を{book.pairs}
            FXに横展開（単ペアでは物理的に届かない）
          </span>
        </li>
        <li>
          <strong>サイン</strong>
          <span>
            UTフリップ + SSL + HTF + DI + WT + RSI · ADX≥{SIMPLE.adxMin}/
            {SIMPLE.adxPrime}
          </span>
        </li>
        <li>
          <strong>決済</strong>
          <span>
            固定 SL{SIMPLE.slPips} / TP{SIMPLE.tpPips} · 最大
            {SIMPLE.maxHoldBars}本
          </span>
        </li>
        <li>
          <strong>机</strong>
          <span>
            単ペア約{SIMPLE.verified.tradesPerDay}回/日 · EV +
            {SIMPLE.verified.evPips}p · ブック約{book.tradesPerDay}回/日 · 日次約+
            {book.dailyEdge}p
          </span>
        </li>
        <li>
          <strong>READY</strong>
          <span>
            UTまで{SIMPLE.readyPips}p以内 → 監視のみ（まだ入らない）
          </span>
        </li>
        {sessions.map((s) => (
          <li key={s.id}>
            <strong>{s.labelJa}</strong>
            <span>
              {s.jst} · UT {s.utKey}/{s.utAtr}
              {s.requireVwap ? ' · VWAP' : ''}
              {s.requireEma ? ' · EMA' : ''}
            </span>
          </li>
        ))}
        <li>
          <strong>出典</strong>
          <span>{SIMPLE.sources.join(' / ')}</span>
        </li>
      </ol>
    </section>
  )
}
