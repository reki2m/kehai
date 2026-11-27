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
            ベース（{SIMPLE.baseline.tradesPerDay}回 · 日次+
            {SIMPLE.baseline.dailyPips}p）超え · 実績約
            {SIMPLE.verified.tradesPerDay}回/日 · EV +{SIMPLE.verified.evPips}
            p · 日次約+{SIMPLE.verified.dailyPips}p
          </span>
        </li>
        <li>
          <strong>サイン</strong>
          <span>
            UTフリップ + SSL + WT + DI + RSI · ADX≥{SIMPLE.adxMin}/
            {SIMPLE.adxPrime}（HTFのみオフ）
          </span>
        </li>
        <li>
          <strong>決済</strong>
          <span>
            固定 SL{SIMPLE.slPips} / TP{SIMPLE.tpPips} · 最大
            {SIMPLE.maxHoldBars}本 · 1トレード上限−{SIMPLE.maxLossPips}p（自動SL）
          </span>
        </li>
        <li>
          <strong>日次ロス上限</strong>
          <span>
            本日ネット−{SIMPLE.dailyLossCapPips}pで新規停止（約3R · −96p放置禁止）
          </span>
        </li>
        <li>
          <strong>操作</strong>
          <span>
            エントリーした → 建玉±pips · SL/TP到達で自動記録 · 手動切はリセット可
          </span>
        </li>
        <li>
          <strong>関連チャート</strong>
          <span>
            原油・日経・ダウ・VIXは監視のみ（トレードしない）·
            ドル円と相関が立ったときだけ表示、関連終了で消す
          </span>
        </li>
        <li>
          <strong>Fusion監視</strong>
          <span>
            UT×SuperTrend×Squeeze×SMC×Lorentz の票読み · 5つANDは検証でPeakに負けたためエントリーには使わない
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
