/**
 * KEHAI Grail v1 — locked after ~4-week Yahoo WF + slip stress + Dukascopy.
 * Survives ≤0.3p adverse entry/exit slip; fails at 0.5p (do not treat as slip-proof).
 */

import type { ApexSignal } from './apex'

export const GRAIL = {
  name: 'KEHAI Grail v1',
  version: 1,
  assumeSlipPips: 0.3,
  maxSlipPips: 0.45,
  tpMult: 1.1,
  dailyLossCapPips: 8,
  demoLot: 0.01,
  forwardSummary: {
    horizon: 'Yahoo M1 2026-10-28→11-25（約4週間・週次WF）',
    netPips: 68.5,
    slip03NetPips: 27.8,
    slip05NetPips: -31.7,
    maxDdJpySlip03: 35000,
    greenWeeks: '4/5',
    dukaSlip03NetPips: 29.0,
    mcDdP95Jpy: 70700,
    verdict:
      'デモ／マイクロ向け完成形。約定ズレ平均0.3p以下なら継続可。0.5p超は停止。',
  },
} as const

const STORAGE_KEY = 'kehai-grail-paper-v1'

export interface PaperDay {
  date: string
  pnlPips: number
  trades: number
  halted: boolean
}

export interface PaperState {
  days: PaperDay[]
  equityPips: number
  peakPips: number
  maxDdPips: number
  lastSlipPips: number
  entries: Array<{
    ts: number
    session: string
    action: 'LONG' | 'SHORT'
    price: string
    sl: number
    tp: number
  }>
}

function jstDate(d = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

export function loadPaper(): PaperState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as PaperState
  } catch {
    /* ignore */
  }
  return {
    days: [],
    equityPips: 0,
    peakPips: 0,
    maxDdPips: 0,
    lastSlipPips: GRAIL.assumeSlipPips,
    entries: [],
  }
}

export function savePaper(state: PaperState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

export function todayPaper(state: PaperState): PaperDay {
  const date = jstDate()
  let day = state.days.find((d) => d.date === date)
  if (!day) {
    day = { date, pnlPips: 0, trades: 0, halted: false }
    state.days = [...state.days, day]
  }
  return day
}

/** Block new entries on daily loss cap or excessive observed slip. */
export function applyGrailPaperGate(
  edge: ApexSignal,
  paper: PaperState,
): ApexSignal {
  const date = jstDate()
  const day = paper.days.find((d) => d.date === date)
  const dayPnl = day?.pnlPips ?? 0
  const halted = !!day?.halted || dayPnl <= -GRAIL.dailyLossCapPips

  if (paper.lastSlipPips > GRAIL.maxSlipPips) {
    if (edge.action === 'WAIT') {
      return {
        ...edge,
        label: edge.label.includes('Grail') ? edge.label : `${edge.label} · Grail監視`,
      }
    }
    return {
      ...edge,
      action: 'WAIT',
      label: `Grail停止 · 約定ズレ ${paper.lastSlipPips.toFixed(2)}p`,
      score: Math.round(edge.score * 0.3),
    }
  }
  if (halted) {
    if (edge.action === 'WAIT') return edge
    return {
      ...edge,
      action: 'WAIT',
      label: `Grail日次上限 · 本日 ${dayPnl.toFixed(1)}p`,
      score: Math.round(edge.score * 0.3),
    }
  }
  if (edge.action === 'LONG' || edge.action === 'SHORT') {
    return { ...edge, label: `${edge.label} · Grail` }
  }
  return edge
}

export function recordPaperEntry(
  paper: PaperState,
  entry: PaperState['entries'][number],
): PaperState {
  const day = todayPaper(paper)
  day.trades += 1
  const next: PaperState = {
    ...paper,
    days: [...paper.days],
    entries: [...paper.entries.slice(-40), entry],
  }
  savePaper(next)
  return next
}

export function recordPaperClose(paper: PaperState, pnlPips: number): PaperState {
  const day = todayPaper(paper)
  day.pnlPips += pnlPips
  const equityPips = paper.equityPips + pnlPips
  const peakPips = Math.max(paper.peakPips, equityPips)
  const maxDdPips = Math.max(paper.maxDdPips, peakPips - equityPips)
  if (day.pnlPips <= -GRAIL.dailyLossCapPips) day.halted = true
  const next: PaperState = {
    ...paper,
    days: [...paper.days],
    equityPips,
    peakPips,
    maxDdPips,
  }
  savePaper(next)
  return next
}

export function setObservedSlip(paper: PaperState, slipPips: number): PaperState {
  const next = { ...paper, lastSlipPips: slipPips }
  savePaper(next)
  return next
}
