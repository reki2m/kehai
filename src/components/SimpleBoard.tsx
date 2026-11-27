import { SIMPLE, type SimpleSignal } from '../lib/simpleSignal'
import type { PairMeta } from '../lib/pairs'
import { unitLabel } from '../lib/pairs'

interface Props {
  signal: SimpleSignal
  pair: PairMeta
  inPosition: boolean
  /** Live open ±pips when in a marked trade. */
  openPips?: number | null
}

export function SimpleBoard({
  signal,
  pair,
  inPosition,
  openPips = null,
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
        {inPosition && openPips != null && (
          <p
            className={`simple-open-pips ${openPips >= 0 ? 'up' : 'down'}`}
          >
            建玉 {openPips >= 0 ? '+' : ''}
            {openPips.toFixed(1)}p
          </p>
        )}
        {showGrade && (
          <p className={`simple-grade grade-${signal.grade.toLowerCase()}`}>
            {signal.prime ? 'Peak' : '標準'} {signal.grade}
            <span className="simple-grade-score"> · {signal.quality}</span>
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
                    <>SL {signal.stopPrice.toFixed(pair.digits)}</>
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
          Peak Drive · 単ペア約{SIMPLE.verified.tradesPerDay}回/日 · 日次約+
          {SIMPLE.verified.dailyPips}p
        </li>
        <li>
          HTF/WTを外して約3倍手数 · DI+RSI+ADX≥{SIMPLE.adxMin}は維持
        </li>
        <li>買い値・売り値はチャート上余白に表示</li>
        <li>
          SL{SIMPLE.slPips} / TP{SIMPLE.tpPips} {unitLabel(pair)} · 表示に合わせる
        </li>
        <li>建玉中は上部に±pips · 切ったらリセット</li>
      </ol>
    </aside>
  )
}
