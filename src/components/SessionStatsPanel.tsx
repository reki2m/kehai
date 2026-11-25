import type { FxSession } from '../lib/apex'
import {
  summarizeBySession,
  totals,
  type SessionStatsState,
} from '../lib/sessionStats'

interface Props {
  stats: SessionStatsState
  rangeDays: 14 | 0
  onRange: (d: 14 | 0) => void
  onToggleSession: (s: FxSession) => void
  onClear: () => void
  slipInput: string
  onSlipInput: (v: string) => void
  onClose: (kind: 'TP' | 'SL' | 'OTHER') => void
  otherPnl: string
  onOtherPnl: (v: string) => void
}

export function SessionStatsPanel({
  stats,
  rangeDays,
  onRange,
  onToggleSession,
  onClear,
  slipInput,
  onSlipInput,
  onClose,
  otherPnl,
  onOtherPnl,
}: Props) {
  const since = rangeDays ? Date.now() - rangeDays * 86400_000 : undefined
  const rows = summarizeBySession(stats, since)
  const all = totals(rows)
  const weak = rows.filter((r) => r.weak && !r.disabled)

  return (
    <section className="session-stats" aria-label="セッション別成績">
      <div className="session-stats-head">
        <h2>Session Score</h2>
        <p className="session-stats-lead">
          帯ごとの pips / 勝率 / 平均ズレ · 弱い帯は切る
        </p>
      </div>

      <div className="session-range" role="group" aria-label="期間">
        <button
          type="button"
          className={rangeDays === 14 ? 'active' : ''}
          onClick={() => onRange(14)}
        >
          直近2週
        </button>
        <button
          type="button"
          className={rangeDays === 0 ? 'active' : ''}
          onClick={() => onRange(0)}
        >
          全期間
        </button>
      </div>

      <div className="session-total">
        <span>
          合計 {all.netPips >= 0 ? '+' : ''}
          {all.netPips.toFixed(1)}p
        </span>
        <span>勝率 {all.winRate.toFixed(0)}%</span>
        <span>平均ズレ {all.avgSlip.toFixed(2)}p</span>
        <span>{all.trades}本</span>
      </div>

      <ul className="session-rows">
        {rows.map((r) => (
          <li
            key={r.session}
            className={`session-row ${r.disabled ? 'off' : ''} ${r.weak ? 'weak' : ''}`}
          >
            <div className="session-row-top">
              <strong>{r.label}</strong>
              <button
                type="button"
                className="session-toggle"
                onClick={() => onToggleSession(r.session)}
              >
                {r.disabled ? '再開' : '停止'}
              </button>
            </div>
            <div className="session-metrics">
              <span className={r.netPips >= 0 ? 'up' : 'down'}>
                {r.netPips >= 0 ? '+' : ''}
                {r.netPips.toFixed(1)}p
              </span>
              <span>勝率 {r.trades ? r.winRate.toFixed(0) : '—'}%</span>
              <span>ズレ {r.trades ? r.avgSlip.toFixed(2) : '—'}p</span>
              <span>{r.trades}本</span>
            </div>
            {r.weak && !r.disabled && (
              <p className="session-hint">弱い帯の候補（停止を検討）</p>
            )}
            {r.disabled && <p className="session-hint">サイン対象外</p>}
          </li>
        ))}
      </ul>

      {weak.length > 0 && (
        <p className="session-advice">
          推奨: {weak.map((w) => w.label).join('・')} を一時停止して全体の負けを削る
        </p>
      )}

      {stats.open && (
        <div className="session-close-box">
          <p className="session-close-title">
            建玉中 {stats.open.side} · 想定 {stats.open.expectedEntry}
          </p>
          <label className="session-field">
            <span>今回の約定ズレ (pips)</span>
            <input
              type="number"
              min={0}
              max={5}
              step={0.05}
              value={slipInput}
              onChange={(e) => onSlipInput(e.target.value)}
              placeholder="0.2"
            />
          </label>
          <div className="session-close-btns">
            <button type="button" onClick={() => onClose('TP')}>
              TP +10
            </button>
            <button type="button" onClick={() => onClose('SL')}>
              SL −7
            </button>
          </div>
          <label className="session-field">
            <span>その他決済 (pips)</span>
            <input
              type="number"
              step={0.1}
              value={otherPnl}
              onChange={(e) => onOtherPnl(e.target.value)}
              placeholder="例 +3.5 / -2"
            />
          </label>
          <button
            type="button"
            className="session-other-btn"
            onClick={() => onClose('OTHER')}
          >
            その他で記録
          </button>
        </div>
      )}

      <button type="button" className="session-clear" onClick={onClear}>
        成績をリセット
      </button>
    </section>
  )
}
