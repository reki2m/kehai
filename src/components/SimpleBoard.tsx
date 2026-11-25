import { SIMPLE, type SimpleSignal } from '../lib/simpleSignal'
import type { PairMeta } from '../lib/pairs'
import { unitLabel } from '../lib/pairs'

interface Props {
  signal: SimpleSignal
  bid: string
  change: number
  changePct: number
  pair: PairMeta
  inPosition: boolean
}

export function SimpleBoard({
  signal,
  bid,
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

  return (
    <aside className="simple-board" aria-label="売買サイン">
      <div className={`simple-hero tone-${tone}`}>
        <p className="simple-kicker">
          {SIMPLE.name} · {SIMPLE.stack}
        </p>
        <p className={`simple-action ${actionClass}`}>
          {inPosition ? 'IN TRADE' : signal.label}
        </p>
        <p className="simple-reason">{signal.reason}</p>
        <div className="simple-quote">
          <span className="quote-bid">{bid}</span>
          <span className={`quote-chg ${change >= 0 ? 'up' : 'down'}`}>
            {change >= 0 ? '+' : ''}
            {change.toFixed(pair.digits)} ({changePct >= 0 ? '+' : ''}
            {changePct.toFixed(3)}%)
          </span>
        </div>
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
        <li>BUY / SELL が出たときだけエントリー</li>
        <li>ポジションは同時に1本だけ</li>
        <li>
          損切り {SIMPLE.slPips}
          {unitLabel(pair)} · 利確 {SIMPLE.tpPips}
          {unitLabel(pair)} を固定
        </li>
      </ol>
    </aside>
  )
}
