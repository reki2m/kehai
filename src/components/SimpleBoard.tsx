import { SIMPLE, type SimpleSignal } from '../lib/simpleSignal'
import type { PairMeta } from '../lib/pairs'
import { unitLabel } from '../lib/pairs'

interface Props {
  signal: SimpleSignal
  /** 売値 (BID) */
  bid: string
  /** 買値 (ASK) */
  ask: string
  mid: string
  change: number
  changePct: number
  pair: PairMeta
  inPosition: boolean
}

export function SimpleBoard({
  signal,
  bid,
  ask,
  mid,
  change,
  changePct,
  pair,
  inPosition,
}: Props) {
  const tone =
    signal.action === 'BUY' || signal.action === 'READY_BUY'
      ? 'bull'
      : signal.action === 'SELL' || signal.action === 'READY_SELL'
        ? 'bear'
        : 'neutral'

  const actionClass =
    signal.action === 'BUY'
      ? 'action-buy'
      : signal.action === 'SELL'
        ? 'action-sell'
        : signal.action === 'READY_BUY'
          ? 'action-ready-buy'
          : signal.action === 'READY_SELL'
            ? 'action-ready-sell'
            : 'action-wait'

  const showGrade =
    signal.action === 'BUY' ||
    signal.action === 'SELL' ||
    signal.action === 'READY_BUY' ||
    signal.action === 'READY_SELL'

  return (
    <aside className="simple-board" aria-label="売買サイン">
      <div className={`simple-hero tone-${tone}`}>
        <p className="simple-kicker">
          {SIMPLE.name} · {SIMPLE.stack}
        </p>
        <p className={`simple-action ${actionClass}`}>
          {inPosition ? 'IN TRADE' : signal.label}
        </p>
        {showGrade && (
          <p className={`simple-grade grade-${signal.grade.toLowerCase()}`}>
            {signal.track === 'honmei'
              ? '本命'
              : signal.track === 'day'
                ? 'デイ'
                : signal.prime
                  ? '推奨'
                  : '標準'}{' '}
            {signal.grade}
            <span className="simple-grade-score"> · {signal.quality}</span>
            {(signal.action === 'BUY' || signal.action === 'SELL') && (
              <span className="simple-grade-score">
                {' '}
                · サイズ×{signal.sizeHint}
              </span>
            )}
          </p>
        )}
        {signal.entryPrice != null &&
          (signal.action === 'READY_BUY' ||
            signal.action === 'READY_SELL' ||
            signal.action === 'BUY' ||
            signal.action === 'SELL') && (
            <div
              className={`ready-levels ${
                signal.action === 'READY_BUY' || signal.action === 'BUY'
                  ? 'levels-buy'
                  : 'levels-sell'
              }`}
              aria-label="エントリー目安"
            >
              <p className="ready-entry">
                <span className="ready-entry-label">
                  {signal.action === 'READY_BUY'
                    ? '買い目安'
                    : signal.action === 'READY_SELL'
                      ? '売り目安'
                      : signal.action === 'BUY'
                        ? '買い参考'
                        : '売り参考'}
                </span>
                <span className="ready-entry-num">
                  {signal.entryPrice.toFixed(pair.digits)}
                </span>
              </p>
              {(signal.stopPrice != null || signal.takeProfitPrice != null) && (
                <p className="ready-sltp">
                  {signal.stopPrice != null && (
                    <>
                      SL {signal.stopPrice.toFixed(pair.digits)}
                    </>
                  )}
                  {signal.stopPrice != null && signal.takeProfitPrice != null
                    ? ' · '
                    : ''}
                  {signal.takeProfitPrice != null && (
                    <>TP {signal.takeProfitPrice.toFixed(pair.digits)}</>
                  )}
                  {signal.trailDistancePips != null &&
                  (signal.action === 'READY_BUY' ||
                    signal.action === 'READY_SELL')
                    ? ` · あと ${signal.trailDistancePips.toFixed(1)}p`
                    : ''}
                </p>
              )}
            </div>
          )}
        <p className="simple-reason">{signal.reason}</p>

        {signal.layers.length > 0 && (
          <ul className="ind-layers" aria-label="インジケータ状態">
            {signal.layers.map((layer) => (
              <li
                key={layer.id}
                className={`ind-layer bias-${layer.bias} ${layer.ok ? 'ok' : 'off'}`}
              >
                <span className="ind-name">{layer.name}</span>
                <span className="ind-detail">{layer.detail}</span>
              </li>
            ))}
          </ul>
        )}

        <div className="rate-board" aria-label="買い値と売り値">
          <div className="rate-side rate-ask">
            <span className="rate-label">買い値</span>
            <span className="rate-num">{ask}</span>
          </div>
          <div className="rate-side rate-bid">
            <span className="rate-label">売り値</span>
            <span className="rate-num">{bid}</span>
          </div>
        </div>
        <p className="rate-mid">
          仲値 {mid}
          <span className={`quote-chg ${change >= 0 ? 'up' : 'down'}`}>
            {' '}
            {change >= 0 ? '+' : ''}
            {change.toFixed(pair.digits)} ({changePct >= 0 ? '+' : ''}
            {changePct.toFixed(3)}%)
          </span>
        </p>

        <p className="simple-risk">
          SL {signal.slPips} / TP {signal.tpPips} {unitLabel(pair)}
          {signal.sessionLabel ? ` · ${signal.sessionLabel}` : ''}
        </p>
        <p className="simple-meta">
          スプレッド見積 {signal.spreadPips.toFixed(2)}p · SSL{' '}
          {signal.sslSide === 'buy'
            ? '買い側'
            : signal.sslSide === 'sell'
              ? '売り側'
              : '—'}
          {signal.utFlip ? ' · UTフリップ' : ''}
          {signal.trailDistancePips != null
            ? ` · UTまで ${signal.trailDistancePips.toFixed(1)}p`
            : ''}
        </p>
      </div>

      <ol className="simple-howto">
        <li>
          デイトレ机: 本命（フルサイズ・高ADX）とデイ（半サイズ・手数）の二層
        </li>
        <li>
          目安{SIMPLE.dayDesk.tradesPerDay}回/日（本命約
          {SIMPLE.dayDesk.honmeiPerDay} + デイ約{SIMPLE.dayDesk.dayPerDay}）
        </li>
        <li>
          READY↑/↓ は本命の準備警告 · まだ入らない
        </li>
        <li>
          本命 SL{SIMPLE.slMin}–{SIMPLE.slMax}/TP{SIMPLE.tpMin}–
          {SIMPLE.tpMax} · デイ SL{SIMPLE.daySlMin}–{SIMPLE.daySlMax}/TP
          {SIMPLE.dayTpMin}–{SIMPLE.dayTpMax}
          {unitLabel(pair)}
        </li>
        <li>約定の最終確認はGMOの板で行う</li>
      </ol>
    </aside>
  )
}
