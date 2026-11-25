#!/usr/bin/env python3
"""Tune UT×SSL for Tokyo + London Mid + NY Mid on real M1 (0.2p spread)."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from apex_engine import session_vwap
from famous_indicators import ssl_dir, ut_bot_dir
from run_real_m1_edge import load_m1, news_blackout
from run_scalp_backtest import OUT, Trade, summarize
from scalp_edge import JPY_PER_PIP, PIP

DATA = Path(__file__).parent / "data"
BROKER_SPREAD = 0.2


@dataclass
class SessCfg:
    session: str  # tokyo | london | ny
    ut_key: float = 2.0
    ut_atr: int = 7
    ssl_len: int = 10
    sl_pips: float = 2.5
    tp_pips: float = 5.0
    max_spread: float = 0.35
    require_vwap: bool = True
    cooldown: int = 1
    time_stop: int = 12
    # optional: require EMA21>EMA55 for long (trend filter for thin sessions)
    require_ema: bool = False


def in_session(hm: int, session: str) -> bool:
    if session == "tokyo":
        # 09:00–12:00 JST = 00:00–03:00 UTC (Tokyo open impulse)
        return 0 <= hm < 3 * 60
    if session == "london":
        return 8 * 60 + 30 <= hm < 10 * 60
    if session == "ny":
        # NY AM killzone mid: 14:00–16:00 UTC (09:00–11:00 ET approx)
        return 14 * 60 <= hm < 16 * 60
    if session == "all":
        return in_session(hm, "tokyo") or in_session(hm, "london") or in_session(hm, "ny")
    return False


def session_of(hm: int) -> str | None:
    if in_session(hm, "tokyo"):
        return "tokyo"
    if in_session(hm, "london"):
        return "london"
    if in_session(hm, "ny"):
        return "ny"
    return None


def yspread(times):
    """Fallback when dataset has no real spread — still gate with max_spread."""
    hours = np.array([datetime.fromtimestamp(float(t), timezone.utc).hour for t in times])
    out = np.full(len(times), BROKER_SPREAD)
    # mild widen outside core liquidity (model only; user broker is 0.2)
    out[(hours >= 0) & (hours < 3)] = 0.25
    out[(hours >= 3) & (hours < 7)] = 0.35
    out[(hours >= 7) & (hours < 12)] = 0.22
    out[(hours >= 12) & (hours < 17)] = 0.20
    out[(hours >= 17)] = 0.30
    return out


def ema(c, period):
    out = np.full_like(c, np.nan, dtype=float)
    if len(c) < period:
        return out
    k = 2 / (period + 1)
    out[period - 1] = c[:period].mean()
    for i in range(period, len(c)):
        out[i] = c[i] * k + out[i - 1] * (1 - k)
    return out


def run_multi(times, o, h, l, c, spread, pre, cfgs: dict[str, SessCfg], t0=None, t1=None):
    n = len(c)
    vwap = pre["vwap"]
    news_ok = pre["news"]
    e21 = pre["e21"]
    e55 = pre["e55"]
    trades: list[Trade] = []
    pos = 0
    entry = entry_time = stop_px = tp = 0.0
    entry_i = last_exit = -(10**9)
    active: SessCfg | None = None

    for i in range(300, n - 1):
        if t0 is not None and times[i] < t0:
            continue
        if t1 is not None and times[i] >= t1:
            continue
        sp = float(spread[i])
        dt = datetime.fromtimestamp(times[i], timezone.utc)
        hm = dt.hour * 60 + dt.minute
        sess = session_of(hm)

        if pos != 0 and active is not None:
            gap = times[i] - times[i - 1] > 120
            left = sess != active.session
            hit_sl = l[i] <= stop_px if pos > 0 else h[i] >= stop_px
            hit_tp = h[i] >= tp if pos > 0 else l[i] <= tp
            timed = (i - entry_i) >= active.time_stop
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
                active = None
            continue

        if sess is None or sess not in cfgs:
            continue
        p = cfgs[sess]
        if i - last_exit < p.cooldown:
            continue
        if not news_ok[i] or sp > p.max_spread:
            continue
        if dt.weekday() >= 5:
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
        active = p

    return trades


def precompute(times, h, l, c, vol):
    pre = {
        "vwap": session_vwap(times, h, l, c, vol),
        "news": np.array([not news_blackout(float(t)) for t in times], dtype=bool),
        "ut": {},
        "ssl": {},
        "e21": ema(c, 21),
        "e55": ema(c, 55),
    }
    for key in (1.0, 1.5, 2.0, 3.0):
        for ap in (5, 7, 10):
            pre["ut"][(key, ap)] = ut_bot_dir(h, l, c, key, ap)
    for length in (10, 15, 20):
        pre["ssl"][length] = ssl_dir(h, l, c, length)
    return pre


def score_summary(s, min_trades=8):
    if s["trades"] < min_trades:
        return -1e9
    if s["profit_factor"] < 1.05:
        return -1e9
    if s["net_pips"] <= 0:
        return -1e9
    return s["net_pips"] * min(3.0, s["profit_factor"]) + s["win_rate"] * 0.2


def grid_for(session: str):
    rows = []
    keys = (1.5, 2.0, 3.0) if session == "tokyo" else (2.0, 3.0)
    atrs = (5, 7, 10) if session == "tokyo" else (7, 10)
    spreads = (0.35, 0.5) if session == "tokyo" else (0.35,)
    risks = ((2.5, 5.0), (3.0, 6.0), (4.0, 8.0)) if session == "tokyo" else ((2.5, 5.0), (3.0, 6.0))
    for ut_key in keys:
        for ut_atr in atrs:
            for ssl_len in (10, 15):
                for sl, tp in risks:
                    for max_spread in spreads:
                        for require_vwap in (True, False):
                            emas = (True, False) if session == "tokyo" else (False,)
                            for require_ema in emas:
                                rows.append(
                                    SessCfg(
                                        session=session,
                                        ut_key=ut_key,
                                        ut_atr=ut_atr,
                                        ssl_len=ssl_len,
                                        sl_pips=sl,
                                        tp_pips=tp,
                                        max_spread=max_spread,
                                        require_vwap=require_vwap,
                                        require_ema=require_ema,
                                        cooldown=1 if session != "tokyo" else 2,
                                        time_stop=12 if session != "tokyo" else 15,
                                    )
                                )
    return rows


def main():
    print("load data…", flush=True)
    yt, yo, yh, yl, yc, ysp = load_m1(DATA / "usdjpy_m1_yahoo_recent.json")
    if np.nanmean(ysp) > 0.5:
        # yahoo file may store placeholder spread; force broker model
        ysp = yspread(yt)
    else:
        ysp = np.maximum(ysp, BROKER_SPREAD)
    yvol = np.maximum(1.0, np.abs(np.diff(yc, prepend=yc[0])) / PIP * 8)

    dt, do, dh, dl, dc, dsp = load_m1(DATA / "usdjpy_m1_dukascopy_2026nov_session.json")
    # Duka has real spreads but clamp floor to broker 0.2 for costing; gate uses raw
    dcost = np.maximum(dsp, BROKER_SPREAD)
    dvol = np.maximum(1.0, np.abs(np.diff(dc, prepend=dc[0])) / PIP * 8)

    print("precompute yahoo…", flush=True)
    ypre = precompute(yt, yh, yl, yc, yvol)
    print("precompute duka…", flush=True)
    dpre = precompute(dt, dh, dl, dc, dvol)

    # walk-forward split on yahoo
    mid = yt[len(yt) // 2]
    best: dict[str, SessCfg] = {}
    per_session = {}

    for session in ("tokyo", "london", "ny"):
        print(f"\n=== search {session} ===", flush=True)
        cands = []
        for cfg in grid_for(session):
            tr_a = run_multi(yt, yo, yh, yl, yc, ysp, ypre, {session: cfg}, t1=mid)
            tr_b = run_multi(yt, yo, yh, yl, yc, ysp, ypre, {session: cfg}, t0=mid)
            sa, sb = summarize(tr_a), summarize(tr_b)
            if sa["net_pips"] <= 0 or sb["net_pips"] <= 0:
                continue
            if sa["trades"] < 5 or sb["trades"] < 5:
                continue
            tr_f = run_multi(yt, yo, yh, yl, yc, ysp, ypre, {session: cfg})
            sf = summarize(tr_f)
            # confirm on duka if session hours exist in sample
            tr_d = run_multi(dt, do, dh, dl, dc, dcost, dpre, {session: cfg})
            sd = summarize(tr_d)
            sc = score_summary(sa) + score_summary(sb) + 0.5 * score_summary(sf, 10)
            if sd["trades"] >= 5:
                sc += 0.35 * score_summary(sd, 5)
            elif sd["trades"] == 0:
                sc *= 0.85  # no duka coverage (tokyo often missing in session-only dump)
            cands.append((sc, cfg, sa, sb, sf, sd))
        cands.sort(key=lambda x: x[0], reverse=True)
        if not cands:
            print(f"NO HIT {session} — fallback london-like", flush=True)
            best[session] = SessCfg(session=session, ut_key=2, ut_atr=7, ssl_len=10, require_vwap=True)
            per_session[session] = {"note": "fallback"}
            continue
        sc, cfg, sa, sb, sf, sd = cands[0]
        best[session] = cfg
        per_session[session] = {
            "score": sc,
            "params": asdict(cfg),
            "yahoo_first": sa,
            "yahoo_last": sb,
            "yahoo_full": sf,
            "duka": sd,
            "alts": [
                {"score": c[0], "params": asdict(c[1]), "yahoo_full": c[4], "duka": c[5]}
                for c in cands[:5]
            ],
        }
        print(
            f"BEST {session}: PF={sf['profit_factor']} trades={sf['trades']} "
            f"net={sf['net_pips']:.1f}p duka_net={sd['net_pips']:.1f} {asdict(cfg)}",
            flush=True,
        )

    # Combined triple session
    print("\n=== combined triple ===", flush=True)
    comb_y = run_multi(yt, yo, yh, yl, yc, ysp, ypre, best)
    comb_d = run_multi(dt, do, dh, dl, dc, dcost, dpre, best)
    sy, sd = summarize(comb_y), summarize(comb_d)
    print("yahoo combined", sy, flush=True)
    print("duka combined", sd, flush=True)

    out = {
        "name": "KEHAI Apex Triple Session (Tokyo+London+NY)",
        "spread_pips": BROKER_SPREAD,
        "sessions": per_session,
        "combined_yahoo": sy,
        "combined_duka": sd,
        "locked": {k: asdict(v) for k, v in best.items()},
    }
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "triple_session.json"
    path.write_text(json.dumps(out, indent=2))
    print("wrote", path, flush=True)


if __name__ == "__main__":
    main()
