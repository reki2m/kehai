import type { FxSession } from './apex'
import { SESSION_PROFILES } from './apex'

const STORAGE_KEY = 'kehai-session-stats-v1'

export type TradeSide = 'BUY' | 'SELL'
export type ExitKind = 'TP' | 'SL' | 'OTHER'

export interface ClosedTrade {
  id: string
  openedAt: number
  closedAt: number
  session: FxSession
  side: TradeSide
  expectedEntry: number
  actualEntry?: number
  /** Adverse slip in pips (actual worse than expected). */
  slipPips: number
  pnlPips: number
  exit: ExitKind
  pairId: string
}

export interface OpenTrade {
  id: string
  openedAt: number
  session: FxSession
  side: TradeSide
  expectedEntry: number
  pairId: string
  /** ATR-hybrid risk locked at entry (fallback 7/10). */
  slPips?: number
  tpPips?: number
}

export interface SessionStatsState {
  open: OpenTrade | null
  closed: ClosedTrade[]
  /** Sessions manually disabled after weak performance. */
  disabledSessions: FxSession[]
}

export interface SessionRow {
  session: FxSession
  label: string
  trades: number
  wins: number
  losses: number
  winRate: number
  netPips: number
  avgSlip: number
  slipSamples: number
  disabled: boolean
  /** Weak if enough trades and (net<0 or avgSlip>0.3 or WR<45). */
  weak: boolean
}

function empty(): SessionStatsState {
  return { open: null, closed: [], disabledSessions: [] }
}

export function loadSessionStats(): SessionStatsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty()
    const parsed = JSON.parse(raw) as SessionStatsState
    return {
      open: parsed.open ?? null,
      closed: Array.isArray(parsed.closed) ? parsed.closed : [],
      disabledSessions: Array.isArray(parsed.disabledSessions)
        ? parsed.disabledSessions
        : [],
    }
  } catch {
    return empty()
  }
}

export function saveSessionStats(state: SessionStatsState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* ignore */
  }
}

export function openTrade(
  state: SessionStatsState,
  input: {
    session: FxSession
    side: TradeSide
    expectedEntry: number
    pairId: string
    slPips?: number
    tpPips?: number
  },
): SessionStatsState {
  if (state.open) return state
  const next: SessionStatsState = {
    ...state,
    open: {
      id: `${Date.now()}`,
      openedAt: Date.now(),
      session: input.session,
      side: input.side,
      expectedEntry: input.expectedEntry,
      pairId: input.pairId,
      slPips: input.slPips,
      tpPips: input.tpPips,
    },
  }
  saveSessionStats(next)
  return next
}

/** Close with explicit slip pips. */
export function closeTradeWithSlip(
  state: SessionStatsState,
  input: {
    exit: ExitKind
    pnlPips: number
    slipPips: number
    actualEntry?: number
  },
): SessionStatsState {
  if (!state.open) return state
  const o = state.open
  const closed: ClosedTrade = {
    id: o.id,
    openedAt: o.openedAt,
    closedAt: Date.now(),
    session: o.session,
    side: o.side,
    expectedEntry: o.expectedEntry,
    actualEntry: input.actualEntry,
    slipPips: Math.max(0, input.slipPips),
    pnlPips: input.pnlPips,
    exit: input.exit,
    pairId: o.pairId,
  }
  const next: SessionStatsState = {
    ...state,
    open: null,
    closed: [...state.closed, closed].slice(-500),
  }
  saveSessionStats(next)
  return next
}

export function cancelOpen(state: SessionStatsState): SessionStatsState {
  const next = { ...state, open: null }
  saveSessionStats(next)
  return next
}

export function toggleSessionDisabled(
  state: SessionStatsState,
  session: FxSession,
): SessionStatsState {
  const has = state.disabledSessions.includes(session)
  const disabledSessions = has
    ? state.disabledSessions.filter((s) => s !== session)
    : [...state.disabledSessions, session]
  const next = { ...state, disabledSessions }
  saveSessionStats(next)
  return next
}

export function clearSessionStats(): SessionStatsState {
  const next = empty()
  saveSessionStats(next)
  return next
}

const SESSIONS: FxSession[] = ['tokyo', 'london', 'ny']

export function summarizeBySession(
  state: SessionStatsState,
  sinceMs?: number,
): SessionRow[] {
  const trades = state.closed.filter((t) =>
    sinceMs ? t.closedAt >= sinceMs : true,
  )
  return SESSIONS.map((session) => {
    const list = trades.filter((t) => t.session === session)
    const wins = list.filter((t) => t.pnlPips > 0).length
    const losses = list.filter((t) => t.pnlPips <= 0).length
    const netPips = list.reduce((s, t) => s + t.pnlPips, 0)
    const slips = list.filter((t) => t.slipPips > 0 || t.actualEntry != null)
    const avgSlip =
      list.length === 0
        ? 0
        : list.reduce((s, t) => s + t.slipPips, 0) / list.length
    const winRate = list.length ? (wins / list.length) * 100 : 0
    const disabled = state.disabledSessions.includes(session)
    const weak =
      list.length >= 8 &&
      (netPips < 0 || avgSlip > 0.3 || winRate < 45)
    return {
      session,
      label: SESSION_PROFILES[session].labelJa,
      trades: list.length,
      wins,
      losses,
      winRate,
      netPips,
      avgSlip,
      slipSamples: slips.length,
      disabled,
      weak,
    }
  })
}

export function totals(rows: SessionRow[]) {
  const active = rows.filter((r) => !r.disabled)
  const trades = active.reduce((s, r) => s + r.trades, 0)
  const wins = active.reduce((s, r) => s + r.wins, 0)
  const netPips = active.reduce((s, r) => s + r.netPips, 0)
  const slipSum = active.reduce((s, r) => s + r.avgSlip * r.trades, 0)
  return {
    trades,
    winRate: trades ? (wins / trades) * 100 : 0,
    netPips,
    avgSlip: trades ? slipSum / trades : 0,
  }
}

function jstDateKey(ms: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms))
}

/** Net pips from closed trades today (Asia/Tokyo). */
export function todayNetPips(state: SessionStatsState): number {
  const today = jstDateKey()
  return (
    Math.round(
      state.closed
        .filter((t) => jstDateKey(t.closedAt) === today)
        .reduce((s, t) => s + t.pnlPips, 0) * 10,
    ) / 10
  )
}

/** True when today's closed net is at/under the daily loss cap. */
export function isDailyLossHalted(
  state: SessionStatsState,
  capPips: number,
): boolean {
  return todayNetPips(state) <= -Math.abs(capPips)
}
