import { SESSION_PROFILES } from '../lib/apex'
import { BROKER_SPREAD_PIPS } from '../lib/filters'
import { SIMPLE } from '../lib/simpleSignal'

export function RulesPanel() {
  const sessions = [
    SESSION_PROFILES.tokyo,
    SESSION_PROFILES.london,
    SESSION_PROFILES.ny,
  ]
  return (
    <section className="rules-panel" aria-label="ルール">
      <h2>ルール</h2>
      <p className="rules-lead">
        {SIMPLE.stack} · 手動 · スプレッド前提 {BROKER_SPREAD_PIPS}p
      </p>
      <ol className="rules-list">
        <li>
          <strong>目標</strong>
          <span>
            単ペア約{SIMPLE.verified.tradesPerDay}回/日 · EV +
            {SIMPLE.verified.evPips}p · 日次約+{SIMPLE.verified.dailyPips}p
          </span>
        </li>
        <li>
          <strong>サイン</strong>
          <span>
            UTフリップ + SSL + DI + RSI · ADX≥{SIMPLE.adxMin}/
            {SIMPLE.adxPrime}
            （HTF・WTなし）
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
          <strong>操作</strong>
          <span>
            エントリーした → 建玉±pips表示 → 切ったらリセット（またはTP/SL記録）
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
