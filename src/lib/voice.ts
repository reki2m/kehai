/** Browser TTS + entry beep for KEHAI Apex. */

let unlocked = false
let rateVoiceOn = true
let entrySoundOn = true

export function isVoiceUnlocked() {
  return unlocked
}

export function getVoicePrefs() {
  return { rateVoiceOn, entrySoundOn, unlocked }
}

export function setRateVoiceOn(v: boolean) {
  rateVoiceOn = v
}

export function setEntrySoundOn(v: boolean) {
  entrySoundOn = v
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

export function announceEntry(action: 'LONG' | 'SHORT', price: string): void {
  if (entrySoundOn) playEntryBeep(action)
  const side = action === 'LONG' ? 'ロング' : 'ショート'
  speak(`${side}エントリー。価格 ${price}。損切り2.5ピプス、利確5ピプス。`, {
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
