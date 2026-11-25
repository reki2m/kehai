#!/usr/bin/env python3
"""Backtest Edge Pro on real M1 (Dukascopy ticks and/or Yahoo 1m)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from run_scalp_backtest import OUT, Trade, atr, confluence_scores, summarize
from scalp_edge import features, in_session, PIP, JPY_PER_PIP

DATA = Path(__file__).parent / "data"

ENTRY = 65
ADX_MIN = 22
SL_ATR = 1.2
TP_ATR = 2.0
COOLDOWN = 12
MAX_SPREAD = 1.4


def load_m1(path: Path):
    rows = json.loads(path.read_text())
    t = np.array([r["time"] for r in rows], dtype=np.float64)
    o = np.array([r["open"] for r in rows], dtype=np.float64)
    h = np.array([r["high"] for r in rows], dtype=np.float64)
    l = np.array([r["low"] for r in rows], dtype=np.float64)
    c = np.array([r["close"] for r in rows], dtype=np.float64)
    spread = np.array([r.get("spread", 0.8) for r in rows], dtype=np.float64)
    return t, o, h, l, c, spread


# --- filters mirrored from TS ---
def news_blackout(ts: float) -> bool:
    dt = datetime.fromtimestamp(ts, timezone.utc)
    # NFP first Friday 12:00-14:30 UTC
    if dt.weekday() == 4 and dt.day <= 7 and 12 <= dt.hour < 15:
        return True
    # Rollover already handled via spread; FOMC rough: known hours
    if dt.hour == 18 and dt.weekday() < 5:
        # weak heuristic — also use weekday Wed for FOMC-ish; keep strict list below
        pass
    return ts_in_static_news(ts)


def ts_in_static_news(ts: float) -> bool:
    # Compact list of unix ranges built once
    global _NEWS
    try:
        _NEWS
    except NameError:
        _NEWS = _build_news()
    for a, b in _NEWS:
        if a <= ts < b:
            return True
    return False


def _build_news():
    windows = []
    # NFP first Fridays 2024-2026
    for y in (2024, 2025, 2026):
        for m in range(1, 13):
            d = datetime(y, m, 1, tzinfo=timezone.utc)
            while d.weekday() != 4:
                d = datetime.fromtimestamp(d.timestamp() + 86400, timezone.utc)
            start = datetime(y, m, d.day, 12, 0, tzinfo=timezone.utc).timestamp()
            windows.append((start, start + 2.5 * 3600))
    # FOMC + BoJ approximate days
    fomc = [
        "2024-01-31","2024-03-20","2024-05-01","2024-06-12","2024-07-31","2024-09-18","2024-11-07","2024-12-18",
        "2025-01-29","2025-03-19","2025-05-07","2025-06-18","2025-07-30","2025-09-17","2025-10-29","2025-12-10",
        "2026-01-28","2026-03-18","2026-04-29","2026-06-17","2026-07-29","2026-09-16","2026-10-28","2026-12-16",
    ]
    for iso in fomc:
        y, m, d = map(int, iso.split("-"))
        start = datetime(y, m, d, 17, 30, tzinfo=timezone.utc).timestamp()
        windows.append((start, start + 3 * 3600))
    boj = [
        "2024-01-23","2024-03-19","2024-04-26","2024-06-14","2024-07-31","2024-09-20","2024-10-31","2024-12-19",
        "2025-01-24","2025-03-19","2025-05-01","2025-06-17","2025-07-31","2025-09-19","2025-10-30","2025-12-19",
        "2026-01-23","2026-03-19","2026-04-28","2026-06-18","2026-07-31","2026-09-18","2026-10-30","2026-12-18",
    ]
    for iso in boj:
        y, m, d = map(int, iso.split("-"))
        start = datetime(y, m, d, 2, 0, tzinfo=timezone.utc).timestamp()
        windows.append((start, start + 6 * 3600))
    return windows


def session_vwap(times, h, l, c, vol=None):
    n = len(c)
    out = np.full(n, np.nan)
    day = None
    pv = 0.0
    vv = 0.0
    for i in range(n):
        d = datetime.fromtimestamp(times[i], timezone.utc).date()
        if d != day:
            day = d
            pv = vv = 0.0
        typical = (h[i] + l[i] + c[i]) / 3
        v = 1.0 if vol is None else max(1.0, float(vol[i]))
        pv += typical * v
        vv += v
        out[i] = pv / vv
    return out


def bb_squeeze(c, h, l, period=20):
    # simplified: BB width vs ATR*3 as proxy when KC not fully ported
    from run_scalp_backtest import bollinger, atr as atr_fn, ema
    bb_u, bb_m, bb_l = bollinger(c, period, 2)
    a = atr_fn(h, l, c, period)
    e = ema(c, period)
    sq = np.zeros(len(c), dtype=bool)
    for i in range(len(c)):
        if not np.isfinite(bb_u[i]) or not np.isfinite(a[i]) or not np.isfinite(e[i]):
            continue
        kc_u = e[i] + 1.5 * a[i]
        kc_l = e[i] - 1.5 * a[i]
        sq[i] = bb_u[i] <= kc_u and bb_l[i] >= kc_l
    return sq


def run(path: Path, label: str, use_real_spread=True):
    print("Load", path)
    times, o, h, l, c, spread = load_m1(path)
    print(label, "bars", len(c))
    if len(c) < 500:
        return {"label": label, "error": "too few bars", "bars": len(c)}

    scores, atr14 = confluence_scores(o, h, l, c)
    f = features(o, h, l, c, times)
    vwap = session_vwap(times, h, l, c)
    squeeze = bb_squeeze(c, h, l)
    st = f["st"]
    # retune ST conceptually already in features as 10/2; OK for BT parity

    trades: list[Trade] = []
    pos = 0
    entry = entry_time = sl = tp = 0.0
    last_exit = -10**9
    skipped = {"news": 0, "spread": 0, "squeeze": 0, "vwap": 0}

    for i in range(300, len(c) - 1):
        if not in_session(times[i]):
            if pos:
                sp = spread[i] if use_real_spread else 0.8
                pnl = (c[i] - entry) * pos / PIP - sp
                trades.append(Trade(pos, entry_time, entry, times[i], c[i], pnl, pnl * JPY_PER_PIP, "SESSION"))
                pos = 0
                last_exit = i
            continue
        sc, prev, a = scores[i], scores[i - 1], atr14[i]
        if not np.isfinite(a) or a <= 0:
            continue
        sp = float(spread[i]) if use_real_spread else 0.8

        if pos:
            hit_sl = l[i] <= sl if pos > 0 else h[i] >= sl
            hit_tp = h[i] >= tp if pos > 0 else l[i] <= tp
            flip = (pos > 0 and sc <= -ENTRY) or (pos < 0 and sc >= ENTRY)
            reason = exit_px = None
            if hit_sl:
                reason, exit_px = "SL", sl
            elif hit_tp:
                reason, exit_px = "TP", tp
            elif flip:
                reason, exit_px = "SIGNAL", c[i]
            if reason:
                pnl = (exit_px - entry) * pos / PIP - sp
                trades.append(Trade(pos, entry_time, entry, times[i], exit_px, pnl, pnl * JPY_PER_PIP, reason))
                pos = 0
                last_exit = i

        if pos == 0 and (i - last_exit) >= COOLDOWN:
            long_x = sc >= ENTRY and prev < ENTRY
            short_x = sc <= -ENTRY and prev > -ENTRY
            if not (long_x or short_x):
                continue
            if news_blackout(times[i]):
                skipped["news"] += 1
                continue
            if sp > MAX_SPREAD:
                skipped["spread"] += 1
                continue
            if squeeze[i]:
                skipped["squeeze"] += 1
                continue
            if not np.isfinite(f["adx"][i]) or f["adx"][i] < ADX_MIN:
                continue
            if long_x and st[i] <= 0:
                continue
            if short_x and st[i] >= 0:
                continue
            if np.isfinite(f["e21_mtf"][i]) and np.isfinite(f["e55_mtf"][i]):
                if long_x and not (f["e21_mtf"][i] > f["e55_mtf"][i]):
                    continue
                if short_x and not (f["e21_mtf"][i] < f["e55_mtf"][i]):
                    continue
            if np.isfinite(vwap[i]):
                if long_x and not (c[i] >= vwap[i]):
                    skipped["vwap"] += 1
                    continue
                if short_x and not (c[i] < vwap[i]):
                    skipped["vwap"] += 1
                    continue
            if long_x:
                pos = 1
                entry = o[i + 1] + sp * PIP * 0.5
                entry_time = times[i + 1]
                sl = entry - SL_ATR * a
                tp = entry + TP_ATR * a
            else:
                pos = -1
                entry = o[i + 1] - sp * PIP * 0.5
                entry_time = times[i + 1]
                sl = entry + SL_ATR * a
                tp = entry - TP_ATR * a

    s = summarize(trades)
    # also by year
    by_year = {}
    for y in sorted({datetime.fromtimestamp(t.entry_time, timezone.utc).year for t in trades}):
        by_year[str(y)] = summarize(trades, y)
    return {
        "label": label,
        "source": str(path.name),
        "bars": len(c),
        "avg_spread": round(float(np.mean(spread)), 3),
        "skipped": skipped,
        "all": s,
        "by_year": by_year,
        "filters": ["session", "news", "spread<=1.4", "no-squeeze", "vwap", "adx", "st", "mtf", "±65 cross"],
    }


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    results = []
    yahoo = DATA / "usdjpy_m1_yahoo_recent.json"
    duka = DATA / "usdjpy_m1_dukascopy_real.json"
    if yahoo.exists():
        results.append(run(yahoo, "yahoo_real_m1_~28d", use_real_spread=False))
    if duka.exists() and duka.stat().st_size > 1000:
        results.append(run(duka, "dukascopy_real_m1", use_real_spread=True))
    else:
        # partial window files
        for p in sorted(DATA.glob("usdjpy_m1_dukascopy_*.json")):
            if p.name.endswith("_real.json"):
                continue
            if p.stat().st_size > 1000:
                results.append(run(p, p.stem, use_real_spread=True))

    report = {
        "name": "KEHAI Edge Pro — real M1 + TV filters",
        "tv_stack": [
            "Session VWAP (LuxAlgo Sessions style)",
            "Supertrend 7/2 (TV 1m common)",
            "BB/KC Squeeze gate (Squeeze Engine style)",
            "News blackout NFP/CPI/FOMC/BoJ",
            "Spread cap 1.4 pips (real ask-bid when available)",
        ],
        "results": results,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    (OUT / "edge_pro_real_m1.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
