import { APEX_PARAMS, SESSION_PROFILES } from '../lib/apex'
import { BROKER_SPREAD_PIPS } from '../lib/filters'

export function RulesPanel() {
  const sessions = [SESSION_PROFILES.tokyo, SESSION_PROFILES.london, SESSION_PROFILES.ny]
  return (
    <section className="rules-panel" aria-label="売買ルール">
      <h2>売買ルール</h2>
      <p className="rules-lead">
        Triple Session Apex · UT×SSL · スプレッド {BROKER_SPREAD_PIPS}p 前提 · 実M1検証済み
      </p>
      <ol className="rules-list">
        <li>
          <strong>対象時間帯</strong>
          <span>
            東京・ロンドン・NYの3帯のみ。それ以外は待機（{APEX_PARAMS.family}）
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
          <strong>買い / 売り</strong>
          <span>
            UT Bot フリップ ＋ SSL同方向 ＋（セッション条件の VWAP / EMA）＋ ニュース帯外
          </span>
        </li>
        <li>
          <strong>時間足</strong>
          <span>1分と5分を同時評価し優勢側を適用。逆方向は衝突で待機</span>
        </li>
        <li>
          <strong>ドル円インパクト</strong>
          <span>
            EUR/USD・原油・日経・ダウ・VIXの短期圧力で順風加点 / 逆風見送り
          </span>
        </li>
        <li>
          <strong>見送り</strong>
          <span>時間外・ニュース・スプレッド拡大・UT未フリップ・フィルタ不一致・1m/5m衝突</span>
        </li>
      </ol>
    </section>
  )
}
