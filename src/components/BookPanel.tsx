import type { BookScanResult, BookSignal } from '../lib/peakBook'
import { expectedBookPace } from '../lib/peakBook'
import { getPair, type PairId } from '../lib/pairs'
import { SIMPLE } from '../lib/simpleSignal'

interface Props {
  book: BookScanResult | null
  loading?: boolean
  activePair: PairId
  onSelectPair: (id: PairId) => void
}

function fmtPrice(s: BookSignal): string {
  if (s.entryPrice == null) return '—'
  return s.entryPrice.toFixed(getPair(s.pairId).digits)
}

export function BookPanel({
  book,
  loading,
  activePair,
  onSelectPair,
}: Props) {
  const pace = expectedBookPace()
  const signals = book?.signals ?? []

  return (
    <section className="book-panel" aria-label="Peak Edge ブック">
      <div className="book-head">
        <h2>Peak Edge Book</h2>
        <p className="book-lead">
          同ロジック × {pace.pairs}FX · 目安{pace.tradesPerDay}回/日 · EV +
          {pace.evPips}p · 日次約+{pace.dailyEdge}p
        </p>
      </div>

      <div className="book-verified">
        <span>単ペア検証 {SIMPLE.verified.period}</span>
        <span>
          {SIMPLE.verified.tradesPerDay}回/日 · EV +
          {SIMPLE.verified.evPips}p · {SIMPLE.verified.netPips >= 0 ? '+' : ''}
          {SIMPLE.verified.netPips}p
        </span>
        <span className="up">
          ブック想定 {pace.tradesPerDay}回/日 · 日次+{pace.dailyEdge}p
        </span>
      </div>

      {loading && <p className="book-empty">全FXスキャン中…</p>}
      {!loading && signals.length === 0 && (
        <p className="book-empty">いまブックに BUY/SELL なし</p>
      )}

      {signals.length > 0 && (
        <ul className="book-rows">
          {signals.map((s) => (
            <li
              key={`${s.pairId}-${s.side}-${s.at}`}
              className={`book-row ${s.pairId === activePair ? 'active' : ''}`}
            >
              <button
                type="button"
                className="book-row-btn"
                onClick={() => onSelectPair(s.pairId)}
              >
                <div className="book-row-top">
                  <strong>{s.label}</strong>
                  <span className={s.side === 'BUY' ? 'up' : 'down'}>
                    {s.side}
                  </span>
                  <span className="book-grade">
                    {s.prime ? '推奨' : '標準'} {s.grade}
                  </span>
                </div>
                <div className="book-row-meta">
                  <span>目安 {fmtPrice(s)}</span>
                  <span>
                    SL{s.slPips}/TP{s.tpPips}
                  </span>
                </div>
                <p className="book-reason">{s.reason}</p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
