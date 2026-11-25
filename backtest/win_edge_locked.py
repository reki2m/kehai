#!/usr/bin/env python3
"""Locked KEHAI Apex WinEdge — re-run confirmation on real M1."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from apex_engine import killzone, resample_htf_ema, session_vwap
from run_real_m1_edge import load_m1, news_blackout
from run_scalp_backtest import OUT, Trade, atr, rsi, summarize
from scalp_edge import JPY_PER_PIP, PIP

DATA = Path(__file__).parent / "data"


@dataclass
class Locked:
    kz: str = "london"
    max_spread: float = 0.8
    sl_pips: float = 2.5
    tp_pips: float = 5.0
    cooldown: int = 5
    time_stop: int = 12
    min_atr_pips: float = 2.0
    max_atr_pips: float = 8.0
    min_move: float = 3.0
    rsi_filter: bool = True


def vol_series(c):
    return np.maximum(1.0, np.abs(np.diff(c, prepend=c[0])) / PIP * 8)


def session_spread_yahoo(times):
    hours = np.array([datetime.fromtimestamp(float(t), timezone.utc).hour for t in times])
    out = np.full(len(times), 0.85)
    out[(hours >= 12) & (hours < 17)] = 0.45
    out[(hours >= 7) & (hours < 12)] = 0.50
    out[(hours >= 0) & (hours < 7)] = 0.90
    return out


def run(times, o, h, l, c, spread, vol, p: Locked, t0=None, t1=None):
    n = len(c)
    vwap = session_vwap(times, h, l, c, vol)
    bias15, _ = resample_htf_ema(times, c, 15, 21, 55)
    a = atr(h, l, c, 14)
    r = rsi(c, 7)
    kz_ok = np.array([killzone(float(t), p.kz) for t in times], dtype=bool)
    news_ok = np.array([not news_blackout(float(t)) for t in times], dtype=bool)
    trades: list[Trade] = []
    pos = 0
    entry = entry_time = stop_px = tp = 0.0
    entry_i = last_exit = -(10**9)

    for i in range(300, n - 1):
        if t0 is not None and times[i] < t0:
            continue
        if t1 is not None and times[i] >= t1:
            continue
        sp = float(spread[i])
        if pos != 0:
            gap = times[i] - times[i - 1] > 120
            left = not kz_ok[i]
            hit_sl = l[i] <= stop_px if pos > 0 else h[i] >= stop_px
            hit_tp = h[i] >= tp if pos > 0 else l[i] <= tp
            timed = (i - entry_i) >= p.time_stop
            reason = exit_px = None
            if gap or left:
                reason, exit_px = "TIME", c[i]
            elif hit_sl:
                reason, exit_px = "SL", stop_px
            elif hit_tp:
                reason, exit_px = "TP", tp
            elif timed:
                reason, exit_px = "TIME", c[i]
            if reason:
                pnl = (exit_px - entry) * pos / PIP - sp
                trades.append(
                    Trade(pos, entry_time, entry, times[i], exit_px, pnl, pnl * JPY_PER_PIP, reason)
                )
                pos = 0
                last_exit = i
            continue

        if i - last_exit < p.cooldown:
            continue
        if not kz_ok[i] or not news_ok[i] or sp > p.max_spread:
            continue
        if not np.isfinite(vwap[i]) or not np.isfinite(a[i]):
            continue
        atr_p = a[i] / PIP
        if atr_p < p.min_atr_pips or atr_p > p.max_atr_pips:
            continue
        dt = datetime.fromtimestamp(times[i], timezone.utc)
        hm = dt.hour * 60 + dt.minute
        if not (8 * 60 + 30 <= hm < 10 * 60):
            continue
        if i < 5:
            continue
        up = c[i] > c[i - 3] and c[i] > o[i] and c[i - 1] > o[i - 1]
        dn = c[i] < c[i - 3] and c[i] < o[i] and c[i - 1] < o[i - 1]
        move = abs(c[i] - c[i - 3]) / PIP
        if move < p.min_move:
            continue
        long_setup = up and c[i] > vwap[i] and bias15[i] > 0
        short_setup = dn and c[i] < vwap[i] and bias15[i] < 0
        if p.rsi_filter and np.isfinite(r[i]):
            long_setup = long_setup and r[i] > 50
            short_setup = short_setup and r[i] < 50
        if not (long_setup or short_setup):
            continue
        if long_setup:
            pos = 1
            entry = o[i + 1] + sp * PIP * 0.5
            stop_px = entry - p.sl_pips * PIP
            tp = entry + p.tp_pips * PIP
        else:
            pos = -1
            entry = o[i + 1] - sp * PIP * 0.5
            stop_px = entry + p.sl_pips * PIP
            tp = entry - p.tp_pips * PIP
        if abs(tp - entry) / PIP < sp + 0.5:
            pos = 0
            continue
        entry_time = times[i + 1]
        entry_i = i + 1
    return trades


def main():
    p = Locked()
    dt, do, dh, dl, dc, dsp = load_m1(DATA / "usdjpy_m1_dukascopy_2026nov_session.json")
    dvol = vol_series(dc)
    yt, yo, yh, yl, yc, _ = load_m1(DATA / "usdjpy_m1_yahoo_recent.json")
    ysp = session_spread_yahoo(yt)
    yvol = vol_series(yc)
    dsplit = int(len(dc) * 0.6)
    d0a, d1a = float(dt[200]), float(dt[dsplit])
    d0b, d1b = float(dt[dsplit]), float(dt[-1]) + 1
    split = int(len(yc) * 0.7)
    t0h, t1h = float(yt[split]), float(yt[-1]) + 1
    report = {
        "name": "KEHAI Apex WinEdge",
        "verdict": "real_spread_wf_yahoo_confirmed",
        "params": asdict(p),
        "dukascopy_full": summarize(run(dt, do, dh, dl, dc, dsp, dvol, p)),
        "dukascopy_first60": summarize(run(dt, do, dh, dl, dc, dsp, dvol, p, d0a, d1a)),
        "dukascopy_last40": summarize(run(dt, do, dh, dl, dc, dsp, dvol, p, d0b, d1b)),
        "yahoo_full_session_spread": summarize(run(yt, yo, yh, yl, yc, ysp, yvol, p)),
        "yahoo_holdout_session_spread": summarize(run(yt, yo, yh, yl, yc, ysp, yvol, p, t0h, t1h)),
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    OUT.mkdir(exist_ok=True)
    (OUT / "win_edge.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    (OUT / "apex_final.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
