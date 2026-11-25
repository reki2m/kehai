import { GRAIL, type PaperState } from '../lib/grail'

interface Props {
  paper: PaperState
  onSlip: (v: number) => void
  onClosePnl: (pips: number) => void
}

export function GrailPanel({ paper, onSlip, onClosePnl }: Props) {
  const f = GRAIL.forwardSummary
  const day = paper.days[paper.days.length - 1]
  const todayPnl = day && day.date ? day.pnlPips : 0

  return (
    <section className="grail-panel" aria-label="Grailフォワード">
      <div className="grail-head">
        <h2>{GRAIL.name}</h2>
        <p className="grail-lead">{f.verdict}</p>
      </div>

      <ul className="grail-stats">
        <li>
          <span>フォワード期間</span>
          <strong>{f.horizon}</strong>
        </li>
        <li>
          <span>ネット（スリッ0）</span>
          <strong>+{f.netPips}p</strong>
        </li>
        <li>
          <span>スリッ0.3p</span>
          <strong className="up">+{f.slip03NetPips}p</strong>
        </li>
        <li>
          <span>スリッ0.5p</span>
          <strong className="down">{f.slip05NetPips}p</strong>
        </li>
        <li>
          <span>週次</span>
          <strong>{f.greenWeeks} 黒字</strong>
        </li>
        <li>
          <span>DD(0.3p時)</span>
          <strong>≈{(f.maxDdJpySlip03 / 1000).toFixed(0)}k JPY / 0.1lot</strong>
        </li>
      </ul>

      <div className="grail-paper">
        <h3>デモ紙トレ日誌</h3>
        <p className="grail-lead">
          想定ロット {GRAIL.demoLot} · 日次上限 −{GRAIL.dailyLossCapPips}p · 観測ズレ{' '}
          {paper.lastSlipPips.toFixed(2)}p
        </p>
        <div className="grail-equity">
          <span>
            Equity {paper.equityPips >= 0 ? '+' : ''}
            {paper.equityPips.toFixed(1)}p
          </span>
          <span>MaxDD {paper.maxDdPips.toFixed(1)}p</span>
          <span>
            本日 {todayPnl >= 0 ? '+' : ''}
            {todayPnl.toFixed(1)}p
            {day?.halted ? ' · HALT' : ''}
          </span>
        </div>

        <label className="grail-slip">
          <span>観測約定ズレ (pips)</span>
          <input
            type="number"
            min={0}
            max={2}
            step={0.05}
            value={paper.lastSlipPips}
            onChange={(e) => onSlip(Number(e.target.value) || 0)}
          />
        </label>

        <div className="grail-close-btns" role="group" aria-label="決済記録">
          <button type="button" onClick={() => onClosePnl(6.6)}>
            TP記録
          </button>
          <button type="button" onClick={() => onClosePnl(-3)}>
            SL記録
          </button>
          <button type="button" onClick={() => onClosePnl(0)}>
            ±0
          </button>
        </div>

        {paper.entries.length > 0 && (
          <ul className="grail-entries">
            {paper.entries
              .slice(-5)
              .reverse()
              .map((e, i) => (
                <li key={`${e.ts}-${i}`}>
                  {e.action} {e.price} · SL{e.sl}/TP{e.tp} · {e.session}
                </li>
              ))}
          </ul>
        )}
      </div>
    </section>
  )
}
