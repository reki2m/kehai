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
            UT Bot フリップ ＋ SSL 確認 → BUY / SELL。確認済みでUTまで
            {SIMPLE.readyPips}p以内なら READY（買い/売り目安の数値を表示・まだ入らない）
          </span>
        </li>
        <li>
          <strong>品質ゲート</strong>
          <span>
            ADX≥{SIMPLE.adxMin} · ATR≥{SIMPLE.minAtrPips}p · 帯端
            {SIMPLE.sessionEdgeMin}分カット · WaveTrend強い逆行は見送り ·
            「推奨」= DI+上位SSL({SIMPLE.htfSslLen})+WT一致（★優先・標準は任意）
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
