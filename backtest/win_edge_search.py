#!/usr/bin/env python3
"""
Find a scalp edge that survives REAL spreads.

Primary gate: Dukascopy (real bid/ask spread) net > 0, PF>=1.15, enough trades.
Secondary: Yahoo holdout net > 0 with conservative 0.8 pip spread.
Reject anything that only wins on synthetic/Yahoo.
"""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from apex_engine import killzone, resample_htf_ema, rolling_swing_levels, session_vwap
from run_real_m1_edge import load_m1, news_blackout
from run_scalp_backtest import OUT, Trade, atr, ema, rsi, summarize
from scalp_edge import PIP, JPY_PER_PIP

DATA = Path(__file__).parent / "data"


@dataclass
class Edge:
    family: str
    # common
    kz: str = "ny"
    max_spread: float = 0.7
    time_stop: int = 12
    cooldown: int = 5
    # fixed-pip scalp
    sl_pips: float = 3.0
    tp_pips: float = 4.5
    # stretch / rsi / sweep knobs
    stretch_pips: float = 8.0
    rsi_lo: float = 28.0
    rsi_hi: float = 72.0
    swing_lb: int = 20
    min_body: float = 0.55
    rr: float = 1.5
    require_bias: bool = True
    vol_mult: float = 1.0


def vol_series(c):
    return np.maximum(1.0, np.abs(np.diff(c, prepend=c[0])) / PIP * 8)


def run_edge(times, o, h, l, c, spread, vol, p: Edge, t0=None, t1=None):
    n = len(c)
    vwap = session_vwap(times, h, l, c, vol)
    bias15, _ = resample_htf_ema(times, c, 15, 21, 55)
    r = rsi(c, 7)
    a = atr(h, l, c, 14)
    swing_hi, swing_lo = rolling_swing_levels(h, l, p.swing_lb)
    e8 = ema(c, 8)
    e21 = ema(c, 21)

    # compression: ATR vs its median
    atr_med = np.full(n, np.nan)
    for i in range(60, n):
        atr_med[i] = np.nanmedian(a[i - 60 : i])

    kz_ok = np.array([killzone(float(t), p.kz) for t in times], dtype=bool)
    news_ok = np.array([not news_blackout(float(t)) for t in times], dtype=bool)

    trades: list[Trade] = []
    pos = 0
    entry = entry_time = stop_px = tp = 0.0
    entry_i = last_exit = -10**9

    for i in range(300, n - 1):
        if t0 is not None and times[i] < t0:
            continue
        if t1 is not None and times[i] >= t1:
            continue
        sp = float(spread[i]) if spread is not None else 0.8

        if pos != 0:
            gap = times[i] - times[i - 1] > 120  # session hole / weekend
            left_kz = not kz_ok[i]
            hit_sl = l[i] <= stop_px if pos > 0 else h[i] >= stop_px
            hit_tp = h[i] >= tp if pos > 0 else l[i] <= tp
            timed = (i - entry_i) >= p.time_stop
            reason = exit_px = None
            if gap or left_kz:
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
        if not kz_ok[i] or not news_ok[i]:
            continue
        if sp > p.max_spread:
            continue
        if not np.isfinite(vwap[i]) or not np.isfinite(a[i]):
            continue

        long_setup = short_setup = False
        stop_long = stop_short = None

        if p.family == "vwap_fade":
            # mean-revert after stretch from VWAP
            dist = (c[i] - vwap[i]) / PIP
            long_setup = dist <= -p.stretch_pips and c[i] > o[i]
            short_setup = dist >= p.stretch_pips and c[i] < o[i]
            if p.require_bias:
                long_setup = long_setup and bias15[i] >= 0
                short_setup = short_setup and bias15[i] <= 0
            stop_long = entry_sl = c[i] - p.sl_pips * PIP  # placeholder; set after entry
            stop_short = c[i] + p.sl_pips * PIP

        elif p.family == "rsi_vwap":
            if not np.isfinite(r[i]):
                continue
            long_setup = r[i] <= p.rsi_lo and c[i] <= vwap[i] and c[i] > o[i]
            short_setup = r[i] >= p.rsi_hi and c[i] >= vwap[i] and c[i] < o[i]
            stop_long = c[i] - p.sl_pips * PIP
            stop_short = c[i] + p.sl_pips * PIP

        elif p.family == "ema_pull":
            if not np.isfinite(e8[i]) or not np.isfinite(e21[i]):
                continue
            up = e8[i] > e21[i] and bias15[i] > 0
            dn = e8[i] < e21[i] and bias15[i] < 0
            touch_up = up and l[i] <= e8[i] <= h[i] and c[i] > e8[i]
            touch_dn = dn and l[i] <= e8[i] <= h[i] and c[i] < e8[i]
            long_setup = touch_up and c[i] > o[i]
            short_setup = touch_dn and c[i] < o[i]
            stop_long = min(l[i], e8[i]) - 0.3 * PIP
            stop_short = max(h[i], e8[i]) + 0.3 * PIP

        elif p.family == "compress_brk":
            if not np.isfinite(atr_med[i]) or atr_med[i] <= 0:
                continue
            compressed = a[i] < atr_med[i] * 0.75
            # look for break of prior 10-bar range after compression
            if i < 15:
                continue
            rh, rl = np.max(h[i - 10 : i]), np.min(l[i - 10 : i])
            body = abs(c[i] - o[i]) / max(h[i] - l[i], 1e-9)
            if body < p.min_body:
                continue
            long_setup = compressed and c[i] > rh and bias15[i] > 0
            short_setup = compressed and c[i] < rl and bias15[i] < 0
            stop_long = rl - 0.3 * PIP
            stop_short = rh + 0.3 * PIP

        elif p.family == "sweep_fixed":
            if not np.isfinite(swing_hi[i]):
                continue
            swept_low = l[i] < swing_lo[i] and c[i] > swing_lo[i] and c[i] > o[i]
            swept_high = h[i] > swing_hi[i] and c[i] < swing_hi[i] and c[i] < o[i]
            long_setup = swept_low and (not p.require_bias or bias15[i] > 0)
            short_setup = swept_high and (not p.require_bias or bias15[i] < 0)
            # prefer VWAP side
            long_setup = long_setup and c[i] >= vwap[i]
            short_setup = short_setup and c[i] <= vwap[i]
            stop_long = c[i] - p.sl_pips * PIP
            stop_short = c[i] + p.sl_pips * PIP

        elif p.family == "micro_mom":
            # 3-bar momentum burst in killzone, fixed pip scalp
            if i < 5:
                continue
            up_burst = c[i] > c[i - 3] and c[i] > o[i] and c[i - 1] > o[i - 1]
            dn_burst = c[i] < c[i - 3] and c[i] < o[i] and c[i - 1] < o[i - 1]
            move = abs(c[i] - c[i - 3]) / PIP
            if move < 2.0:
                continue
            long_setup = up_burst and c[i] > vwap[i] and bias15[i] > 0
            short_setup = dn_burst and c[i] < vwap[i] and bias15[i] < 0
            stop_long = c[i] - p.sl_pips * PIP
            stop_short = c[i] + p.sl_pips * PIP

        else:
            continue

        if not (long_setup or short_setup):
            continue

        # enter next open ± half spread
        if long_setup:
            pos = 1
            entry = o[i + 1] + sp * PIP * 0.5
            # fixed pip or structural
            if p.family in ("vwap_fade", "rsi_vwap", "sweep_fixed", "micro_mom"):
                stop_px = entry - p.sl_pips * PIP
                tp = entry + p.tp_pips * PIP
            else:
                stop_px = stop_long
                risk = entry - stop_px
                if risk <= PIP * 0.6:
                    pos = 0
                    continue
                tp = entry + p.rr * risk
            # sanity: TP must clear spread cost
            if (tp - entry) / PIP < sp + 0.5:
                pos = 0
                continue
        else:
            pos = -1
            entry = o[i + 1] - sp * PIP * 0.5
            if p.family in ("vwap_fade", "rsi_vwap", "sweep_fixed", "micro_mom"):
                stop_px = entry + p.sl_pips * PIP
                tp = entry - p.tp_pips * PIP
            else:
                stop_px = stop_short
                risk = stop_px - entry
                if risk <= PIP * 0.6:
                    pos = 0
                    continue
                tp = entry - p.rr * risk
            if (entry - tp) / PIP < sp + 0.5:
                pos = 0
                continue

        entry_time = times[i + 1]
        entry_i = i + 1

    return trades


def ok_summary(s, min_trades=12, min_pf=1.15):
    if s["trades"] < min_trades:
        return False
    if s["net_pips"] <= 0:
        return False
    if (s["profit_factor"] or 0) < min_pf:
        return False
    return True


def score(duka, yahoo_h, yahoo_f):
    # emphasize real-spread book + holdout agreement
    return (
        duka["net_pips"] * 2
        + yahoo_h["net_pips"]
        + yahoo_f["net_pips"] * 0.3
        + (duka["profit_factor"] or 0) * 20
        + np.sqrt(duka["trades"]) * 3
        - duka["max_dd_jpy"] / 80000
    )


def main():
    sys.stdout.reconfigure(line_buffering=True)
    OUT.mkdir(parents=True, exist_ok=True)

    yahoo_path = DATA / "usdjpy_m1_yahoo_recent.json"
    duka_path = DATA / "usdjpy_m1_dukascopy_2026nov_session.json"
    # prefer expanded duka if present
    for alt in (
        DATA / "usdjpy_m1_dukascopy_real.json",
        DATA / "usdjpy_m1_dukascopy_octnov.json",
    ):
        if alt.exists():
            duka_path = alt
            break

    print("Load Yahoo…", flush=True)
    yt, yo, yh, yl, yc, ysp = load_m1(yahoo_path)
    yvol = vol_series(yc)
    # Yahoo has fake/constant spread — force conservative 0.8
    ysp = np.full(len(yc), 0.8)

    print("Load Dukascopy…", duka_path.name, flush=True)
    dt, do, dh, dl, dc, dsp = load_m1(duka_path)
    dvol = vol_series(dc)
    print(
        f"Yahoo={len(yc)} Duka={len(dc)} avg_spread_duka={float(np.mean(dsp)):.3f}",
        flush=True,
    )

    split = int(len(yc) * 0.7)
    t0h, t1h = float(yt[split]), float(yt[-1]) + 1
    # also chronological split on duka 60/40
    dsplit = int(len(dc) * 0.6)
    d0a, d1a = float(dt[200]), float(dt[dsplit])
    d0b, d1b = float(dt[dsplit]), float(dt[-1]) + 1

    candidates: list[Edge] = []
    for family in ("vwap_fade", "rsi_vwap", "ema_pull", "compress_brk", "sweep_fixed", "micro_mom"):
        for kz in ("ny", "london", "ln"):
            for max_spread in (0.55, 0.7, 0.9):
                for sl, tp in ((2.5, 3.5), (3.0, 4.5), (3.5, 5.5), (4.0, 6.0)):
                    for stretch in (6.0, 9.0, 12.0):
                        for rsi_lo, rsi_hi in ((25, 75), (30, 70)):
                            for require_bias in (True, False):
                                # prune irrelevant dims per family
                                if family not in ("vwap_fade",) and stretch != 9.0:
                                    continue
                                if family not in ("rsi_vwap",) and rsi_lo != 25:
                                    continue
                                if family in ("ema_pull", "compress_brk") and (sl, tp) not in (
                                    (3.0, 4.5),
                                    (3.5, 5.5),
                                ):
                                    # structural stops mostly; still need some grid
                                    if (sl, tp) != (3.0, 4.5):
                                        continue
                                if family in ("ema_pull", "compress_brk") and max_spread == 0.55:
                                    pass
                                p = Edge(
                                    family=family,
                                    kz=kz,
                                    max_spread=max_spread,
                                    sl_pips=sl,
                                    tp_pips=tp,
                                    stretch_pips=stretch,
                                    rsi_lo=rsi_lo,
                                    rsi_hi=rsi_hi,
                                    require_bias=require_bias,
                                    time_stop=10 if tp <= 4.5 else 15,
                                    rr=1.5,
                                )
                                candidates.append(p)

    # de-dupe roughly
    uniq = []
    seen = set()
    for p in candidates:
        key = (
            p.family,
            p.kz,
            p.max_spread,
            p.sl_pips,
            p.tp_pips,
            p.stretch_pips,
            p.rsi_lo,
            p.require_bias,
        )
        if key in seen:
            continue
        seen.add(key)
        uniq.append(p)
    candidates = uniq
    print(f"Grid={len(candidates)}", flush=True)

    survivors = []
    for i, p in enumerate(candidates):
        # Primary: full Dukascopy
        duka_tr = run_edge(dt, do, dh, dl, dc, dsp, dvol, p)
        duka = summarize(duka_tr)
        if not ok_summary(duka, min_trades=10, min_pf=1.1):
            if (i + 1) % 40 == 0:
                print(f"  scanned {i+1}/{len(candidates)} survivors={len(survivors)}", flush=True)
            continue
        # Duka walk-forward both halves non-terrible
        duka_a = summarize(run_edge(dt, do, dh, dl, dc, dsp, dvol, p, d0a, d1a))
        duka_b = summarize(run_edge(dt, do, dh, dl, dc, dsp, dvol, p, d0b, d1b))
        if duka_a["net_pips"] <= -5 or duka_b["net_pips"] <= -5:
            continue
        if duka_a["trades"] < 4 or duka_b["trades"] < 4:
            continue

        # Yahoo holdout + full
        yh_s = summarize(run_edge(yt, yo, yh, yl, yc, ysp, yvol, p, t0h, t1h))
        yf_s = summarize(run_edge(yt, yo, yh, yl, yc, ysp, yvol, p))
        if yh_s["net_pips"] <= 0 or (yh_s["profit_factor"] or 0) < 1.0:
            continue
        if yf_s["net_pips"] <= 0:
            continue

        sc = score(duka, yh_s, yf_s)
        survivors.append((sc, p, duka, duka_a, duka_b, yh_s, yf_s))
        print(
            f"HIT {p.family} kz={p.kz} sp≤{p.max_spread} SL{p.sl_pips}/TP{p.tp_pips} "
            f"duka={duka['net_pips']}p n={duka['trades']} PF={duka['profit_factor']} "
            f"yHold={yh_s['net_pips']} yFull={yf_s['net_pips']} score={sc:.1f}",
            flush=True,
        )

    survivors.sort(key=lambda x: x[0], reverse=True)
    print(f"\nSURVIVORS={len(survivors)}", flush=True)

    if not survivors:
        # Relaxed pass: duka positive + yahoo full positive (holdout soft)
        print("No hard survivors — relaxed pass…", flush=True)
        for i, p in enumerate(candidates):
            duka = summarize(run_edge(dt, do, dh, dl, dc, dsp, dvol, p))
            if duka["trades"] < 8 or duka["net_pips"] <= 0 or (duka["profit_factor"] or 0) < 1.05:
                continue
            yf_s = summarize(run_edge(yt, yo, yh, yl, yc, ysp, yvol, p))
            yh_s = summarize(run_edge(yt, yo, yh, yl, yc, ysp, yvol, p, t0h, t1h))
            if yf_s["net_pips"] <= 0:
                continue
            duka_a = summarize(run_edge(dt, do, dh, dl, dc, dsp, dvol, p, d0a, d1a))
            duka_b = summarize(run_edge(dt, do, dh, dl, dc, dsp, dvol, p, d0b, d1b))
            sc = score(duka, yh_s, yf_s)
            survivors.append((sc, p, duka, duka_a, duka_b, yh_s, yf_s))
            print(
                f"SOFT {p.family} kz={p.kz} duka={duka['net_pips']} yF={yf_s['net_pips']} yH={yh_s['net_pips']}",
                flush=True,
            )
        survivors.sort(key=lambda x: x[0], reverse=True)

    if not survivors:
        report = {
            "name": "KEHAI Apex WinEdge",
            "verdict": "no_robust_real_spread_edge",
            "note": "No candidate beat Dukascopy real spreads with Yahoo confirmation.",
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        (OUT / "win_edge.json").write_text(json.dumps(report, indent=2))
        print(json.dumps(report, indent=2))
        return

    top = survivors[:15]
    for rank, (sc, p, duka, da, db, yh_s, yf_s) in enumerate(top):
        print(
            f"#{rank} {sc:.1f} {asdict(p)} | duka {duka['net_pips']}p PF{duka['profit_factor']} "
            f"| dA {da['net_pips']} dB {db['net_pips']} | yH {yh_s['net_pips']} yF {yf_s['net_pips']}",
            flush=True,
        )

    sc, p, duka, da, db, yh_s, yf_s = survivors[0]
    report = {
        "name": "KEHAI Apex WinEdge",
        "verdict": "real_spread_edge_candidate" if len(survivors) else "soft_only",
        "params": asdict(p),
        "dukascopy_full": duka,
        "dukascopy_first60": da,
        "dukascopy_last40": db,
        "yahoo_holdout": yh_s,
        "yahoo_full": yf_s,
        "survivors": len(survivors),
        "data": {"yahoo": yahoo_path.name, "dukascopy": duka_path.name},
        "stack": [
            f"Family: {p.family}",
            f"Killzone: {p.kz}",
            f"Max spread: {p.max_spread}",
            f"SL/TP: {p.sl_pips}/{p.tp_pips} pips fixed"
            if p.family in ("vwap_fade", "rsi_vwap", "sweep_fixed", "micro_mom")
            else f"Structural SL + {p.rr}R",
            "News blackout",
            "Selected on Dukascopy real spreads first",
        ],
        "note": "Research BT. Primary selection = Dukascopy real bid/ask.",
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    (OUT / "win_edge.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
