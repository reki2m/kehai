/** Browser TTS + entry beep for KEHAI Apex. */

import type { CalendarEvent } from './newsFeed'

let unlocked = false
let rateVoiceOn = true
let entrySoundOn = true
let newsVoiceOn = true

export function isVoiceUnlocked() {
  return unlocked
}

export function getVoicePrefs() {
  return { rateVoiceOn, entrySoundOn, newsVoiceOn, unlocked }
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

/** Must be called from a user gesture (click). */
export function unlockAudio(): void {
  unlocked = true
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
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
  try {
    const u = new SpeechSynthesisUtterance('音声オン')
    u.lang = 'ja-JP'
    u.rate = 1.05
    u.volume = 0.01
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(u)
  } catch {
    /* ignore */
  }
}

export function speak(text: string, opts?: { force?: boolean }): void {
  if (!unlocked && !opts?.force) return
  if (!('speechSynthesis' in window)) return
  try {
    window.speechSynthesis.cancel()
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'ja-JP'
    u.rate = 1.05
    u.pitch = 1
    window.speechSynthesis.speak(u)
  } catch {
    /* ignore */
  }
}

export function speakRate(pairLabel: string, price: string, action: string): void {
  if (!rateVoiceOn) return
  const act =
    action === 'LONG' ? 'ロング候補' : action === 'SHORT' ? 'ショート候補' : '待機'
  speak(`${pairLabel}、現在値 ${price}。シグナルは${act}。`)
}

export function announceEntry(
  action: 'LONG' | 'SHORT',
  price: string,
  risk?: { sl: number; tp: number; unit: string },
): void {
  if (entrySoundOn) playEntryBeep(action)
  const side = action === 'LONG' ? 'ロング' : 'ショート'
  const sl = risk?.sl ?? 2.5
  const tp = risk?.tp ?? 5
  const unit = risk?.unit ?? 'ピプス'
  speak(`${side}エントリー。価格 ${price}。損切り${sl}${unit}、利確${tp}${unit}。`, {
    force: true,
  })
}

export function playEntryBeep(action: 'LONG' | 'SHORT'): void {
  if (!unlocked || !entrySoundOn) return
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
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
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
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

function figuresLine(e: CalendarEvent): string {
  const parts: string[] = []
  if (e.previous) parts.push(`前回 ${e.previous}`)
  if (e.forecast) parts.push(`予想 ${e.forecast}`)
  if (e.actual) parts.push(`結果 ${e.actual}`)
  return parts.length ? parts.join('、') : '数値未掲載'
}

/** ~5分前アラート: 重要度・前回・予想（結果があれば結果）を読み上げ */
export function announceEventWarning(e: CalendarEvent, minutesLeft: number): void {
  if (!newsVoiceOn) return
  playAlertBeep(e.importance)
  const mins = Math.max(0, Math.round(minutesLeft))
  const kind = e.kind === 'speech' ? '要人発言' : '経済指標'
  speak(
    `${kind}アラート。重要度${e.importance}。${e.country}、${e.title}。あと約${mins}分。${figuresLine(e)}。`,
    { force: true },
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
  speak(
    `指標結果。${e.country}、${e.title}。${figuresLine(e)}。`,
    { force: true },
  )
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
