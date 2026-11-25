import { APEX_PARAMS } from '../lib/apex'
import { BROKER_SPREAD_PIPS } from '../lib/filters'

export function RulesPanel() {
  const p = APEX_PARAMS
  return (
    <section className="rules-panel" aria-label="売買ルール">
      <h2>売買ルール</h2>
      <p className="rules-lead">
        UT Bot × SSL · FXはスプレッド {BROKER_SPREAD_PIPS}p 前提 · 原油・指数・VIXは銘柄別pts
      </p>
      <ol className="rules-list">
        <li>
          <strong>時間帯</strong>
          <span>London Mid のみ（08:30–10:00 UTC ＝ 17:30–19:00 JST）</span>
        </li>
        <li>
          <strong>時間足選択</strong>
          <span>
            1分足と5分足の UT×SSL を同時評価し、優勢側を適用。逆方向エントリーは衝突で待機
          </span>
        </li>
        <li>
          <strong>買い（LONG）</strong>
          <span>
            UT Bot({p.utKey}/{p.utAtr}) が買いフリップ かつ SSLが買い側 かつ 終値 ≥ Session
            VWAP かつ スプレッド ≤ {p.maxSpread}p かつ ニュース帯外
          </span>
        </li>
        <li>
          <strong>売り（SHORT）</strong>
          <span>
            UT Bot 売りフリップ かつ SSL売り側 かつ 終値 ≤ VWAP かつ同上フィルタ
          </span>
        </li>
        <li>
          <strong>損切り / 利確</strong>
          <span>
            FX: SL {p.slPips} / TP {p.tpPips} pips。原油・日経・ダウ・VIXは銘柄ごとのポイント幅（2R）
          </span>
        </li>
        <li>
          <strong>指標通知</strong>
          <span>重要度3以上を約5分前に読み上げ（前回・予想・結果）。重要度5は最優先</span>
        </li>
        <li>
          <strong>時間切れ</strong>
          <span>最大おおよそ12本で決済</span>
        </li>
        <li>
          <strong>見送り</strong>
          <span>時間外・ニュース帯・スプレッド拡大・UT未フリップ・SSL不一致・1m/5m衝突</span>
        </li>
      </ol>
    </section>
  )
}
