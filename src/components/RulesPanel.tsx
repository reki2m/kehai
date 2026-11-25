import { APEX_PARAMS, SESSION_PROFILES } from '../lib/apex'
import { BROKER_SPREAD_PIPS } from '../lib/filters'
import { GRAIL } from '../lib/grail'

export function RulesPanel() {
  const sessions = [SESSION_PROFILES.tokyo, SESSION_PROFILES.london, SESSION_PROFILES.ny]
  return (
    <section className="rules-panel" aria-label="売買ルール">
      <h2>売買ルール</h2>
      <p className="rules-lead">
        {GRAIL.name} · UT×SSL · スプレッド {BROKER_SPREAD_PIPS}p · スリッ耐性 {GRAIL.assumeSlipPips}p
      </p>
      <ol className="rules-list">
        <li>
          <strong>対象時間帯</strong>
          <span>
            東京・ロンドン・NYの3帯のみ（{APEX_PARAMS.family}）
          </span>
        </li>
        {sessions.map((s) => (
          <li key={s.id}>
            <strong>{s.labelJa}</strong>
            <span>
              {s.jst} · UT {s.utKey}/{s.utAtr} · SL {s.slPips} / TP {s.tpPips}p
              {s.requireVwap ? ' · VWAP必須' : ''}
              {s.requireEma ? ' · EMA21/55必須' : ''}
              · スプレッド≤{s.maxSpread}p
            </span>
          </li>
        ))}
        <li>
          <strong>Grailリスク</strong>
          <span>
            TP×{GRAIL.tpMult}済 · 日次ロス上限 −{GRAIL.dailyLossCapPips}p · 観測ズレ&gt;
            {GRAIL.maxSlipPips}pで停止 · デモ{GRAIL.demoLot}lot
          </span>
        </li>
        <li>
          <strong>買い / 売り</strong>
          <span>
            UT Bot フリップ ＋ SSL同方向 ＋（VWAP / EMA）＋ ニュース帯外
          </span>
        </li>
        <li>
          <strong>時間足 / インパクト</strong>
          <span>1m/5m優勢適用 · 関連市場逆風はドル円見送り</span>
        </li>
      </ol>
    </section>
  )
}
