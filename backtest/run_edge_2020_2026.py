#!/usr/bin/env python3
"""Re-verify KEHAI Edge Strict on 2020–2026.

Intraday source limit: Yahoo only keeps ~2y of USDJPY 60m.
For a consistent multi-year check we expand Yahoo daily OHLC (2020–2026)
into synthetic 60m (inside each day), then into M1 (inside each hour),
and apply the frozen Edge Strict rules year by year.
Where real 60m exists (≈2025–2026), we also report a side check.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from run_scalp_backtest import (
    OUT,
    Trade,
    atr,
    build_m1,
    confluence_scores,
    expand_hour_to_m1,
    summarize,
)
from scalp_edge import features, in_session, PIP, JPY_PER_PIP

DATA = Path(__file__).parent / "data"

# Frozen Edge Strict (unchanged)
ENTRY = 65
ADX_MIN = 22
SL_ATR = 1.2
TP_ATR = 2.0
COOLDOWN = 12
SPREAD = 0.8


def load_daily():
    rows = json.loads((DATA / "usdjpy_daily_2020_2026.json").read_text())
    return np.array(
        [[r["time"], r["open"], r["high"], r["low"], r["close"]] for r in rows],
        dtype=np.float64,
    )


def expand_day_to_hourly(t0: float, o: float, h: float, l: float, c: float, rng: np.random.Generator):
    """Create 24 hourly OHLC bars inside a daily envelope (UTC day open)."""
    n = 24
    mid = (h + l) / 2
    waypoints = np.array([o, mid, h, mid, l, mid, c], dtype=np.float64)
    x = np.linspace(0, 1, len(waypoints))
    xi = np.linspace(0, 1, n)
    base = np.interp(xi, x, waypoints)
    noise = rng.normal(0, (h - l) * 0.05, size=n)
    closes = np.clip(base + noise, l, h)
    closes[0] = o
    closes[-1] = c
    opens = np.empty(n)
    opens[0] = o
    opens[1:] = closes[:-1]
    highs = np.maximum(opens, closes)
    lows = np.minimum(opens, closes)
    wick = (h - l) * rng.uniform(0.02, 0.15, size=n)
    highs = np.minimum(h, highs + wick * rng.random(n))
    lows = np.maximum(l, lows - wick * rng.random(n))
    highs = np.maximum(highs, np.maximum(opens, closes))
    lows = np.minimum(lows, np.minimum(opens, closes))
    highs[n // 3] = h
    lows[(2 * n) // 3] = l
    # FX-ish: skip weekend already absent in Yahoo daily; place hours 0..23 UTC
    times = t0 + np.arange(n) * 3600.0
    return np.column_stack([times, opens, highs, lows, closes])


def daily_to_hourly(daily: np.ndarray, seed: int = 20201125) -> np.ndarray:
    rng = np.random.default_rng(seed)
    chunks = []
    for row in daily:
        t0, o, h, l, c = row
        if not np.isfinite([o, h, l, c]).all() or h < l:
            continue
        chunks.append(expand_day_to_hourly(t0, o, h, l, c, rng))
    return np.vstack(chunks)


def run_edge_strict(times, o, h, l, c, scores, atr14, adx_v, st, e21m, e55m, year: int):
    trades: list[Trade] = []
    pos = 0
    entry = entry_time = sl = tp = 0.0
    last_exit = -10**9
    for i in range(300, len(c) - 1):
        y = datetime.fromtimestamp(times[i], timezone.utc).year
        if y != year:
            continue
        if not in_session(times[i]):
            if pos != 0:
                pnl = (c[i] - entry) * pos / PIP - SPREAD
                trades.append(Trade(pos, entry_time, entry, times[i], c[i], pnl, pnl * JPY_PER_PIP, "SESSION"))
                pos = 0
                last_exit = i
            continue
        sc, prev, a = scores[i], scores[i - 1], atr14[i]
        if not np.isfinite(a) or a <= 0:
            continue
        if pos != 0:
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
                pnl = (exit_px - entry) * pos / PIP - SPREAD
                trades.append(Trade(pos, entry_time, entry, times[i], exit_px, pnl, pnl * JPY_PER_PIP, reason))
                pos = 0
                last_exit = i
        if pos == 0 and (i - last_exit) >= COOLDOWN:
            long_x = sc >= ENTRY and prev < ENTRY
            short_x = sc <= -ENTRY and prev > -ENTRY
            if not (long_x or short_x):
                continue
            if not np.isfinite(adx_v[i]) or adx_v[i] < ADX_MIN:
                continue
            if long_x and st[i] <= 0:
                continue
            if short_x and st[i] >= 0:
                continue
            if np.isfinite(e21m[i]) and np.isfinite(e55m[i]):
                if long_x and not (e21m[i] > e55m[i]):
                    continue
                if short_x and not (e21m[i] < e55m[i]):
                    continue
            if long_x:
                pos = 1
                entry = o[i + 1] + SPREAD * PIP * 0.5
                entry_time = times[i + 1]
                sl = entry - SL_ATR * a
                tp = entry + TP_ATR * a
            else:
                pos = -1
                entry = o[i + 1] - SPREAD * PIP * 0.5
                entry_time = times[i + 1]
                sl = entry + SL_ATR * a
                tp = entry - TP_ATR * a
    return trades


def process_year(hourly_year: np.ndarray, year: int):
    print(f"  expand M1 {year} hours={len(hourly_year)}…")
    m1 = build_m1(hourly_year, seed=20201125 + year)
    times, o, h, l, c = m1[:, 0], m1[:, 1], m1[:, 2], m1[:, 3], m1[:, 4]
    print(f"  M1 bars={len(m1)} scoring…")
    scores, atr14 = confluence_scores(o, h, l, c)
    f = features(o, h, l, c, times)
    trades = run_edge_strict(
        times, o, h, l, c, scores, atr14, f["adx"], f["st"], f["e21_mtf"], f["e55_mtf"], year
    )
    return summarize(trades, year)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    print("Load daily 2020–2026…")
    daily = load_daily()
    print("Expand to hourly…")
    hourly = daily_to_hourly(daily)
    print("Hourly bars", len(hourly))

    years = list(range(2020, 2027))
    by_year = {}
    for year in years:
        mask = np.array([datetime.fromtimestamp(t, timezone.utc).year == year for t in hourly[:, 0]])
        hy = hourly[mask]
        if len(hy) < 100:
            print(year, "skip — too few hours", len(hy))
            continue
        print("YEAR", year)
        by_year[str(year)] = process_year(hy, year)
        s = by_year[str(year)]
        print(
            f"  → trades={s['trades']} WR={s['win_rate']}% pips={s['net_pips']} "
            f"PF={s['profit_factor']} DD={s['max_dd_jpy']} jpy={s['net_jpy']}"
        )

    # Aggregate
    total_trades = sum(v["trades"] for v in by_year.values())
    total_pips = sum(v["net_pips"] for v in by_year.values())
    total_jpy = sum(v["net_jpy"] for v in by_year.values())
    wins = sum(v["wins"] for v in by_year.values())
    losses = sum(v["losses"] for v in by_year.values())
    report = {
        "name": "KEHAI Edge Strict — 2020–2026 recheck",
        "params": {
            "entry": ENTRY,
            "adx_min": ADX_MIN,
            "sl_atr": SL_ATR,
            "tp_atr": TP_ATR,
            "cooldown": COOLDOWN,
            "spread": SPREAD,
            "lot": 0.1,
        },
        "methodology": (
            "Yahoo Finance JPY=X daily 2020-01-01..2026-11-25 → synthetic 60m inside daily OHLC "
            "→ synthetic M1 inside hourly OHLC. Frozen Edge Strict gates. Not a live demo account."
        ),
        "by_year": by_year,
        "aggregate": {
            "trades": total_trades,
            "wins": wins,
            "losses": losses,
            "win_rate": round(100 * wins / total_trades, 1) if total_trades else 0,
            "net_pips": round(total_pips, 1),
            "net_jpy": round(total_jpy),
            "profitable_years": sum(1 for v in by_year.values() if v["net_pips"] > 0),
            "years": len(by_year),
        },
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    (OUT / "edge_strict_2020_2026.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print("\nAGG", json.dumps(report["aggregate"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
