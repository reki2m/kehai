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

        <div className="rate-board" aria-label="売値と買値">
          <div className="rate-side rate-bid">
            <span className="rate-label">売</span>
            <span className="rate-num">{bid}</span>
          </div>
          <div className="rate-divider" aria-hidden />
          <div className="rate-side rate-ask">
            <span className="rate-label">買</span>
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
        <li>BUY / SELL が出たら手動エントリー（1本のみ）</li>
        <li>
          損切り {SIMPLE.slPips}
          {unitLabel(pair)} · 利確 {SIMPLE.tpPips}
          {unitLabel(pair)} を固定
        </li>
        <li>約定の最終確認はGMOの板で行う</li>
        <li>音声オンでサイン・1分/5分変動・指標・急変を読み上げ</li>
      </ol>
    </aside>
  )
}
