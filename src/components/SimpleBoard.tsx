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
    signal.action === 'BUY' ? 'bull' : signal.action === 'SELL' ? 'bear' : 'neutral'

  return (
    <aside className="simple-board" aria-label="売買サイン">
      <div className={`simple-hero tone-${tone}`}>
        <p className="simple-kicker">
          {SIMPLE.name} · {SIMPLE.stack}
        </p>
        <p className={`simple-action action-${signal.action.toLowerCase()}`}>
          {inPosition ? 'IN TRADE' : signal.action}
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
          {signal.sslSide === 'buy' ? '買い側' : signal.sslSide === 'sell' ? '売り側' : '—'}
          {signal.utFlip ? ' · UTフリップ' : ''}
        </p>
      </div>

      <ol className="simple-howto">
        <li>BUY / SELL が出たときだけ見る</li>
        <li>ポジションは同時に1本だけ</li>
        <li>
          損切り {SIMPLE.slPips}{unitLabel(pair)} · 利確 {SIMPLE.tpPips}
          {unitLabel(pair)} を固定
        </li>
        <li>自動化しない · サインは補助</li>
      </ol>
    </aside>
  )
}
