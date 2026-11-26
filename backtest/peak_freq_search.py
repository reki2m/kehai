#!/usr/bin/env python3
"""
Search Peak-family stacks for ~10 trades/day with positive EV.

Window: JST 12:00–00:00 (UTC 03–15) normal; off-window needs higher score.
Risk: ATR-hybrid SL/TP matching SIMPLE (sl=clamp(6..10, ATR×1.1), tp=clamp(9..14, SL×1.45)).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from pathlib import Path

import numpy as np

from famous_indicators import ssl_dir, supertrend_dir, ut_bot_dir, wavetrend
from run_real_m1_edge import load_m1, news_blackout
from run_scalp_backtest import OUT, atr, ema, rsi, summarize
from scalp_edge import JPY_PER_PIP, PIP

DATA = Path(__file__).parent / "data"
JST = timezone(timedelta(hours=9))
BROKER_SPREAD = 0.2


@dataclass
class Cfg:
    name: str
    adx_noon: float
    adx_off: float
    min_score_noon: int
    min_score_off: int
    cooldown: int
    require_ssl: bool = True
    require_htf: bool = False
    require_st: bool = False
    require_di: bool = False
    require_wt: bool = False
    require_rsi: bool = False
    # soft score weights (UT flip always base)
    w_ssl: int = 1
    w_htf: int = 1
    w_st: int = 1
    w_di: int = 1
    w_wt: int = 1
    w_rsi: int = 1
    w_adx25: int = 1
    min_atr: float = 1.0
    rsi_long: tuple[float, float] = (35, 70)
    rsi_short: tuple[float, float] = (30, 65)


def jst_hm(ts: float) -> tuple[int, int]:
    dt = datetime.fromtimestamp(ts, JST)
    return dt.weekday(), dt.hour * 60 + dt.minute


def is_noon(ts: float) -> bool:
    # JST 12:00–00:00 == UTC 03:00–15:00
    dt = datetime.fromtimestamp(ts, timezone.utc)
    mins = dt.hour * 60 + dt.minute
    return 3 * 60 <= mins < 15 * 60


def atr_risk(atr_pips: float) -> tuple[float, float]:
    if atr_pips <= 0:
        return 7.0, 10.0
    sl = round(max(6.0, min(10.0, atr_pips * 1.1)) * 10) / 10
    tp = round(max(9.0, min(14.0, sl * 1.45)) * 10) / 10
    return sl, tp


def adx_di(h, l, c, period=14):
    n = len(c)
    tr = np.zeros(n)
    plus_dm = np.zeros(n)
    minus_dm = np.zeros(n)
    for i in range(1, n):
        up = h[i] - h[i - 1]
        dn = l[i - 1] - l[i]
        tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
        plus_dm[i] = up if up > dn and up > 0 else 0.0
        minus_dm[i] = dn if dn > up and dn > 0 else 0.0
    atr_s = np.full(n, np.nan)
    p_s = np.full(n, np.nan)
    m_s = np.full(n, np.nan)
    atr_s[period] = np.mean(tr[1 : period + 1])
    p_s[period] = np.mean(plus_dm[1 : period + 1])
    m_s[period] = np.mean(minus_dm[1 : period + 1])
    for i in range(period + 1, n):
        atr_s[i] = (atr_s[i - 1] * (period - 1) + tr[i]) / period
        p_s[i] = (p_s[i - 1] * (period - 1) + plus_dm[i]) / period
        m_s[i] = (m_s[i - 1] * (period - 1) + minus_dm[i]) / period
    plus_di = np.where(atr_s > 0, 100 * p_s / atr_s, np.nan)
    minus_di = np.where(atr_s > 0, 100 * m_s / atr_s, np.nan)
    dx = np.where(
        (plus_di + minus_di) > 0,
        100 * np.abs(plus_di - minus_di) / (plus_di + minus_di),
        np.nan,
    )
    adx = np.full(n, np.nan)
    if period * 2 < n:
        adx[period * 2] = np.nanmean(dx[period : period * 2 + 1])
        for i in range(period * 2 + 1, n):
            if np.isfinite(adx[i - 1]) and np.isfinite(dx[i]):
                adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period
    return adx, plus_di, minus_di


def preload(times, h, l, c):
    ut, _ = ut_bot_dir(h, l, c, key=2.0, atr_period=7)
    ssl = ssl_dir(h, l, c, 10)
    htf = ssl_dir(h, l, c, 50)
    st, _st_line = supertrend_dir(h, l, c, 10, 3.0)
    wt1, wt2 = wavetrend(h, l, c, 10, 21)
    adx_v, pdi, mdi = adx_di(h, l, c, 14)
    atr_v = atr(h, l, c, 14)
    rsi_v = rsi(c, 14)
    flip_long = np.zeros(len(c), dtype=bool)
    flip_short = np.zeros(len(c), dtype=bool)
    for i in range(1, len(c)):
        if ut[i] > 0 and ut[i - 1] <= 0:
            flip_long[i] = True
        elif ut[i] < 0 and ut[i - 1] >= 0:
            flip_short[i] = True
    return {
        "ut": ut,
        "ssl": ssl,
        "htf": htf,
        "st": st,
        "wt1": wt1,
        "wt2": wt2,
        "adx": adx_v,
        "pdi": pdi,
        "mdi": mdi,
        "atr": atr_v,
        "rsi": rsi_v,
        "flip_long": flip_long,
        "flip_short": flip_short,
    }


def score_side(pre, i, long: bool, cfg: Cfg) -> tuple[int, bool]:
    """Return (score, hard_ok)."""
    ssl_ok = (pre["ssl"][i] > 0) if long else (pre["ssl"][i] < 0)
    htf_ok = (pre["htf"][i] > 0) if long else (pre["htf"][i] < 0)
    st_ok = (pre["st"][i] > 0) if long else (pre["st"][i] < 0)
    di_ok = (
        pre["pdi"][i] > pre["mdi"][i] if long else pre["mdi"][i] > pre["pdi"][i]
    )
    wt_ok = (
        pre["wt1"][i] > pre["wt2"][i] if long else pre["wt1"][i] < pre["wt2"][i]
    )
    rv = pre["rsi"][i]
    if long:
        rsi_ok = cfg.rsi_long[0] <= rv <= cfg.rsi_long[1]
    else:
        rsi_ok = cfg.rsi_short[0] <= rv <= cfg.rsi_short[1]
    adx25 = np.isfinite(pre["adx"][i]) and pre["adx"][i] >= 25

    if cfg.require_ssl and not ssl_ok:
        return 0, False
    if cfg.require_htf and not htf_ok:
        return 0, False
    if cfg.require_st and not st_ok:
        return 0, False
    if cfg.require_di and not di_ok:
        return 0, False
    if cfg.require_wt and not wt_ok:
        return 0, False
    if cfg.require_rsi and not rsi_ok:
        return 0, False

    score = 1  # UT flip
    if ssl_ok:
        score += cfg.w_ssl
    if htf_ok:
        score += cfg.w_htf
    if st_ok:
        score += cfg.w_st
    if di_ok:
        score += cfg.w_di
    if wt_ok:
        score += cfg.w_wt
    if rsi_ok:
        score += cfg.w_rsi
    if adx25:
        score += cfg.w_adx25
    return score, True


def run_cfg(times, o, h, l, c, spread, pre, cfg: Cfg, slip=0.0):
    n = len(c)
    trades = []
    pos = 0
    entry = et = stop = tp = 0.0
    ei = last_sig = -(10**9)
    news_ok = np.array([not news_blackout(float(t)) for t in times])

    for i in range(120, n - 1):
        sp = float(min(spread[i], BROKER_SPREAD)) if spread is not None else BROKER_SPREAD
        # use broker display spread for costing
        sp = BROKER_SPREAD
        if pos != 0:
            hit_sl = l[i] <= stop if pos > 0 else h[i] >= stop
            hit_tp = h[i] >= tp if pos > 0 else l[i] <= tp
            timed = (i - ei) >= 45
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
                    {
                        "side": pos,
                        "entry_t": et,
                        "exit_t": times[i],
                        "pnl": pnl,
                        "reason": reason,
                    }
                )
                pos = 0
            continue

        wd, _ = jst_hm(float(times[i]))
        if wd >= 5:
            continue
        if not news_ok[i]:
            continue
        if i - last_sig < cfg.cooldown:
            continue

        atr_pips = float(pre["atr"][i] / PIP) if np.isfinite(pre["atr"][i]) else 0.0
        if atr_pips > 0 and atr_pips < cfg.min_atr:
            continue

        noon = is_noon(float(times[i]))
        adx_floor = cfg.adx_noon if noon else cfg.adx_off
        if not (np.isfinite(pre["adx"][i]) and pre["adx"][i] >= adx_floor):
            continue

        want_long = pre["flip_long"][i]
        want_short = pre["flip_short"][i]
        if not want_long and not want_short:
            continue

        min_score = cfg.min_score_noon if noon else cfg.min_score_off
        side = 0
        best = -1
        if want_long:
            sc, ok = score_side(pre, i, True, cfg)
            if ok and sc >= min_score and sc > best:
                best = sc
                side = 1
        if want_short:
            sc, ok = score_side(pre, i, False, cfg)
            if ok and sc >= min_score and sc > best:
                best = sc
                side = -1
        if side == 0:
            continue

        sl, tp_p = atr_risk(atr_pips)
        if side > 0:
            entry = float(o[i + 1]) + sp * PIP * 0.5 + slip * PIP
            stop = entry - sl * PIP
            tp = entry + tp_p * PIP
        else:
            entry = float(o[i + 1]) - sp * PIP * 0.5 - slip * PIP
            stop = entry + sl * PIP
            tp = entry - tp_p * PIP
        et = times[i + 1]
        ei = i + 1
        pos = side
        last_sig = i

    return trades


def stats(trades, times):
    if not trades:
        return {
            "n": 0,
            "wr": 0.0,
            "ev": 0.0,
            "net": 0.0,
            "tpd": 0.0,
            "days": 0,
        }
    pnls = np.array([t["pnl"] for t in trades])
    wins = float(np.mean(pnls > 0))
    # trading days in sample
    days = set()
    for t in times:
        wd, _ = jst_hm(float(t))
        if wd < 5:
            days.add(datetime.fromtimestamp(t, JST).date())
    ndays = max(1, len(days))
    return {
        "n": int(len(trades)),
        "wr": round(float(wins) * 100, 1),
        "ev": round(float(np.mean(pnls)), 3),
        "net": round(float(np.sum(pnls)), 1),
        "tpd": round(len(trades) / ndays, 2),
        "days": ndays,
    }


def load_months(months: list[str]):
    chunks = []
    for m in months:
        p = DATA / f"usdjpy_m1_dukascopy_{m}.json"
        if not p.exists():
            print("missing", p)
            continue
        chunks.append(load_m1(p))
    # merge
    t = np.concatenate([c[0] for c in chunks])
    o = np.concatenate([c[1] for c in chunks])
    h = np.concatenate([c[2] for c in chunks])
    l = np.concatenate([c[3] for c in chunks])
    c = np.concatenate([c[4] for c in chunks])
    sp = np.concatenate([c[5] for c in chunks])
    order = np.argsort(t)
    # dedupe times
    t, o, h, l, c, sp = t[order], o[order], h[order], l[order], c[order], sp[order]
    keep = np.ones(len(t), dtype=bool)
    keep[1:] = t[1:] != t[:-1]
    return t[keep], o[keep], h[keep], l[keep], c[keep], sp[keep]


def cfgs() -> list[Cfg]:
    out: list[Cfg] = []
    # Peak baseline (all hard)
    out.append(
        Cfg(
            "peak_all_hard",
            18,
            22,
            7,
            7,
            1,
            require_ssl=True,
            require_htf=True,
            require_st=True,
            require_di=True,
            require_wt=True,
            require_rsi=True,
        )
    )
    # Soft score variants aimed at ~10/day
    for noon_sc, off_sc, cool in [
        (4, 5, 8),
        (4, 5, 12),
        (4, 6, 10),
        (5, 6, 8),
        (5, 6, 12),
        (5, 7, 10),
        (3, 5, 15),
        (4, 5, 15),
        (4, 6, 15),
        (5, 6, 6),
        (3, 4, 20),
        (4, 5, 5),
    ]:
        for hard in [
            dict(require_ssl=True, require_di=True),
            dict(require_ssl=True, require_st=True),
            dict(require_ssl=True, require_htf=True),
            dict(require_ssl=True, require_wt=True),
            dict(require_ssl=True, require_di=True, require_st=True),
            dict(require_ssl=True, require_di=True, require_htf=True),
            dict(require_ssl=True, require_st=True, require_htf=True),
            dict(require_ssl=True, require_di=True, require_rsi=True),
        ]:
            name = f"sc{noon_sc}/{off_sc}_cd{cool}_" + "".join(
                k.replace("require_", "")[0].upper()
                for k, v in hard.items()
                if v
            )
            out.append(
                Cfg(
                    name,
                    16 if noon_sc <= 4 else 18,
                    20 if off_sc <= 5 else 22,
                    noon_sc,
                    off_sc,
                    cool,
                    **hard,
                )
            )
    # Wider RSI + lower ADX for frequency
    for noon_sc, cool in [(4, 10), (4, 12), (5, 10)]:
        out.append(
            Cfg(
                f"wide_rsi_sc{noon_sc}_cd{cool}",
                15,
                20,
                noon_sc,
                noon_sc + 1,
                cool,
                require_ssl=True,
                require_di=True,
                require_st=True,
                rsi_long=(32, 72),
                rsi_short=(28, 68),
                min_atr=0.9,
            )
        )
    return out


def main():
    times, o, h, l, c, sp = load_months(["2026aug", "2026sep", "2026oct"])
    print("bars", len(times))
    pre = preload(times, h, l, c)
    rows = []
    for cfg in cfgs():
        tr = run_cfg(times, o, h, l, c, sp, pre, cfg, slip=0.0)
        st = stats(tr, times)
        st3 = stats(run_cfg(times, o, h, l, c, sp, pre, cfg, slip=0.3), times)
        row = {
            "name": cfg.name,
            "adx": [cfg.adx_noon, cfg.adx_off],
            "score": [cfg.min_score_noon, cfg.min_score_off],
            "cooldown": cfg.cooldown,
            "hard": {
                "ssl": cfg.require_ssl,
                "htf": cfg.require_htf,
                "st": cfg.require_st,
                "di": cfg.require_di,
                "wt": cfg.require_wt,
                "rsi": cfg.require_rsi,
            },
            **st,
            "ev_slip03": st3["ev"],
            "wr_slip03": st3["wr"],
            "net_slip03": st3["net"],
        }
        rows.append(row)
        print(
            f"{cfg.name:40s} tpd={st['tpd']:5.2f} n={st['n']:4d} "
            f"wr={st['wr']:5.1f}% ev={st['ev']:+6.3f} net={st['net']:+7.1f} "
            f"ev@.3={st3['ev']:+6.3f}"
        )

    # Prefer ~8–12 tpd, then best EV with slip, then WR
    def rank_key(r):
        tpd = r["tpd"]
        band = 0 if 8 <= tpd <= 12 else (abs(tpd - 10) + 5)
        return (band, -r["ev_slip03"], -r["wr_slip03"], -r["ev"])

    rows.sort(key=rank_key)
    best = [r for r in rows if 7.5 <= r["tpd"] <= 12.5 and r["ev"] > 0]
    best_slip = [r for r in rows if 7.5 <= r["tpd"] <= 12.5 and r["ev_slip03"] > 0]
    report = {
        "target": "~10 trades/day, EV>0 (ATR-hybrid, spread 0.2)",
        "sample": "Dukascopy M1 Aug–Oct 2026",
        "best_in_band_ev": best[:8],
        "best_in_band_ev_slip03": best_slip[:8],
        "top20": rows[:20],
        "baseline_peak": next((r for r in rows if r["name"] == "peak_all_hard"), None),
    }
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "peak_freq_search.json"
    path.write_text(json.dumps(report, indent=2))
    print("\nWROTE", path)
    print("BEST band EV>0:")
    for r in best[:5]:
        print(" ", r["name"], r)
    print("BEST band EV@.3>0:")
    for r in best_slip[:5]:
        print(" ", r["name"], r)


if __name__ == "__main__":
    main()
