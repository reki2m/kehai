#!/usr/bin/env python3
"""
Bake off world-blog / TradingView-famous indicators for manual USDJPY scalp:
  - one position (no overlap)
  - fixed SL 7 / TP 10
  - buy/sell flip signals only
  - Tokyo + London Mid + NY Mid windows
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from apex_engine import session_vwap
from famous_indicators import (
    halftrend_dir,
    qqe_dir,
    range_filter_dir,
    ssl_dir,
    supertrend_dir,
    ut_bot_dir,
    wavetrend,
    cross_up,
    cross_dn,
)
from run_real_m1_edge import load_m1, news_blackout
from run_scalp_backtest import OUT, Trade, atr, ema, summarize
from scalp_edge import JPY_PER_PIP, PIP
from triple_session_search import session_of, yspread, BROKER_SPREAD

DATA = Path(__file__).parent / "data"
SL, TP = 7.0, 10.0


def in_any_session(hm: int) -> bool:
    return session_of(hm) is not None


def run_signal(times, o, h, l, c, spread, long_sig, short_sig, news_ok, slip=0.0, max_hold=45):
    n = len(c)
    trades: list[Trade] = []
    pos = 0
    entry = et = stop = tp = 0.0
    ei = last = -(10**9)
    for i in range(300, n - 1):
        sp = float(spread[i])
        dt = datetime.fromtimestamp(times[i], timezone.utc)
        hm = dt.hour * 60 + dt.minute
        if pos != 0:
            hit_sl = l[i] <= stop if pos > 0 else h[i] >= stop
            hit_tp = h[i] >= tp if pos > 0 else l[i] <= tp
            timed = (i - ei) >= max_hold
            gap = times[i] - times[i - 1] > 120
            reason = exit_px = None
            if gap:
                reason, exit_px = "TIME", float(c[i])
            elif hit_sl:
                reason, exit_px = "SL", stop
            elif hit_tp:
                reason, exit_px = "TP", tp
            elif timed:
                reason, exit_px = "TIME", float(c[i])
            if reason:
                exit_px = exit_px - slip * PIP if pos > 0 else exit_px + slip * PIP
                pnl = (exit_px - entry) * pos / PIP - sp
                trades.append(
                    Trade(pos, et, entry, times[i], exit_px, pnl, pnl * JPY_PER_PIP, reason)
                )
                pos = 0
                last = i
            continue

        if not in_any_session(hm) or dt.weekday() >= 5:
            continue
        if not news_ok[i] or sp > 0.45:
            continue
        if i - last < 1:
            continue
        if long_sig[i]:
            pos = 1
            entry = float(o[i + 1]) + sp * PIP * 0.5 + slip * PIP
            stop = entry - SL * PIP
            tp = entry + TP * PIP
        elif short_sig[i]:
            pos = -1
            entry = float(o[i + 1]) - sp * PIP * 0.5 - slip * PIP
            stop = entry + SL * PIP
            tp = entry - TP * PIP
        else:
            continue
        et = times[i + 1]
        ei = i + 1
    return trades


def flip(dir_arr):
    n = len(dir_arr)
    long_sig = np.zeros(n, dtype=bool)
    short_sig = np.zeros(n, dtype=bool)
    for i in range(1, n):
        if dir_arr[i] > 0 and dir_arr[i - 1] <= 0:
            long_sig[i] = True
        elif dir_arr[i] < 0 and dir_arr[i - 1] >= 0:
            short_sig[i] = True
    return long_sig, short_sig


def eval_pair(name, times, o, h, l, c, spread, news_ok, long_sig, short_sig, duka=None):
    y0 = summarize(run_signal(times, o, h, l, c, spread, long_sig, short_sig, news_ok, 0.0))
    y3 = summarize(run_signal(times, o, h, l, c, spread, long_sig, short_sig, news_ok, 0.3))
    d0 = d3 = None
    if duka:
        dt, do, dh, dl, dc, dsp, dnews = duka
        # rebuild signals on duka externally — caller passes matching arrays
        pass
    return {"name": name, "y0": y0, "y3": y3}


def main():
    print("load…", flush=True)
    yt, yo, yh, yl, yc, ysp = load_m1(DATA / "usdjpy_m1_yahoo_recent.json")
    ysp = yspread(yt)
    ynews = np.array([not news_blackout(float(t)) for t in yt], dtype=bool)
    dt, do, dh, dl, dc, dsp = load_m1(DATA / "usdjpy_m1_dukascopy_2026nov_session.json")
    dcost = np.maximum(dsp, BROKER_SPREAD)
    dnews = np.array([not news_blackout(float(t)) for t in dt], dtype=bool)

    def pack(h, l, c):
        ut15, _ = ut_bot_dir(h, l, c, 1.5, 7)
        ut2, _ = ut_bot_dir(h, l, c, 2.0, 7)
        ut210, _ = ut_bot_dir(h, l, c, 2.0, 10)
        st10, _ = supertrend_dir(h, l, c, 10, 3.0)
        st7, _ = supertrend_dir(h, l, c, 7, 2.0)
        ssl10 = ssl_dir(h, l, c, 10)
        ht = halftrend_dir(h, l, c, 2)
        qqe, _ = qqe_dir(c)
        rf, _ = range_filter_dir(c, 14, 2.618)
        wt1, wt2 = wavetrend(h, l, c, 10, 21)
        e21 = ema(c, 21)
        e55 = ema(c, 55)
        return {
            "ut15": ut15,
            "ut2": ut2,
            "ut210": ut210,
            "st10": st10,
            "st7": st7,
            "ssl": ssl10,
            "ht": ht,
            "qqe": qqe,
            "rf": rf,
            "wt1": wt1,
            "wt2": wt2,
            "e21": e21,
            "e55": e55,
        }

    print("indicators…", flush=True)
    Y = pack(yh, yl, yc)
    D = pack(dh, dl, dc)

    def make_strats(P):
        n = len(P["ssl"])
        strats = {}

        def add(name, long_s, short_s):
            strats[name] = (long_s, short_s)

        # singles
        for key, arr in [
            ("UT1.5/7", P["ut15"]),
            ("UT2/7", P["ut2"]),
            ("Supertrend10/3", P["st10"]),
            ("Supertrend7/2", P["st7"]),
            ("SSL10", P["ssl"]),
            ("HalfTrend", P["ht"]),
            ("QQE", P["qqe"]),
            ("RangeFilter", P["rf"]),
        ]:
            lg, sh = flip(arr)
            add(key, lg, sh)

        # WaveTrend cross
        wt_l = np.zeros(n, dtype=bool)
        wt_s = np.zeros(n, dtype=bool)
        for i in range(1, n):
            if cross_up(P["wt1"], P["wt2"], i) and P["wt1"][i] < 60:
                wt_l[i] = True
            if cross_dn(P["wt1"], P["wt2"], i) and P["wt1"][i] > -60:
                wt_s[i] = True
        add("WaveTrend", wt_l, wt_s)

        # Combos (blog-famous stacks)
        def and_confirm(primary, confirm):
            lg, sh = flip(primary)
            for i in range(n):
                if lg[i] and not (confirm[i] > 0):
                    lg[i] = False
                if sh[i] and not (confirm[i] < 0):
                    sh[i] = False
            return lg, sh

        add("UT2×SSL", *and_confirm(P["ut2"], P["ssl"]))
        add("UT1.5×SSL", *and_confirm(P["ut15"], P["ssl"]))
        add("ST10×SSL", *and_confirm(P["st10"], P["ssl"]))
        add("ST7×SSL", *and_confirm(P["st7"], P["ssl"]))
        add("RF×SSL", *and_confirm(P["rf"], P["ssl"]))
        add("HT×SSL", *and_confirm(P["ht"], P["ssl"]))
        add("UT2×ST10", *and_confirm(P["ut2"], P["st10"]))
        add("ST10×EMA", *and_confirm(P["st10"], np.where(P["e21"] > P["e55"], 1, -1)))
        add("UT2×EMA", *and_confirm(P["ut2"], np.where(P["e21"] > P["e55"], 1, -1)))
        # Triple: UT flip + SSL + Supertrend same side
        lg, sh = flip(P["ut2"])
        for i in range(n):
            if lg[i] and not (P["ssl"][i] > 0 and P["st10"][i] > 0):
                lg[i] = False
            if sh[i] and not (P["ssl"][i] < 0 and P["st10"][i] < 0):
                sh[i] = False
        add("UT×SSL×ST", lg, sh)
        return strats

    YS = make_strats(Y)
    DS = make_strats(D)

    rows = []
    print(f"\n{'name':18} {'Ynet0':>7} {'Ynet.3':>7} {'YPF.3':>6} {'Yn':>4} {'Dnet.3':>7} {'DPF.3':>6} {'Dn':>4}", flush=True)
    for name, (ylg, ysh) in YS.items():
        dlg, dsh = DS[name]
        y0 = summarize(run_signal(yt, yo, yh, yl, yc, ysp, ylg, ysh, ynews, 0.0))
        y3 = summarize(run_signal(yt, yo, yh, yl, yc, ysp, ylg, ysh, ynews, 0.3))
        d3 = summarize(run_signal(dt, do, dh, dl, dc, dcost, dlg, dsh, dnews, 0.3))
        score = -1e9
        if y3["trades"] >= 20 and y3["net_pips"] > 0 and d3["net_pips"] > 0:
            score = y3["net_pips"] * 0.5 + d3["net_pips"] * 0.5 + min(y3["profit_factor"], 3) * 15
        rows.append(
            {
                "name": name,
                "score": score,
                "yahoo0": y0,
                "yahoo_slip03": y3,
                "duka_slip03": d3,
            }
        )
        print(
            f"{name:18} {y0['net_pips']:7.1f} {y3['net_pips']:7.1f} {y3['profit_factor']:6.2f} {y3['trades']:4d} "
            f"{d3['net_pips']:7.1f} {d3['profit_factor']:6.2f} {d3['trades']:4d}",
            flush=True,
        )

    rows.sort(key=lambda r: r["score"], reverse=True)
    best = next((r for r in rows if r["score"] > 0), rows[0])
    out = {
        "name": "Blog indicator bakeoff SL7/TP10 manual",
        "rules": {"sl": SL, "tp": TP, "sessions": "tokyo+london+ny", "overlap": False},
        "sources": [
            "UT Bot Alerts (TV / QuantNomad) — taughttotrade teardown",
            "Supertrend — BacktestingMax / TV leaderboards",
            "SSL Channel — TV classic",
            "Range Filter — DonovanWall",
            "WaveTrend — LazyBear",
            "HalfTrend / QQE — TV popular",
        ],
        "best": best["name"],
        "leaderboard": [
            {
                "name": r["name"],
                "score": r["score"],
                "yahoo_slip03_net": r["yahoo_slip03"]["net_pips"],
                "yahoo_pf": r["yahoo_slip03"]["profit_factor"],
                "duka_slip03_net": r["duka_slip03"]["net_pips"],
                "duka_pf": r["duka_slip03"]["profit_factor"],
                "trades_y": r["yahoo_slip03"]["trades"],
            }
            for r in rows[:12]
        ],
        "locked": {
            "stack": best["name"],
            "sl_pips": SL,
            "tp_pips": TP,
            "manual": True,
            "one_position": True,
        },
    }
    OUT.mkdir(exist_ok=True)
    path = OUT / "blog_bakeoff.json"
    path.write_text(json.dumps(out, indent=2))
    print("\nBEST", best["name"], best["score"], flush=True)
    print("wrote", path, flush=True)


if __name__ == "__main__":
    main()
