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
        {SIMPLE.stack} · 手動 · 1本のみ · スプレッド前提 {BROKER_SPREAD_PIPS}p
      </p>
      <ol className="rules-list">
        <li>
          <strong>設計</strong>
          <span>
            回数を減らして勝率を盛らない。本命でエッジ、デイで手数。サイズでリスクを分ける
          </span>
        </li>
        <li>
          <strong>本命</strong>
          <span>
            UTフリップ + 全確認 · ADX≥{SIMPLE.adxMin}/{SIMPLE.adxPrime} ·
            RR≈{SIMPLE.tpRr} · サイズ×{SIMPLE.honmeiSize} · 約
            {SIMPLE.dayDesk.honmeiPerDay}回/日
          </span>
        </li>
        <li>
          <strong>デイ</strong>
          <span>
            UT（ADX≥{SIMPLE.dayAdxMin}/{SIMPLE.dayAdxOff}）または STパルス（ADX≥
            {SIMPLE.adxPulse}/{SIMPLE.adxPulseOff}）· RR≈{SIMPLE.dayTpRr} ·
            サイズ×{SIMPLE.daySize} · 約{SIMPLE.dayDesk.dayPerDay}回/日
          </span>
        </li>
        <li>
          <strong>READY</strong>
          <span>
            本命品質でUTまで{SIMPLE.readyPips}p以内 → 監視のみ（まだ入らない）
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
