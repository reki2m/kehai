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
    <section className="book-panel" aria-label="他ペア・スキャン">
      <div className="book-head">
        <h2>他ペア</h2>
        <p className="book-lead">
          参考スキャン · 本命は単ペアDrive（約{SIMPLE.verified.tradesPerDay}
          回/日 · +{SIMPLE.verified.dailyPips}p）
        </p>
      </div>

      <div className="book-verified">
        <span>単ペア日次約+{SIMPLE.verified.dailyPips}p</span>
        <span className="up">約{pace.tradesPerDay}回/日</span>
        <span>{pace.pairs}FX監視</span>
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
                    Peak {s.grade}
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
