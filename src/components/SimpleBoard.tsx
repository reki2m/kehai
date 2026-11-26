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
            品質 {signal.grade}
            <span className="simple-grade-score"> · {signal.quality}</span>
          </p>
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

        <div className="rate-board" aria-label="売り値と買い値">
          <div className="rate-side rate-bid">
            <span className="rate-label">売り値</span>
            <span className="rate-num">{bid}</span>
          </div>
          <div className="rate-side rate-ask">
            <span className="rate-label">買い値</span>
            <span className="rate-num">{ask}</span>
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
          SL {SIMPLE.slPips} / TP {SIMPLE.tpPips} {unitLabel(pair)}
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
          READY↑/↓ は準備警告（あと{SIMPLE.readyPips}p以内）· まだ入らない
        </li>
        <li>
          BUY / SELL は品質 A〜S 優先 · C は見送り推奨
        </li>
        <li>
          損切り {SIMPLE.slPips}
          {unitLabel(pair)} · 利確 {SIMPLE.tpPips}
          {unitLabel(pair)} を固定
        </li>
        <li>約定の最終確認はGMOの板で行う</li>
        <li>チャートは UT / SSL / VWAP がサイン用オーバーレイ</li>
      </ol>
    </aside>
  )
}
