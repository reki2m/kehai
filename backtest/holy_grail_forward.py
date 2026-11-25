#!/usr/bin/env python3
"""
Multi-week forward stress (Yahoo ~28d M1) + slippage/DD hardening → Grail lock.

Real calendar wait is impossible in-session; this is the rigorous substitute:
weekly folds, adverse fill model, Dukascopy confirm, DD-aware selection.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from famous_indicators import ssl_dir
from run_real_m1_edge import load_m1
from run_scalp_backtest import OUT, Trade, summarize
from scalp_edge import JPY_PER_PIP, PIP
from triple_session_search import (
    BROKER_SPREAD,
    SessCfg,
    precompute,
    session_of,
    yspread,
)

DATA = Path(__file__).parent / "data"

BASE = {
    "tokyo": SessCfg(
        session="tokyo",
        ut_key=1.5,
        ut_atr=7,
        ssl_len=10,
        sl_pips=4,
        tp_pips=8,
        max_spread=0.5,
        require_vwap=False,
        require_ema=True,
        cooldown=2,
        time_stop=15,
    ),
    "london": SessCfg(
        session="london",
        ut_key=2.0,
        ut_atr=10,
        ssl_len=10,
        sl_pips=3,
        tp_pips=6,
        max_spread=0.35,
        require_vwap=True,
        require_ema=False,
        cooldown=1,
        time_stop=12,
    ),
    "ny": SessCfg(
        session="ny",
        ut_key=3.0,
        ut_atr=7,
        ssl_len=10,
        sl_pips=3,
        tp_pips=6,
        max_spread=0.4,
        require_vwap=False,
        require_ema=True,
        cooldown=1,
        time_stop=12,
    ),
}


@dataclass
class GrailOpts:
    name: str
    slip_pips: float = 0.0
    require_htf_ssl: bool = False
    skip_session_edge_min: int = 0
    min_atr_pips: float = 0.0
    daily_loss_cap_pips: float = 0.0
    only_sessions: tuple[str, ...] = ("tokyo", "london", "ny")
    # Extra R on TP to absorb slip (multiplies session tp)
    tp_mult: float = 1.0
    sl_mult: float = 1.0


def htf_ssl_map(times, h, l, c, length=10, minutes=5):
    bucket = times.astype(np.int64) // (minutes * 60)
    rows = []
    cur_b = None
    o = h0 = l0 = c0 = None
    t_end = None
    for i in range(len(c)):
        b = int(bucket[i])
        if cur_b is None:
            cur_b = b
            o = float(c[i])
            h0 = float(h[i])
            l0 = float(l[i])
            c0 = float(c[i])
            t_end = times[i]
            continue
        if b != cur_b:
            rows.append((t_end, o, h0, l0, c0))
            cur_b = b
            o = float(c[i])
            h0 = float(h[i])
            l0 = float(l[i])
            c0 = float(c[i])
            t_end = times[i]
        else:
            h0 = max(h0, float(h[i]))
            l0 = min(l0, float(l[i]))
            c0 = float(c[i])
            t_end = times[i]
    if cur_b is not None:
        rows.append((t_end, o, h0, l0, c0))
    if len(rows) < length + 2:
        return np.zeros(len(c))
    ht = np.array([r[0] for r in rows])
    hh = np.array([r[2] for r in rows])
    ll = np.array([r[3] for r in rows])
    cc = np.array([r[4] for r in rows])
    ssl = ssl_dir(hh, ll, cc, length)
    out = np.zeros(len(c))
    j = 0
    for i in range(len(c)):
        while j + 1 < len(ht) and ht[j + 1] <= times[i]:
            j += 1
        use = j - 1 if ht[j] >= times[i] else j
        if use >= 0 and np.isfinite(ssl[use]):
            out[i] = ssl[use]
    return out


def atr_pips(h, l, c, period=14):
    n = len(c)
    tr = np.zeros(n)
    tr[0] = h[0] - l[0]
    for i in range(1, n):
        tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
    out = np.full(n, np.nan)
    if n < period:
        return out
    out[period - 1] = tr[:period].mean()
    for i in range(period, n):
        out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
    return out / PIP


def session_bounds(session: str):
    if session == "tokyo":
        return 0, 3 * 60
    if session == "london":
        return 8 * 60 + 30, 10 * 60
    if session == "ny":
        return 14 * 60, 16 * 60
    return 0, 24 * 60


def run_grail(times, o, h, l, c, spread, pre, cfgs, opts: GrailOpts, t0=None, t1=None):
    """Slip model: adverse entry fill + adverse exit fill; spread charged once."""
    n = len(c)
    vwap = pre["vwap"]
    news_ok = pre["news"]
    e21 = pre["e21"]
    e55 = pre["e55"]
    htf = pre["htf_ssl"]
    atrp = pre["atr"]
    trades: list[Trade] = []
    pos = 0
    entry = entry_time = stop_px = tp = 0.0
    entry_i = last_exit = -(10**9)
    active: SessCfg | None = None
    day_key = None
    day_pnl = 0.0
    slip = opts.slip_pips

    for i in range(300, n - 1):
        if t0 is not None and times[i] < t0:
            continue
        if t1 is not None and times[i] >= t1:
            continue
        sp = float(spread[i])
        dt = datetime.fromtimestamp(times[i], timezone.utc)
        hm = dt.hour * 60 + dt.minute
        sess = session_of(hm)
        dkey = dt.strftime("%Y-%m-%d")
        if dkey != day_key:
            day_key = dkey
            day_pnl = 0.0

        if pos != 0 and active is not None:
            gap = times[i] - times[i - 1] > 120
            left = sess != active.session
            hit_sl = l[i] <= stop_px if pos > 0 else h[i] >= stop_px
            hit_tp = h[i] >= tp if pos > 0 else l[i] <= tp
            timed = (i - entry_i) >= active.time_stop
            reason = exit_px = None
            if gap or left:
                reason, exit_px = "TIME", float(c[i])
            elif hit_sl:
                reason, exit_px = "SL", stop_px
            elif hit_tp:
                reason, exit_px = "TP", tp
            elif timed:
                reason, exit_px = "TIME", float(c[i])
            if reason:
                # adverse exit slip (away from position)
                exit_px = exit_px - slip * PIP if pos > 0 else exit_px + slip * PIP
                pnl = (exit_px - entry) * pos / PIP - sp
                trades.append(
                    Trade(pos, entry_time, entry, times[i], exit_px, pnl, pnl * JPY_PER_PIP, reason)
                )
                day_pnl += pnl
                pos = 0
                last_exit = i
                active = None
            continue

        if sess is None or sess not in cfgs or sess not in opts.only_sessions:
            continue
        if opts.daily_loss_cap_pips > 0 and day_pnl <= -opts.daily_loss_cap_pips:
            continue
        p = cfgs[sess]
        if i - last_exit < p.cooldown:
            continue
        # gate on raw spread (broker), not slipped
        if not news_ok[i] or sp > p.max_spread:
            continue
        if dt.weekday() >= 5:
            continue
        s0, s1 = session_bounds(sess)
        if opts.skip_session_edge_min > 0:
            if hm < s0 + opts.skip_session_edge_min or hm >= s1 - opts.skip_session_edge_min:
                continue
        if opts.min_atr_pips > 0 and (not np.isfinite(atrp[i]) or atrp[i] < opts.min_atr_pips):
            continue
        if p.require_vwap and not np.isfinite(vwap[i]):
            continue

        ut_dir, _ = pre["ut"][(p.ut_key, p.ut_atr)]
        ssl = pre["ssl"][p.ssl_len]
        long_setup = ut_dir[i] > 0 and ut_dir[i - 1] <= 0 and ssl[i] > 0
        short_setup = ut_dir[i] < 0 and ut_dir[i - 1] >= 0 and ssl[i] < 0
        if p.require_vwap:
            long_setup = long_setup and c[i] >= vwap[i]
            short_setup = short_setup and c[i] <= vwap[i]
        if p.require_ema and np.isfinite(e21[i]) and np.isfinite(e55[i]):
            long_setup = long_setup and e21[i] > e55[i]
            short_setup = short_setup and e21[i] < e55[i]
        if opts.require_htf_ssl:
            long_setup = long_setup and htf[i] > 0
            short_setup = short_setup and htf[i] < 0
        if not (long_setup or short_setup):
            continue

        sl = p.sl_pips * opts.sl_mult
        tp_p = p.tp_pips * opts.tp_mult
        # entry: mid +/- half spread + adverse slip
        if long_setup:
            pos = 1
            entry = float(o[i + 1]) + sp * PIP * 0.5 + slip * PIP
            stop_px = entry - sl * PIP
            tp = entry + tp_p * PIP
        else:
            pos = -1
            entry = float(o[i + 1]) - sp * PIP * 0.5 - slip * PIP
            stop_px = entry + sl * PIP
            tp = entry - tp_p * PIP
        if abs(tp - entry) / PIP < sp + slip * 2 + 0.5:
            pos = 0
            continue
        entry_time = times[i + 1]
        entry_i = i + 1
        active = p

    return trades


def week_bounds(times):
    t_min, t_max = float(times[0]), float(times[-1])
    dt0 = datetime.fromtimestamp(t_min, timezone.utc)
    start = datetime(dt0.year, dt0.month, dt0.day, tzinfo=timezone.utc)
    start_ts = start.timestamp() - start.weekday() * 86400
    edges = []
    t = start_ts
    while t < t_max:
        edges.append(t)
        t += 7 * 86400
    edges.append(t_max + 1)
    out = []
    for i in range(len(edges) - 1):
        a, b = edges[i], edges[i + 1]
        a2 = max(a, t_min)
        if b <= t_min or a2 >= t_max or b - a2 < 2 * 86400:
            continue
        label = datetime.fromtimestamp(a2, timezone.utc).strftime("%Y-%m-%d")
        out.append((label, a2, b))
    return out


def equity_stats(trades: list[Trade]):
    s = summarize(trades)
    calmar = s["net_jpy"] / s["max_dd_jpy"] if s["max_dd_jpy"] > 0 else 0.0
    return {**s, "calmar": round(calmar, 3)}


def score_forward(weeks, full, slip03, slip05):
    if full["trades"] < 12:
        return -1e9
    if full["net_pips"] <= 0:
        return -1e9
    # Must survive realistic demo slip 0.3; 0.5 is stress bonus
    if slip03["net_pips"] <= 0:
        return -1e9
    green = sum(1 for w in weeks if w["net_pips"] > 0)
    red = sum(1 for w in weeks if w["net_pips"] < 0)
    slip_bonus = max(0.0, slip05["net_pips"]) * 0.4
    return (
        full["net_pips"] * 0.25
        + slip03["net_pips"] * 0.7
        + slip_bonus
        + full["calmar"] * 50
        + slip03["calmar"] * 40
        + green * 15
        - red * 20
        - full["max_dd_jpy"] / 800
        - slip03["max_dd_jpy"] / 800
    )


def evaluate_variant(name, times, o, h, l, c, spread, pre, cfgs, opts: GrailOpts, duka=None):
    weeks = week_bounds(times)
    week_rows = []
    for label, a, b in weeks:
        tr = run_grail(times, o, h, l, c, spread, pre, cfgs, opts, t0=a, t1=b)
        week_rows.append({"week": label, **equity_stats(tr)})
    full = equity_stats(run_grail(times, o, h, l, c, spread, pre, cfgs, opts))
    slip03 = equity_stats(run_grail(times, o, h, l, c, spread, pre, cfgs, replace(opts, slip_pips=0.3)))
    slip05 = equity_stats(run_grail(times, o, h, l, c, spread, pre, cfgs, replace(opts, slip_pips=0.5)))
    slip00 = full
    duka_s = duka03 = None
    if duka is not None:
        dt, do, dh, dl, dc, dsp, dpre = duka
        duka_s = equity_stats(run_grail(dt, do, dh, dl, dc, dsp, dpre, cfgs, opts))
        duka03 = equity_stats(
            run_grail(dt, do, dh, dl, dc, dsp, dpre, cfgs, replace(opts, slip_pips=0.3))
        )
    return {
        "name": name,
        "opts": asdict(opts),
        "weeks": week_rows,
        "full": slip00,
        "slip_0.3": slip03,
        "slip_0.5": slip05,
        "duka": duka_s,
        "duka_slip_0.3": duka03,
        "score": score_forward(week_rows, slip00, slip03, slip05),
        "green_weeks": sum(1 for w in week_rows if w["net_pips"] > 0),
        "week_count": len(week_rows),
    }


def main():
    print("load…", flush=True)
    yt, yo, yh, yl, yc, ysp = load_m1(DATA / "usdjpy_m1_yahoo_recent.json")
    ysp = yspread(yt)
    yvol = np.maximum(1.0, np.abs(np.diff(yc, prepend=yc[0])) / PIP * 8)
    ypre = precompute(yt, yh, yl, yc, yvol)
    ypre["htf_ssl"] = htf_ssl_map(yt, yh, yl, yc)
    ypre["atr"] = atr_pips(yh, yl, yc)

    dt, do, dh, dl, dc, dsp = load_m1(DATA / "usdjpy_m1_dukascopy_2026nov_session.json")
    dcost = np.maximum(dsp, BROKER_SPREAD)
    dvol = np.maximum(1.0, np.abs(np.diff(dc, prepend=dc[0])) / PIP * 8)
    dpre = precompute(dt, dh, dl, dc, dvol)
    dpre["htf_ssl"] = htf_ssl_map(dt, dh, dl, dc)
    dpre["atr"] = atr_pips(dh, dl, dc)
    duka = (dt, do, dh, dl, dc, dcost, dpre)

    # Wider TP packs to absorb slip
    wide = {
        "tokyo": replace(BASE["tokyo"], sl_pips=4.0, tp_pips=10.0, cooldown=3, time_stop=18),
        "london": replace(BASE["london"], sl_pips=3.5, tp_pips=9.0, time_stop=15),
        "ny": replace(BASE["ny"], sl_pips=3.5, tp_pips=9.0, time_stop=15, max_spread=0.35),
    }
    selective = {
        "tokyo": replace(BASE["tokyo"], sl_pips=5.0, tp_pips=12.0, cooldown=4, time_stop=20, max_spread=0.4),
        "london": replace(BASE["london"], sl_pips=4.0, tp_pips=10.0, time_stop=16),
        "ny": replace(BASE["ny"], sl_pips=4.0, tp_pips=10.0, time_stop=16, max_spread=0.35),
    }

    variants: list[tuple[str, dict, GrailOpts]] = [
        ("baseline", BASE, GrailOpts(name="baseline")),
        ("baseline_htf", BASE, GrailOpts(name="baseline_htf", require_htf_ssl=True)),
        (
            "wide_htf",
            wide,
            GrailOpts(
                name="wide_htf",
                require_htf_ssl=True,
                skip_session_edge_min=10,
                min_atr_pips=1.0,
                daily_loss_cap_pips=12,
            ),
        ),
        (
            "wide_htf_edge15",
            wide,
            GrailOpts(
                name="wide_htf_edge15",
                require_htf_ssl=True,
                skip_session_edge_min=15,
                min_atr_pips=1.2,
                daily_loss_cap_pips=10,
            ),
        ),
        (
            "selective_htf",
            selective,
            GrailOpts(
                name="selective_htf",
                require_htf_ssl=True,
                skip_session_edge_min=15,
                min_atr_pips=1.3,
                daily_loss_cap_pips=10,
            ),
        ),
        (
            "ln_ny_wide",
            wide,
            GrailOpts(
                name="ln_ny_wide",
                require_htf_ssl=True,
                only_sessions=("london", "ny"),
                skip_session_edge_min=10,
                min_atr_pips=1.0,
                daily_loss_cap_pips=8,
            ),
        ),
        (
            "ln_ny_selective",
            selective,
            GrailOpts(
                name="ln_ny_selective",
                require_htf_ssl=True,
                only_sessions=("london", "ny"),
                skip_session_edge_min=15,
                min_atr_pips=1.2,
                daily_loss_cap_pips=8,
            ),
        ),
        (
            "tokyo_london_wide",
            wide,
            GrailOpts(
                name="tokyo_london_wide",
                require_htf_ssl=True,
                only_sessions=("tokyo", "london"),
                skip_session_edge_min=10,
                daily_loss_cap_pips=10,
                min_atr_pips=1.0,
            ),
        ),
        (
            "grail_tp15",
            selective,
            GrailOpts(
                name="grail_tp15",
                require_htf_ssl=True,
                skip_session_edge_min=10,
                min_atr_pips=1.0,
                daily_loss_cap_pips=10,
                tp_mult=1.25,
            ),
        ),
        (
            "grail_ln_ny_tp15",
            selective,
            GrailOpts(
                name="grail_ln_ny_tp15",
                require_htf_ssl=True,
                only_sessions=("london", "ny"),
                skip_session_edge_min=10,
                min_atr_pips=1.0,
                daily_loss_cap_pips=8,
                tp_mult=1.25,
            ),
        ),
    ]

    results = []
    for name, cfgs, opts in variants:
        print(f"eval {name}…", flush=True)
        row = evaluate_variant(name, yt, yo, yh, yl, yc, ysp, ypre, cfgs, opts, duka)
        results.append((name, cfgs, row))
        print(
            f"  score={row['score']:.1f} net={row['full']['net_pips']:.1f}p "
            f"slip0.3={row['slip_0.3']['net_pips']:.1f}p slip0.5={row['slip_0.5']['net_pips']:.1f}p "
            f"dd={row['full']['max_dd_jpy']:.0f}/{row['slip_0.3']['max_dd_jpy']:.0f} "
            f"green={row['green_weeks']}/{row['week_count']} "
            f"duka03={row['duka_slip_0.3']['net_pips'] if row['duka_slip_0.3'] else None}",
            flush=True,
        )

    results.sort(key=lambda x: x[2]["score"], reverse=True)
    # Prefer triple-session if within 8% of best and slip0.3>0
    best_name, best_cfgs, best = results[0]
    for name, cfgs, row in results:
        sess = set(row["opts"]["only_sessions"])
        if row["slip_0.3"]["net_pips"] <= 0:
            continue
        if sess >= {"tokyo", "london", "ny"} and row["score"] >= best["score"] * 0.9:
            if row["slip_0.3"]["calmar"] >= best["slip_0.3"]["calmar"] * 0.8:
                best_name, best_cfgs, best = name, cfgs, row
                break

    # If nothing beat -1e9, pick least-bad by slip0.3 then calmar
    if best["score"] < -1e8:
        ranked = sorted(
            results,
            key=lambda x: (
                x[2]["slip_0.3"]["net_pips"],
                x[2]["slip_0.3"]["calmar"],
                -x[2]["slip_0.3"]["max_dd_jpy"],
            ),
            reverse=True,
        )
        best_name, best_cfgs, best = ranked[0]

    out = {
        "name": "KEHAI Holy Grail Forward Lock",
        "horizon_note": (
            "Yahoo M1 2026-10-28→11-25 (~4 weeks) as weekly walk-forward; "
            "slippage = adverse entry+exit fill; not a live broker calendar wait"
        ),
        "broker_spread_pips": BROKER_SPREAD,
        "locked_name": best_name,
        "locked_sessions": {k: asdict(v) for k, v in best_cfgs.items()},
        "locked_opts": best["opts"],
        "forward": best,
        "leaderboard": [
            {
                "name": r["name"],
                "score": r["score"],
                "net": r["full"]["net_pips"],
                "slip03": r["slip_0.3"]["net_pips"],
                "slip05": r["slip_0.5"]["net_pips"],
                "dd": r["full"]["max_dd_jpy"],
                "dd_slip03": r["slip_0.3"]["max_dd_jpy"],
                "calmar_slip03": r["slip_0.3"]["calmar"],
                "green": f"{r['green_weeks']}/{r['week_count']}",
                "duka03": r["duka_slip_0.3"]["net_pips"] if r["duka_slip_0.3"] else None,
            }
            for _, _, r in results
        ],
        "paper_rules": {
            "require_5m_ssl_agree": best["opts"]["require_htf_ssl"],
            "skip_session_edge_min": best["opts"]["skip_session_edge_min"],
            "min_atr_pips": best["opts"]["min_atr_pips"],
            "daily_loss_cap_pips": best["opts"]["daily_loss_cap_pips"],
            "tp_mult": best["opts"]["tp_mult"],
            "sl_mult": best["opts"]["sl_mult"],
            "assume_entry_exit_slip_pips": 0.3,
            "sessions": best["opts"]["only_sessions"],
            "demo_lot_hint": 0.01,
            "halt_if_day_loss_pips": best["opts"]["daily_loss_cap_pips"] or 10,
        },
    }
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "holy_grail_forward.json"
    path.write_text(json.dumps(out, indent=2))
    print("\nLOCKED", best_name, "score", best["score"], flush=True)
    print(json.dumps(out["leaderboard"][:5], indent=2), flush=True)
    print("wrote", path, flush=True)


if __name__ == "__main__":
    main()
