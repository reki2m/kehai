/**
 * 急変（ショートウィンドウの急ピプス変動）検知。
 * 1秒ティックを溜め、短時間の値幅が閾値を超えたらアラート。
 */

export interface ShockSample {
  t: number // ms
  price: number
}

export interface ShockHit {
  direction: 'UP' | 'DOWN'
  pips: number
  windowSec: number
  price: number
  thresholdPips: number
}

export interface ShockDetectorOptions {
  /** 監視ウィンドウ秒（デフォルト 8） */
  windowSec?: number
  /** 最低トリガー pips（デフォルト 4） */
  minPips?: number
  /** ATR(pips) に対する倍率。max(minPips, atr*ratio) が閾値 */
  atrRatio?: number
  /** 連続アラート抑制秒（デフォルト 45） */
  cooldownSec?: number
  pip: number
}

export class ShockDetector {
  private samples: ShockSample[] = []
  private lastAlertAt = 0
  private readonly windowSec: number
  private readonly minPips: number
  private readonly atrRatio: number
  private readonly cooldownSec: number
  private readonly pip: number

  constructor(opts: ShockDetectorOptions) {
    this.windowSec = opts.windowSec ?? 8
    this.minPips = opts.minPips ?? 4
    this.atrRatio = opts.atrRatio ?? 0.55
    this.cooldownSec = opts.cooldownSec ?? 45
    this.pip = opts.pip
  }

  reset(): void {
    this.samples = []
    this.lastAlertAt = 0
  }

  /**
   * 新価格を投入。急変なら ShockHit、なければ null。
   * atrPips が分かれば動的閾値、不明なら minPips。
   */
  push(price: number, atrPips?: number | null, now = Date.now()): ShockHit | null {
    if (!Number.isFinite(price) || this.pip <= 0) return null
    this.samples.push({ t: now, price })
    const cut = now - this.windowSec * 1000 - 500
    while (this.samples.length && this.samples[0].t < cut) this.samples.shift()
    if (this.samples.length < 3) return null

    if (now - this.lastAlertAt < this.cooldownSec * 1000) return null

    let lo = this.samples[0].price
    let hi = this.samples[0].price
    let loT = this.samples[0].t
    let hiT = this.samples[0].t
    for (const s of this.samples) {
      if (s.price < lo) {
        lo = s.price
        loT = s.t
      }
      if (s.price > hi) {
        hi = s.price
        hiT = s.t
      }
    }
    const rangePips = (hi - lo) / this.pip
    const atr = atrPips != null && Number.isFinite(atrPips) ? atrPips : null
    const threshold = Math.max(this.minPips, atr != null ? atr * this.atrRatio : this.minPips)
    if (rangePips < threshold) return null

    // 直近が安値側か高値側かで方向（後に出た極端値が方向）
    const direction: 'UP' | 'DOWN' = hiT >= loT ? 'UP' : 'DOWN'
    this.lastAlertAt = now
    return {
      direction,
      pips: Math.round(rangePips * 10) / 10,
      windowSec: this.windowSec,
      price,
      thresholdPips: Math.round(threshold * 10) / 10,
    }
  }
}
