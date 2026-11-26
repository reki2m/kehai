import { SESSION_PROFILES } from '../lib/apex'
import { BROKER_SPREAD_PIPS } from '../lib/filters'
import { SIMPLE } from '../lib/simpleSignal'

export function RulesPanel() {
  const sessions = [SESSION_PROFILES.tokyo, SESSION_PROFILES.london, SESSION_PROFILES.ny]
  return (
    <section className="rules-panel" aria-label="ルール">
      <h2>ルール</h2>
      <p className="rules-lead">
        {SIMPLE.stack} · 手動 · 1本のみ · SL/TP ATR連動 · スプレッド前提{' '}
        {BROKER_SPREAD_PIPS}p
      </p>
      <ol className="rules-list">
        <li>
          <strong>サイン</strong>
          <span>
            UTフリップ ＋ SSL確認 → BUY / SELL。確認済みでUTまで
            {SIMPLE.readyPips}p以内なら READY（まだ入らない）
          </span>
        </li>
        <li>
          <strong>品質ゲート</strong>
          <span>
            上位SSL + DI + WT + RSI · ADX≥{SIMPLE.adxMin}/
            {SIMPLE.adxPrime} · クール{SIMPLE.entryCooldownBars}本 ·
            目安{SIMPLE.verified.tradesPerDay}回/日 · 検証EV +
            {SIMPLE.verified.evPips}p
          </span>
        </li>
        <li>
          <strong>決済</strong>
          <span>
            ATR連動 · SL {SIMPLE.slMin}–{SIMPLE.slMax}p · TP {SIMPLE.tpMin}–
            {SIMPLE.tpMax}p（ボード表示に合わせる）
          </span>
        </li>
        <li>
          <strong>重複禁止</strong>
          <span>建玉中は新しいサインを無視</span>
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
