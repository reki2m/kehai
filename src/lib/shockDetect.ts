/**
 * 急変検知：1秒ティックを溜め、指定ウィンドウの値幅が閾値超えでアラート。
 * 既定ルール: 1分で20p / 10分で50p
 */

export interface ShockSample {
  t: number // ms
  price: number
}

export interface ShockRule {
  /** 監視ウィンドウ秒 */
  windowSec: number
  /** トリガー pips */
  thresholdPips: number
  /** 表示用ラベル（例: 1分） */
  label: string
  /** ルール単位のクールダウン秒 */
  cooldownSec?: number
}

export interface ShockHit {
  direction: 'UP' | 'DOWN'
  pips: number
  windowSec: number
  label: string
  price: number
  thresholdPips: number
}

export interface ShockDetectorOptions {
  pip: number
  rules?: ShockRule[]
}

const DEFAULT_RULES: ShockRule[] = [
  { windowSec: 60, thresholdPips: 20, label: '1分', cooldownSec: 60 },
  { windowSec: 600, thresholdPips: 50, label: '10分', cooldownSec: 180 },
]

export class ShockDetector {
  private samples: ShockSample[] = []
  private lastAlertAt = new Map<string, number>()
  private readonly rules: ShockRule[]
  private readonly pip: number
  private readonly keepMs: number

  constructor(opts: ShockDetectorOptions) {
    this.pip = opts.pip
    this.rules = opts.rules?.length ? opts.rules : DEFAULT_RULES
    this.keepMs = Math.max(...this.rules.map((r) => r.windowSec)) * 1000 + 2000
  }

  reset(): void {
    this.samples = []
    this.lastAlertAt.clear()
  }

  /** 新価格を投入。いずれかのルールにヒットしたら返す（より短い窓を優先）。 */
  push(price: number, _atrPips?: number | null, now = Date.now()): ShockHit | null {
    if (!Number.isFinite(price) || this.pip <= 0) return null
    this.samples.push({ t: now, price })
    const cut = now - this.keepMs
    while (this.samples.length && this.samples[0].t < cut) this.samples.shift()
    if (this.samples.length < 2) return null

    // 短い窓から評価（1分を10分より優先）
    const ordered = [...this.rules].sort((a, b) => a.windowSec - b.windowSec)
    for (const rule of ordered) {
      const key = `${rule.windowSec}:${rule.thresholdPips}`
      const cool = (rule.cooldownSec ?? 60) * 1000
      if (now - (this.lastAlertAt.get(key) ?? 0) < cool) continue

      const from = now - rule.windowSec * 1000
      const window = this.samples.filter((s) => s.t >= from)
      if (window.length < 2) continue

      let lo = window[0].price
      let hi = window[0].price
      let loT = window[0].t
      let hiT = window[0].t
      for (const s of window) {
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
      if (rangePips < rule.thresholdPips) continue

      const direction: 'UP' | 'DOWN' = hiT >= loT ? 'UP' : 'DOWN'
      this.lastAlertAt.set(key, now)
      return {
        direction,
        pips: Math.round(rangePips * 10) / 10,
        windowSec: rule.windowSec,
        label: rule.label,
        price,
        thresholdPips: rule.thresholdPips,
      }
    }
    return null
  }
}
