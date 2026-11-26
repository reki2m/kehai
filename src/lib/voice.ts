/** Browser TTS + entry beep for KEHAI — 日本語ボイス優先・優先度キュー対応. */

import type { CalendarEvent } from './newsFeed'

let unlocked = false
let rateVoiceOn = true
let entrySoundOn = true
let newsVoiceOn = true
let shockAlertOn = true
let cachedJaVoice: SpeechSynthesisVoice | null | undefined

type Priority = 0 | 1 | 2 | 3 // 0=critical(entry) 1=alert 2=news 3=rate

interface QueueItem {
  text: string
  priority: Priority
  force: boolean
}

const queue: QueueItem[] = []
let speaking = false
let voicesReady = false

export function isVoiceUnlocked() {
  return unlocked
}

export function getVoicePrefs() {
  return { rateVoiceOn, entrySoundOn, newsVoiceOn, shockAlertOn, unlocked }
}

export function setRateVoiceOn(v: boolean) {
  rateVoiceOn = v
}

export function setEntrySoundOn(v: boolean) {
  entrySoundOn = v
}

export function setNewsVoiceOn(v: boolean) {
  newsVoiceOn = v
}

export function setShockAlertOn(v: boolean) {
  shockAlertOn = v
}

export function isShockAlertOn() {
  return shockAlertOn
}

function refreshVoices(): void {
  if (!('speechSynthesis' in window)) return
  const voices = window.speechSynthesis.getVoices()
  if (!voices.length) return
  voicesReady = true
  const preferred = [
    /google.*(日本語|japanese)/i,
    /microsoft.*(nanami|haruka|ayumi|ichiro)/i,
    /kyoko/i,
    /otoya/i,
    /haruka/i,
    /japanese/i,
  ]
  for (const re of preferred) {
    const hit = voices.find((v) => re.test(v.name) || re.test(v.lang))
    if (hit) {
      cachedJaVoice = hit
      return
    }
  }
  cachedJaVoice =
    voices.find((v) => v.lang.toLowerCase().startsWith('ja')) ?? null
}

function ensureVoices(): SpeechSynthesisVoice | null {
  if (cachedJaVoice !== undefined && voicesReady) return cachedJaVoice
  refreshVoices()
  return cachedJaVoice ?? null
}

/** TTS向けに国名・記号・数字を読みやすく整形 */
export function forSpeech(raw: string): string {
  let s = raw
  const country: Record<string, string> = {
    USD: 'アメリカ',
    JPY: '日本',
    EUR: 'ユーロ圏',
    GBP: 'イギリス',
    AUD: 'オーストラリア',
    CAD: 'カナダ',
    CHF: 'スイス',
    NZD: 'ニュージーランド',
    CNY: '中国',
  }
  // 通貨ペアを先に（国名置換で壊さない）
  s = s.replace(/\bUSD\/JPY\b/gi, 'ドル円')
  s = s.replace(/\bEUR\/USD\b/gi, 'ユーロドル')
  s = s.replace(/\bGBP\/JPY\b/gi, 'ポンド円')
  s = s.replace(/\bEUR\/JPY\b/gi, 'ユーロ円')
  s = s.replace(/\bAUD\/USD\b/gi, 'オージードル')
  s = s.replace(/\bUSD\/CHF\b/gi, 'ドルスイス')
  s = s.replace(/\b(USD|JPY|EUR|GBP|AUD|CAD|CHF|NZD|CNY)\b/g, (m) => country[m] ?? m)
  s = s.replace(/%/g, 'パーセント')
  s = s.replace(/\bpips?\b/gi, 'ピプス')
  s = s.replace(/\bFOMC\b/g, 'エフオーエムシー')
  s = s.replace(/\bECB\b/g, 'イーシービー')
  s = s.replace(/\bBOJ\b/gi, '日銀')
  s = s.replace(/\bNFP\b/g, '雇用統計')
  s = s.replace(/\bCPI\b/g, 'シーピーアイ')
  s = s.replace(/\bPCE\b/g, 'ピーシーイー')
  s = s.replace(/\bGDP\b/g, 'ジーディーピー')
  s = s.replace(/\bPMI\b/g, 'ピーエムアイ')
  s = s.replace(/\bISM\b/g, 'アイエスエム')
  s = s.replace(/\bPPI\b/g, 'ピーピーアイ')
  s = s.replace(/\bMPC\b/g, 'エムピーシー')
  s = s.replace(/\bFRB\b/g, 'エフアールビー')
  // 小数点を「てん」に（価格・指標の読み上げ用）
  s = s.replace(/(\d)\.(\d+)/g, '$1てん$2')
  return s.replace(/\s{2,}/g, ' ').trim()
}

function figuresLine(e: CalendarEvent): string {
  const parts: string[] = []
  if (e.previous) parts.push(`前回 ${e.previous}`)
  if (e.forecast) parts.push(`予想 ${e.forecast}`)
  if (e.actual) parts.push(`結果 ${e.actual}`)
  return parts.length ? parts.join('、') : '数値未掲載'
}

function parseFigure(v?: string): number | null {
  if (!v) return null
  const n = Number.parseFloat(v.replace(/[%KMB,]/gi, '').trim())
  return Number.isFinite(n) ? n : null
}

/** 結果と予想の比較コメント */
function resultVerdict(e: CalendarEvent): string {
  const a = parseFigure(e.actual)
  const f = parseFigure(e.forecast)
  if (a == null || f == null) return ''
  if (Math.abs(a - f) < 1e-9) return '予想どおり。'
  // 失業率などは低い方が良いが、汎用で上振れ/下振れのみ伝える
  return a > f ? '予想を上回りました。' : '予想を下回りました。'
}

function drainQueue(): void {
  if (speaking) return
  if (!('speechSynthesis' in window)) return
  if (queue.length === 0) return

  // 優先度の高いものから
  queue.sort((a, b) => a.priority - b.priority)
  const next = queue.shift()!
  if (!unlocked && !next.force) {
    drainQueue()
    return
  }

  speaking = true
  try {
    const u = new SpeechSynthesisUtterance(forSpeech(next.text))
    u.lang = 'ja-JP'
    u.rate = next.priority <= 1 ? 1.0 : 1.08
    u.pitch = 1
    u.volume = 1
    const voice = ensureVoices()
    if (voice) u.voice = voice
    u.onend = () => {
      speaking = false
      // 短い間を空けて次へ
      window.setTimeout(drainQueue, 180)
    }
    u.onerror = () => {
      speaking = false
      window.setTimeout(drainQueue, 80)
    }
    window.speechSynthesis.speak(u)
  } catch {
    speaking = false
  }
}

/**
 * 読み上げ。priority が低いほど優先。
 * critical は進行中を中断して即読み。rate(3) はキューが空のときだけ。
 */
export function speak(
  text: string,
  opts?: { force?: boolean; priority?: Priority; interrupt?: boolean },
): void {
  if (!unlocked && !opts?.force) return
  if (!('speechSynthesis' in window)) return
  const priority = opts?.priority ?? 2
  const force = !!opts?.force
  const interrupt = opts?.interrupt ?? priority === 0

  // レート読み上げは、他が待ち／発話中ならスキップ（邪魔しない）
  if (priority >= 3 && (speaking || queue.length > 0)) return

  if (interrupt) {
    try {
      window.speechSynthesis.cancel()
    } catch {
      /* ignore */
    }
    speaking = false
    // critical 以外の待ちは残す / critical 時は低優先を落とす
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].priority >= 2) queue.splice(i, 1)
    }
  }

  queue.push({ text, priority, force })
  drainQueue()
}

/** Must be called from a user gesture (click). */
export function unlockAudio(): void {
  unlocked = true
  refreshVoices()
  if ('speechSynthesis' in window) {
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoices)
    // iOS: getVoices が空のことがあるので一度ダミー発話で起こす
    try {
      window.speechSynthesis.getVoices()
    } catch {
      /* ignore */
    }
  }
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    const ctx = new Ctx()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    gain.gain.value = 0.0001
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.01)
    void ctx.resume()
  } catch {
    /* ignore */
  }
  speak('音声オン。指標とサインを読み上げます。', {
    force: true,
    priority: 0,
    interrupt: true,
  })
}

export function speakRate(
  pairLabel: string,
  price: string,
  action: string,
  quote?: { bid: string; ask: string },
): void {
  if (!rateVoiceOn) return
  const act =
    action === 'LONG'
      ? 'ロング候補'
      : action === 'SHORT'
        ? 'ショート候補'
        : action === 'READY_BUY'
          ? '買い準備'
          : action === 'READY_SELL'
            ? '売り準備'
            : '待機'
  const rates = quote
    ? `売値 ${quote.bid}、買値 ${quote.ask}`
    : `現在値 ${price}`
  speak(`${pairLabel}、${rates}。シグナルは${act}。`, { priority: 3 })
}

export function announceEntry(
  action: 'LONG' | 'SHORT',
  price: string,
  risk?: { sl: number; tp: number; unit: string; session?: string },
): void {
  if (entrySoundOn) playEntryBeep(action)
  const side = action === 'LONG' ? 'ロング' : 'ショート'
  const sl = risk?.sl ?? 3
  const tp = risk?.tp ?? 6
  const unit = risk?.unit ?? 'ピプス'
  const sess = risk?.session ? `${risk.session}。` : ''
  speak(
    `${sess}${side}エントリー。価格 ${price}。損切り${sl}${unit}、利確${tp}${unit}。`,
    { force: true, priority: 0, interrupt: true },
  )
}

/** Softer pre-warn: confirms aligned, UT trail approaching — do not enter yet. */
export function announceReady(
  side: 'BUY' | 'SELL',
  trailPips: number | null,
): void {
  if (entrySoundOn) playReadyBeep(side)
  const dir = side === 'BUY' ? '買い' : '売り'
  const dist =
    trailPips != null && Number.isFinite(trailPips)
      ? `トレールまであと${trailPips.toFixed(1)}ピプス。`
      : ''
  speak(`準備警告。${dir}寄り。${dist}まだ入らないで。フリップ待ち。`, {
    force: true,
    priority: 0,
    interrupt: true,
  })
}

export function playReadyBeep(side: 'BUY' | 'SELL'): void {
  if (!unlocked || !entrySoundOn) return
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    const ctx = new Ctx()
    void ctx.resume()
    const now = ctx.currentTime
    const f = side === 'BUY' ? 740 : 520
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.value = f
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.1, now + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.22)
  } catch {
    /* ignore */
  }
}

export function playEntryBeep(action: 'LONG' | 'SHORT'): void {
  if (!unlocked || !entrySoundOn) return
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    const ctx = new Ctx()
    void ctx.resume()
    const now = ctx.currentTime
    const freqs = action === 'LONG' ? [880, 1174] : [660, 440]
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = f
      gain.gain.setValueAtTime(0.0001, now)
      gain.gain.exponentialRampToValueAtTime(0.18, now + 0.02 + i * 0.08)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28 + i * 0.1)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + i * 0.08)
      osc.stop(now + 0.35 + i * 0.1)
    })
  } catch {
    /* ignore */
  }
}

function playAlertBeep(importance: number): void {
  if (!unlocked) return
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    const ctx = new Ctx()
    void ctx.resume()
    const now = ctx.currentTime
    const base = importance >= 5 ? 988 : importance >= 4 ? 784 : 660
    ;[0, 0.18, 0.36].forEach((delay, i) => {
      if (importance < 4 && i > 1) return
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'triangle'
      osc.frequency.value = base
      gain.gain.setValueAtTime(0.0001, now + delay)
      gain.gain.exponentialRampToValueAtTime(0.16, now + delay + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.14)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + delay)
      osc.stop(now + delay + 0.16)
    })
  } catch {
    /* ignore */
  }
}

/** 急変専用：短く強いサイレン風ビープ（上下で音色を変える） */
export function playShockBeep(direction: 'UP' | 'DOWN'): void {
  if (!unlocked || !shockAlertOn) return
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    const ctx = new Ctx()
    void ctx.resume()
    const now = ctx.currentTime
    const freqs =
      direction === 'UP'
        ? [880, 1175, 1480, 1175]
        : [740, 554, 415, 554]
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = i % 2 === 0 ? 'square' : 'sawtooth'
      osc.frequency.value = f
      const t0 = now + i * 0.09
      gain.gain.setValueAtTime(0.0001, t0)
      gain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(t0)
      osc.stop(t0 + 0.12)
    })
  } catch {
    /* ignore */
  }
}

/** 急変アラート（警告音＋読み上げ） */
export function announceShock(hit: {
  direction: 'UP' | 'DOWN'
  pips: number
  windowSec: number
  pairLabel?: string
}): void {
  if (!shockAlertOn) return
  playShockBeep(hit.direction)
  if (!unlocked) return
  const dir = hit.direction === 'UP' ? '急騰' : '急落'
  const pair = hit.pairLabel ? `${hit.pairLabel}、` : ''
  speak(
    `急変警告。${pair}${dir}、約${hit.pips.toFixed(1)}ピプス、${hit.windowSec}秒。`,
    { force: true, priority: 0, interrupt: true },
  )
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      new Notification(`KEHAI · 急変 ${dir}`, {
        body: `${hit.pairLabel ?? ''} ${hit.pips.toFixed(1)}p / ${hit.windowSec}秒`,
        tag: 'shock',
      })
    } catch {
      /* ignore */
    }
  }
}

/** ~5分前（または lead）アラート */
export function announceEventWarning(
  e: CalendarEvent,
  minutesLeft: number,
  opts?: { urgent?: boolean },
): void {
  if (!newsVoiceOn) return
  playAlertBeep(e.importance)
  const mins = Math.max(0, Math.round(minutesLeft))
  const kind = e.kind === 'speech' ? '要人発言' : '経済指標'
  const urgency =
    opts?.urgent || mins <= 1
      ? 'まもなく発表。'
      : mins <= 5
        ? `あと約${mins}分。`
        : `約${mins}分後。`
  speak(
    `${kind}アラート。重要度${e.importance}。${e.country}、${e.title}。${urgency}${figuresLine(e)}。`,
    { force: true, priority: 1 },
  )
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      new Notification(`KEHAI · 重要度${e.importance}`, {
        body: `${e.country} ${e.title} · あと約${mins}分\n${figuresLine(e)}`,
        tag: e.id,
      })
    } catch {
      /* ignore */
    }
  }
}

/** 結果反映時の読み上げ（actual が入ったとき） */
export function announceEventResult(e: CalendarEvent): void {
  if (!newsVoiceOn) return
  const verdict = resultVerdict(e)
  speak(
    `指標結果。${e.country}、${e.title}。${figuresLine(e)}。${verdict}`,
    { force: true, priority: 1 },
  )
}

/** 最新ヘッドライン（長文は短く） */
export function announceHeadline(title: string): void {
  if (!newsVoiceOn) return
  const short = title.length > 72 ? `${title.slice(0, 70)}、以下略` : title
  speak(`為替ニュース。${short}。`, { force: true, priority: 2 })
}

/** 要人発言の予告（当日〜直近） */
export function announceSpeech(e: CalendarEvent, minutesLeft: number): void {
  if (!newsVoiceOn) return
  playAlertBeep(e.importance)
  const mins = Math.max(0, Math.round(minutesLeft))
  const when =
    mins <= 1
      ? 'まもなく'
      : mins <= 5
        ? `あと約${mins}分`
        : mins <= 60
          ? `約${mins}分後`
          : `約${Math.round(mins / 60)}時間後`
  speak(
    `要人発言。重要度${e.importance}。${e.country}、${e.title}。${when}。`,
    { force: true, priority: 1 },
  )
}

/** 直近の高重要度指標をまとめて読み上げ */
export function announceUpcomingBrief(events: CalendarEvent[]): void {
  if (!newsVoiceOn || events.length === 0) return
  const lines = events.slice(0, 4).map((e) => {
    const mins = Math.max(0, Math.round((e.time - Date.now() / 1000) / 60))
    const kind = e.kind === 'speech' ? '発言' : '指標'
    const when =
      mins <= 0 ? 'まもなく' : mins < 60 ? `あと${mins}分` : `あと${Math.round(mins / 60)}時間`
    return `${kind}、${e.country}、${e.title}、重要度${e.importance}、${when}`
  })
  speak(`本日の注目。${lines.join('。')}。`, { force: true, priority: 2 })
}

/** 手動で指標まとめを再読み上げ */
export function announceBriefNow(events: CalendarEvent[]): void {
  if (!events.length) {
    speak('直近の高重要度指標はありません。', { force: true, priority: 2 })
    return
  }
  announceUpcomingBrief(events)
}

export async function requestNotifyPermission(): Promise<void> {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission()
    } catch {
      /* ignore */
    }
  }
}
