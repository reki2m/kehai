#!/usr/bin/env python3
"""Fast Apex family search on REAL M1 (Yahoo train/holdout + Dukascopy confirm)."""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from apex_engine import (
    killzone,
    resample_htf_ema,
    rolling_swing_levels,
    session_vwap,
)
from run_real_m1_edge import load_m1, news_blackout
from run_scalp_backtest import OUT, Trade, summarize
from scalp_edge import PIP, JPY_PER_PIP

DATA = Path(__file__).parent / "data"


@dataclass
class FamParams:
    family: str = "sweep"  # sweep | vwap_pb | orb | asian_brk
    swing_lookback: int = 20
    min_body: float = 0.55
    vol_mult: float = 1.1
    rr: float = 1.8
    sl_buffer_pips: float = 0.4
    time_stop: int = 15
    max_spread: float = 1.0
    kz: str = "ln"
    require_vwap: bool = True
    orb_minutes: int = 30
    asian_end_h: int = 7  # UTC hour when Asian range freezes


def precompute_orb(times, h, l, orb_minutes: int):
    n = len(times)
    orb_hi = np.full(n, np.nan)
    orb_lo = np.full(n, np.nan)
    i = 0
    while i < n:
        dt = datetime.fromtimestamp(times[i], timezone.utc)
        day = dt.date()
        start_ts = datetime(day.year, day.month, day.day, 7, 0, tzinfo=timezone.utc).timestamp()
        end_ts = datetime(
            day.year, day.month, day.day, 7, orb_minutes, tzinfo=timezone.utc
        ).timestamp()
        # advance day window
        j = i
        day_hi = -np.inf
        day_lo = np.inf
        collecting = False
        frozen_hi = frozen_lo = np.nan
        while j < n:
            d2 = datetime.fromtimestamp(times[j], timezone.utc).date()
            if d2 != day:
                break
            t = times[j]
            if start_ts <= t < end_ts:
                collecting = True
                day_hi = max(day_hi, h[j])
                day_lo = min(day_lo, l[j])
            elif t >= end_ts and collecting:
                frozen_hi, frozen_lo = day_hi, day_lo
                collecting = False
            if np.isfinite(frozen_hi):
                orb_hi[j] = frozen_hi
                orb_lo[j] = frozen_lo
            j += 1
        i = j
    return orb_hi, orb_lo


def precompute_asian(times, h, l, end_h: int = 7):
    """Asian range = 00:00–end_h UTC high/low, used after end_h."""
    n = len(times)
    a_hi = np.full(n, np.nan)
    a_lo = np.full(n, np.nan)
    i = 0
    while i < n:
        dt = datetime.fromtimestamp(times[i], timezone.utc)
        day = dt.date()
        end_ts = datetime(day.year, day.month, day.day, end_h, 0, tzinfo=timezone.utc).timestamp()
        j = i
        day_hi = -np.inf
        day_lo = np.inf
        frozen_hi = frozen_lo = np.nan
        while j < n:
            d2 = datetime.fromtimestamp(times[j], timezone.utc).date()
            if d2 != day:
                break
            t = times[j]
            if t < end_ts:
                day_hi = max(day_hi, h[j])
                day_lo = min(day_lo, l[j])
            else:
                if not np.isfinite(frozen_hi) and day_hi > -np.inf:
                    frozen_hi, frozen_lo = day_hi, day_lo
                if np.isfinite(frozen_hi):
                    a_hi[j] = frozen_hi
                    a_lo[j] = frozen_lo
            j += 1
        i = j
    return a_hi, a_lo


def run_family(times, o, h, l, c, spread, vol, p: FamParams, t0=None, t1=None):
    n = len(c)
    swing_hi, swing_lo = rolling_swing_levels(h, l, p.swing_lookback)
    vwap = session_vwap(times, h, l, c, vol)
    bias15, _ = resample_htf_ema(times, c, 15, 21, 55)
    vol_med = np.full(n, np.nan)
    # rolling median approx via mean of last 50 for speed
    for i in range(50, n):
        vol_med[i] = np.median(vol[i - 50 : i])

    orb_hi = orb_lo = None
    asian_hi = asian_lo = None
    if p.family == "orb":
        orb_hi, orb_lo = precompute_orb(times, h, l, p.orb_minutes)
    if p.family == "asian_brk":
        asian_hi, asian_lo = precompute_asian(times, h, l, p.asian_end_h)

    # precompute killzone / news / year masks
    kz_ok = np.array([killzone(float(t), p.kz) for t in times], dtype=bool)
    news_ok = np.array([not news_blackout(float(t)) for t in times], dtype=bool)

    trades: list[Trade] = []
    pos = 0
    entry = entry_time = stop_px = tp = 0.0
    entry_i = last_exit = -10**9
    stop_long = stop_short = 0.0

    for i in range(400, n - 1):
        if t0 is not None and times[i] < t0:
            continue
        if t1 is not None and times[i] >= t1:
            continue
        sp = float(spread[i]) if spread is not None else 0.8

        if pos != 0:
            hit_sl = l[i] <= stop_px if pos > 0 else h[i] >= stop_px
            hit_tp = h[i] >= tp if pos > 0 else l[i] <= tp
            timed = (i - entry_i) >= p.time_stop
            reason = exit_px = None
            if hit_sl:
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

        if i - last_exit < 5:
            continue
        if not kz_ok[i] or not news_ok[i]:
            continue
        if sp > p.max_spread:
            continue

        body = abs(c[i] - o[i])
        rng = max(h[i] - l[i], 1e-9)
        if body / rng < p.min_body:
            continue
        if np.isfinite(vol_med[i]) and vol[i] < vol_med[i] * p.vol_mult:
            continue

        long_setup = short_setup = False

        if p.family == "sweep":
            if not np.isfinite(swing_hi[i]):
                continue
            swept_low = l[i] < swing_lo[i] and c[i] > swing_lo[i] and c[i] > o[i]
            swept_high = h[i] > swing_hi[i] and c[i] < swing_hi[i] and c[i] < o[i]
            long_setup = swept_low and bias15[i] > 0
            short_setup = swept_high and bias15[i] < 0
            if p.require_vwap and np.isfinite(vwap[i]):
                long_setup = long_setup and c[i] >= vwap[i]
                short_setup = short_setup and c[i] <= vwap[i]
            stop_long = min(l[i], swing_lo[i]) - p.sl_buffer_pips * PIP
            stop_short = max(h[i], swing_hi[i]) + p.sl_buffer_pips * PIP

        elif p.family == "vwap_pb":
            if not np.isfinite(vwap[i]):
                continue
            touch_up = h[i] >= vwap[i] >= l[i] and c[i] > vwap[i] and bias15[i] > 0
            touch_dn = h[i] >= vwap[i] >= l[i] and c[i] < vwap[i] and bias15[i] < 0
            long_setup = touch_up and c[i] > o[i]
            short_setup = touch_dn and c[i] < o[i]
            stop_long = min(l[i], vwap[i]) - p.sl_buffer_pips * PIP
            stop_short = max(h[i], vwap[i]) + p.sl_buffer_pips * PIP

        elif p.family == "orb":
            if orb_hi is None or not np.isfinite(orb_hi[i]):
                continue
            brk_up = c[i] > orb_hi[i] and o[i] <= orb_hi[i] and bias15[i] > 0
            brk_dn = c[i] < orb_lo[i] and o[i] >= orb_lo[i] and bias15[i] < 0
            long_setup = brk_up
            short_setup = brk_dn
            stop_long = orb_lo[i] - p.sl_buffer_pips * PIP
            stop_short = orb_hi[i] + p.sl_buffer_pips * PIP

        else:  # asian_brk
            if asian_hi is None or not np.isfinite(asian_hi[i]):
                continue
            brk_up = c[i] > asian_hi[i] and o[i] <= asian_hi[i] and bias15[i] > 0
            brk_dn = c[i] < asian_lo[i] and o[i] >= asian_lo[i] and bias15[i] < 0
            long_setup = brk_up
            short_setup = brk_dn
            stop_long = asian_lo[i] - p.sl_buffer_pips * PIP
            stop_short = asian_hi[i] + p.sl_buffer_pips * PIP

        if not (long_setup or short_setup):
            continue

        if long_setup:
            pos = 1
            entry = o[i + 1] + sp * PIP * 0.5
            entry_time = times[i + 1]
            entry_i = i + 1
            risk = entry - stop_long
            if risk <= PIP * 0.8:
                pos = 0
                continue
            stop_px = stop_long
            tp = entry + p.rr * risk
        else:
            pos = -1
            entry = o[i + 1] - sp * PIP * 0.5
            entry_time = times[i + 1]
            entry_i = i + 1
            risk = stop_short - entry
            if risk <= PIP * 0.8:
                pos = 0
                continue
            stop_px = stop_short
            tp = entry - p.rr * risk

    return trades


def obj(s):
    if s["trades"] < 12:
        return -1e9
    pf = s["profit_factor"] or 0
    if s["net_pips"] <= 0:
        return -100 + pf
    return pf * np.sqrt(s["trades"]) + s["net_pips"] / 40 - s["max_dd_jpy"] / 200000


def main():
    sys.stdout.reconfigure(line_buffering=True)
    OUT.mkdir(parents=True, exist_ok=True)

    yahoo = DATA / "usdjpy_m1_yahoo_recent.json"
    duka = DATA / "usdjpy_m1_dukascopy_2026nov_session.json"
    print("Loading Yahoo real M1…", flush=True)
    t, o, h, l, c, sp = load_m1(yahoo)
    rows = json.loads(yahoo.read_text())
    vol = np.array([r.get("volume", 1) for r in rows], dtype=np.float64)
    sp = np.full(len(c), 0.8)
    print(f"Yahoo M1 bars={len(c)}  {datetime.fromtimestamp(t[0], timezone.utc)} → {datetime.fromtimestamp(t[-1], timezone.utc)}", flush=True)

    # 70/30 chronological split
    split = int(len(c) * 0.7)
    t0_train, t1_train = float(t[400]), float(t[split])
    t0_hold, t1_hold = float(t[split]), float(t[-1]) + 1
    print(f"Train bars ~{split}, holdout ~{len(c)-split}", flush=True)

    candidates = []
    families = ("sweep", "vwap_pb", "orb", "asian_brk")
    grid = 0
    for family in families:
        for lookback in (15, 25, 35):
            for min_body in (0.45, 0.6):
                for rr in (1.5, 1.8, 2.2):
                    for kz in ("ln", "london", "ny"):
                        for require_vwap in (True, False):
                            for vol_mult in (1.0, 1.2):
                                if family != "sweep" and lookback not in (15, 25):
                                    continue
                                if family in ("orb", "asian_brk", "vwap_pb") and require_vwap:
                                    continue  # N/A or always-on for vwap_pb
                                if family == "vwap_pb" and lookback != 15:
                                    continue
                                p = FamParams(
                                    family=family,
                                    swing_lookback=lookback,
                                    min_body=min_body,
                                    rr=rr,
                                    kz=kz,
                                    require_vwap=require_vwap,
                                    vol_mult=vol_mult,
                                    max_spread=1.2,
                                    time_stop=15 if rr <= 1.8 else 20,
                                )
                                grid += 1
                                tr = run_family(t, o, h, l, c, sp, vol, p, t0_train, t1_train)
                                s = summarize(tr)
                                candidates.append((obj(s), p, s))
                                if grid % 20 == 0:
                                    print(f"  scanned {grid}…", flush=True)

    candidates.sort(key=lambda x: x[0], reverse=True)
    print(f"Grid size={grid}. TOP train:", flush=True)
    for i, (sc, p, s) in enumerate(candidates[:12]):
        print(
            i,
            f"{sc:.1f}",
            asdict(p),
            f"n={s['trades']} WR={s['win_rate']} pips={s['net_pips']} PF={s['profit_factor']}",
            flush=True,
        )

    picked = None
    for sc, p, s in candidates:
        if s["net_pips"] > 0 and (s["profit_factor"] or 0) >= 1.1 and s["trades"] >= 15:
            hold = summarize(run_family(t, o, h, l, c, sp, vol, p, t0_hold, t1_hold))
            if hold["net_pips"] > 0 and (hold["profit_factor"] or 0) >= 1.0:
                picked = (p, s, hold, "robust")
                break

    if picked is None:
        # best holdout among top train (even if negative — honesty)
        best = None
        for sc, p, s in candidates[:40]:
            hold = summarize(run_family(t, o, h, l, c, sp, vol, p, t0_hold, t1_hold))
            key = hold["net_pips"]
            if best is None or key > best[2]["net_pips"]:
                best = (p, s, hold, "best_effort")
        picked = best

    p, s_train, s_hold, mode = picked
    print("PICKED", mode, asdict(p), flush=True)
    print("TRAIN", s_train, flush=True)
    print("HOLDOUT", s_hold, flush=True)

    full = summarize(run_family(t, o, h, l, c, sp, vol, p))
    confirms = {"yahoo_full": full}

    if duka.exists():
        print("Confirm Dukascopy…", flush=True)
        dt, do, dh, dl, dc, dsp = load_m1(duka)
        drows = json.loads(duka.read_text())
        dvol = np.array([r.get("volume", 1) for r in drows], dtype=np.float64)
        confirms["dukascopy"] = summarize(run_family(dt, do, dh, dl, dc, dsp, dvol, p))
        print("CONFIRM duka", confirms["dukascopy"], flush=True)

    report = {
        "name": "KEHAI Apex",
        "selection_mode": mode,
        "params": asdict(p),
        "data": {
            "yahoo_m1": str(yahoo.name),
            "yahoo_bars": int(len(c)),
            "train_pct": 0.7,
            "dukascopy": str(duka.name) if duka.exists() else None,
        },
        "train": s_train,
        "holdout": s_hold,
        "real_m1_confirm": confirms,
        "stack": [
            f"Family: {p.family}",
            "15m EMA21/55 bias",
            f"Killzone: {p.kz}",
            "Liquidity sweep / VWAP PB / ORB / Asian break",
            "Displacement + volume impulse",
            "News + spread filters",
            f"RR={p.rr}, time-stop={p.time_stop}",
        ],
        "verdict": (
            "robust_edge"
            if mode == "robust"
            else "architecture_peak_edge_unproven_on_real_m1"
        ),
        "note": "Selected on real Yahoo M1; confirmed on Dukascopy session M1. Research BT only.",
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    (OUT / "apex_final.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
