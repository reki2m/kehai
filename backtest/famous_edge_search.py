#!/usr/bin/env python3
"""Search famous-TV indicator stacks on real-spread M1."""

from __future__ import annotations

import json
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from apex_engine import killzone, session_vwap
from famous_indicators import (
    cross_dn,
    cross_up,
    halftrend_dir,
    qqe_dir,
    ssl_dir,
    ut_bot_dir,
    wavetrend,
)
from run_real_m1_edge import load_m1, news_blackout
from run_scalp_backtest import OUT, Trade, atr, summarize
from scalp_edge import JPY_PER_PIP, PIP

DATA = Path(__file__).parent / "data"


@dataclass
class Fam:
    family: str  # ut_bot | wavetrend | ssl | halftrend | qqe | ut_ssl | ut_wt
    kz: str = "london"
    hour_mode: str = "kz"  # kz | mid
    max_spread: float = 0.8
    sl_pips: float = 3.0
    tp_pips: float = 6.0
    cooldown: int = 2
    time_stop: int = 12
    require_vwap: bool = True
    # indicator knobs
    ut_key: float = 2.0
    ut_atr: int = 10
    wt_ch: int = 10
    wt_avg: int = 21
    ssl_len: int = 10
    ht_amp: int = 2


def vol_series(c):
    return np.maximum(1.0, np.abs(np.diff(c, prepend=c[0])) / PIP * 8)


def yspread(times):
    hours = np.array([datetime.fromtimestamp(float(t), timezone.utc).hour for t in times])
    out = np.full(len(times), 0.85)
    out[(hours >= 12) & (hours < 17)] = 0.45
    out[(hours >= 7) & (hours < 12)] = 0.50
    out[(hours >= 0) & (hours < 7)] = 0.90
    return out


def in_window(hm, kz, mode):
    london_kz = 7 * 60 <= hm < 10 * 60
    ny_kz = 12 * 60 + 30 <= hm < 16 * 60
    london_mid = 8 * 60 + 30 <= hm < 10 * 60
    ny_mid = 14 * 60 <= hm < 16 * 60
    if mode == "mid":
        if kz == "london":
            return london_mid
        if kz == "ny":
            return ny_mid
        return london_mid or ny_mid
    if kz == "london":
        return london_kz
    if kz == "ny":
        return ny_kz
    return london_kz or ny_kz


def run(times, o, h, l, c, spread, vol, p: Fam, pre, t0=None, t1=None):
    n = len(c)
    vwap = pre["vwap"]
    kz_ok = pre["kz"][p.kz]
    news_ok = pre["news"]
    ut_dir, _ = pre["ut"][(p.ut_key, p.ut_atr)]
    wt1, wt2 = pre["wt"][(p.wt_ch, p.wt_avg)]
    ssl = pre["ssl"][p.ssl_len]
    ht = pre["ht"][p.ht_amp]
    qqe, _ = pre["qqe"]

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
        dt = datetime.fromtimestamp(times[i], timezone.utc)
        if dt.weekday() >= 5:
            continue
        hm = dt.hour * 60 + dt.minute
        if not in_window(hm, p.kz, p.hour_mode):
            continue
        if p.require_vwap and (not np.isfinite(vwap[i])):
            continue

        long_setup = short_setup = False
        if p.family == "ut_bot":
            long_setup = ut_dir[i] > 0 and ut_dir[i - 1] <= 0
            short_setup = ut_dir[i] < 0 and ut_dir[i - 1] >= 0
        elif p.family == "wavetrend":
            long_setup = cross_up(wt1, wt2, i) and wt1[i] < 60
            short_setup = cross_dn(wt1, wt2, i) and wt1[i] > -60
        elif p.family == "ssl":
            long_setup = ssl[i] > 0 and ssl[i - 1] <= 0
            short_setup = ssl[i] < 0 and ssl[i - 1] >= 0
        elif p.family == "halftrend":
            long_setup = ht[i] > 0 and ht[i - 1] <= 0
            short_setup = ht[i] < 0 and ht[i - 1] >= 0
        elif p.family == "qqe":
            long_setup = qqe[i] > 0 and qqe[i - 1] <= 0
            short_setup = qqe[i] < 0 and qqe[i - 1] >= 0
        elif p.family == "ut_ssl":
            long_setup = ut_dir[i] > 0 and ut_dir[i - 1] <= 0 and ssl[i] > 0
            short_setup = ut_dir[i] < 0 and ut_dir[i - 1] >= 0 and ssl[i] < 0
        elif p.family == "ut_wt":
            long_setup = ut_dir[i] > 0 and ut_dir[i - 1] <= 0 and wt1[i] > wt2[i]
            short_setup = ut_dir[i] < 0 and ut_dir[i - 1] >= 0 and wt1[i] < wt2[i]
        else:
            continue

        if p.require_vwap:
            long_setup = long_setup and c[i] >= vwap[i]
            short_setup = short_setup and c[i] <= vwap[i]

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


def precompute(times, h, l, c, vol):
    print("precompute indicators…", flush=True)
    pre = {
        "vwap": session_vwap(times, h, l, c, vol),
        "news": np.array([not news_blackout(float(t)) for t in times], dtype=bool),
        "kz": {
            "london": np.array([killzone(float(t), "london") for t in times], dtype=bool),
            "ny": np.array([killzone(float(t), "ny") for t in times], dtype=bool),
            "ln": np.array([killzone(float(t), "ln") for t in times], dtype=bool),
        },
        "ut": {},
        "wt": {},
        "ssl": {},
        "ht": {},
        "qqe": qqe_dir(c),
    }
    for key in (1.0, 2.0, 3.0):
        for ap in (7, 10):
            pre["ut"][(key, ap)] = ut_bot_dir(h, l, c, key, ap)
    for ch, avg in ((10, 21), (9, 12), (12, 21)):
        pre["wt"][(ch, avg)] = wavetrend(h, l, c, ch, avg)
    for length in (10, 20):
        pre["ssl"][length] = ssl_dir(h, l, c, length)
    for amp in (1, 2, 3):
        pre["ht"][amp] = halftrend_dir(h, l, c, amp)
    print("precompute done", flush=True)
    return pre


def main():
    sys.stdout.reconfigure(line_buffering=True)
    dt, do, dh, dl, dc, dsp = load_m1(DATA / "usdjpy_m1_dukascopy_2026nov_session.json")
    dvol = vol_series(dc)
    yt, yo, yh, yl, yc, _ = load_m1(DATA / "usdjpy_m1_yahoo_recent.json")
    ysp = yspread(yt)
    yvol = vol_series(yc)
    dpre = precompute(dt, dh, dl, dc, dvol)
    ypre = precompute(yt, yh, yl, yc, yvol)

    dsplit = int(len(dc) * 0.6)
    d0a, d1a = float(dt[200]), float(dt[dsplit])
    d0b, d1b = float(dt[dsplit]), float(dt[-1]) + 1
    split = int(len(yc) * 0.7)
    t0h, t1h = float(yt[split]), float(yt[-1]) + 1
    duka_days = len({datetime.fromtimestamp(float(t), timezone.utc).date() for t in dt})

    grid: list[Fam] = []
    for family in ("ut_bot", "wavetrend", "ssl", "halftrend", "qqe", "ut_ssl", "ut_wt"):
        for kz in ("london", "ln"):
            for hour_mode in ("kz", "mid"):
                for sl, tp in ((2.5, 5.0), (3.0, 6.0)):
                    for cooldown in (1, 3):
                        for require_vwap in (True, False):
                            for ut_key in (2.0, 3.0):
                                for ut_atr in (7, 10):
                                    if family not in ("ut_bot", "ut_ssl", "ut_wt") and (
                                        ut_key != 2.0 or ut_atr != 10
                                    ):
                                        continue
                                    p = Fam(
                                        family=family,
                                        kz=kz,
                                        hour_mode=hour_mode,
                                        sl_pips=sl,
                                        tp_pips=tp,
                                        cooldown=cooldown,
                                        require_vwap=require_vwap,
                                        ut_key=ut_key,
                                        ut_atr=ut_atr,
                                    )
                                    grid.append(p)

    seen = set()
    uniq = []
    for p in grid:
        k = tuple(asdict(p).items())
        if k in seen:
            continue
        seen.add(k)
        uniq.append(p)
    print("grid", len(uniq), flush=True)

    hits = []
    for i, p in enumerate(uniq):
        duka = summarize(run(dt, do, dh, dl, dc, dsp, dvol, p, dpre))
        if duka["trades"] < 30 or duka["net_pips"] <= 0 or (duka.get("profit_factor") or 0) < 1.1:
            continue
        da = summarize(run(dt, do, dh, dl, dc, dsp, dvol, p, dpre, d0a, d1a))
        db = summarize(run(dt, do, dh, dl, dc, dsp, dvol, p, dpre, d0b, d1b))
        if da["net_pips"] <= 0 or db["net_pips"] <= 0:
            continue
        yf = summarize(run(yt, yo, yh, yl, yc, ysp, yvol, p, ypre))
        yhld = summarize(run(yt, yo, yh, yl, yc, ysp, yvol, p, ypre, t0h, t1h))
        if yf["net_pips"] <= 0 or yhld["net_pips"] <= 0:
            continue
        tpd = duka["trades"] / max(1, duka_days)
        sc = (
            tpd * 10
            + duka["net_pips"]
            + min(da["net_pips"], db["net_pips"]) * 2
            + yf["net_pips"] * 0.4
            + yhld["net_pips"] * 0.4
            + (duka["profit_factor"] or 0) * 8
        )
        hits.append((sc, tpd, p, duka, da, db, yf, yhld))
        print(
            f"HIT {p.family} tpd={tpd:.2f} D{duka['net_pips']:+.1f}n{duka['trades']}PF{duka['profit_factor']} "
            f"A{da['net_pips']:+.1f} B{db['net_pips']:+.1f} yF{yf['net_pips']:+.1f} yH{yhld['net_pips']:+.1f} "
            f"{asdict(p)}",
            flush=True,
        )

    hits.sort(key=lambda x: x[0], reverse=True)
    print("HITS", len(hits), flush=True)
    for row in hits[:15]:
        sc, tpd, p, duka, da, db, yf, yhld = row
        print(
            f"TOP {sc:.1f} {p.family} tpd={tpd:.2f} D{duka['net_pips']:+.1f}n{duka['trades']} "
            f"A{da['net_pips']:+.1f} B{db['net_pips']:+.1f} yF{yf['net_pips']:+.1f} yH{yhld['net_pips']:+.1f}",
            flush=True,
        )

    # Always also report best per family on Duka alone for reference
    print("\nBEST DUKA-ONLY per family (informative)", flush=True)
    best_fam = {}
    for p in uniq:
        duka = summarize(run(dt, do, dh, dl, dc, dsp, dvol, p, dpre))
        if duka["trades"] < 20:
            continue
        cur = best_fam.get(p.family)
        if cur is None or duka["net_pips"] > cur[0]["net_pips"]:
            best_fam[p.family] = (duka, p)
    for fam, (duka, p) in sorted(best_fam.items(), key=lambda x: -x[1][0]["net_pips"]):
        print(f"  {fam}: D{duka['net_pips']:+.1f}n{duka['trades']}PF{duka.get('profit_factor')} {asdict(p)}", flush=True)

    report = {
        "name": "Famous TV Indicator Search",
        "hits": len(hits),
        "top": None,
        "best_duka_only": {k: {"stats": v[0], "params": asdict(v[1])} for k, v in best_fam.items()},
        "sources": [
            "UT Bot Alerts (HPotter/QuantNomad)",
            "WaveTrend (LazyBear)",
            "SSL Channel",
            "HalfTrend",
            "QQE Mod (simplified)",
            "Stacks: UT+SSL, UT+WaveTrend",
        ],
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    if hits:
        sc, tpd, p, duka, da, db, yf, yhld = hits[0]
        report["top"] = {
            "score": sc,
            "trades_per_day": tpd,
            "params": asdict(p),
            "dukascopy_full": duka,
            "dukascopy_first60": da,
            "dukascopy_last40": db,
            "yahoo_full": yf,
            "yahoo_holdout": yhld,
        }
        report["verdict"] = "famous_stack_confirmed"
    else:
        report["verdict"] = "no_famous_stack_passed_full_gates"
        report["note"] = "No famous-TV stack cleared Duka WF + Yahoo full/holdout. See best_duka_only."

    OUT.mkdir(exist_ok=True)
    (OUT / "famous_edge.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
