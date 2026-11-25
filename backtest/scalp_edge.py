#!/usr/bin/env python3
"""
KEHAI Edge — elite scalping confluence (walk-forward).

Train on 2025, freeze params, validate on 2026 holdout.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from run_scalp_backtest import (
    OUT,
    Trade,
    atr,
    bollinger,
    build_m1,
    ema,
    load_hourly,
    macd_hist,
    rsi,
    stochastic,
    summarize,
)

JST = timezone(timedelta(hours=9))
PIP = 0.01
JPY_PER_PIP = 1000


def adx(high, low, close, period=14):
    n = len(close)
    plus_dm = np.zeros(n)
    minus_dm = np.zeros(n)
    tr = np.zeros(n)
    for i in range(1, n):
        up = high[i] - high[i - 1]
        down = low[i - 1] - low[i]
        plus_dm[i] = up if up > down and up > 0 else 0.0
        minus_dm[i] = down if down > up and down > 0 else 0.0
        tr[i] = max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1]))

    def wilder(x):
        out = np.full_like(x, np.nan)
        out[period] = x[1 : period + 1].sum()
        for i in range(period + 1, len(x)):
            out[i] = out[i - 1] - out[i - 1] / period + x[i]
        return out

    atr_w = wilder(tr)
    pdi = np.where(atr_w > 0, 100 * wilder(plus_dm) / atr_w, np.nan)
    mdi = np.where(atr_w > 0, 100 * wilder(minus_dm) / atr_w, np.nan)
    dx = np.where((pdi + mdi) > 0, 100 * np.abs(pdi - mdi) / (pdi + mdi), np.nan)
    adx_out = np.full_like(close, np.nan)
    valid = np.where(np.isfinite(dx))[0]
    if len(valid) >= period:
        start = valid[period - 1]
        adx_out[start] = np.nanmean(dx[valid[:period]])
        prev = adx_out[start]
        for i in range(start + 1, n):
            if np.isfinite(dx[i]):
                prev = (prev * (period - 1) + dx[i]) / period
                adx_out[i] = prev
    return adx_out, pdi, mdi


def supertrend_dir(high, low, close, period=10, mult=2.0):
    a = atr(high, low, close, period)
    n = len(close)
    st = np.full(n, np.nan)
    direction = np.zeros(n)
    hl2 = (high + low) / 2
    upper = hl2 + mult * a
    lower = hl2 - mult * a
    for i in range(period, n):
        if not np.isfinite(a[i]):
            continue
        if i == period:
            st[i] = lower[i]
            direction[i] = 1
            continue
        prev_st, prev_dir = st[i - 1], direction[i - 1]
        cu, cl = upper[i], lower[i]
        if prev_dir >= 0:
            cl = max(cl, prev_st) if np.isfinite(prev_st) else cl
            if close[i] < cl:
                direction[i], st[i] = -1, cu
            else:
                direction[i], st[i] = 1, cl
        else:
            cu = min(cu, prev_st) if np.isfinite(prev_st) else cu
            if close[i] > cu:
                direction[i], st[i] = 1, cl
            else:
                direction[i], st[i] = -1, cu
    return direction


def features(o, h, l, c, times):
    """Precompute all indicator series once."""
    e8, e21, e55 = ema(c, 8), ema(c, 21), ema(c, 55)
    adx_v, pdi, mdi = adx(h, l, c, 14)
    rsi7 = rsi(c, 7)
    k, d = stochastic(h, l, c, 5, 3)
    _, _, hist = macd_hist(c)
    bb_u, bb_m, bb_l = bollinger(c, 20, 2)
    atr14 = atr(h, l, c, 14)
    st = supertrend_dir(h, l, c, 10, 2.0)

    # rolling 5m closes for MTF
    n = len(c)
    c5 = np.full(n, np.nan)
    for i in range(4, n):
        c5[i] = c[i]  # close of forming 5m window end
    # EMA on subsampled every 5 bars is noisy; use EMA of M1 closes as proxy MTF by slower EMAs
    e21_mtf = ema(c, 105)  # ~21 * 5
    e55_mtf = ema(c, 275)  # ~55 * 5

    body = np.abs(c - o)
    rng = np.maximum(h - l, 1e-9)
    body_ratio = body / rng

    return {
        "e8": e8,
        "e21": e21,
        "e55": e55,
        "adx": adx_v,
        "pdi": pdi,
        "mdi": mdi,
        "rsi7": rsi7,
        "k": k,
        "d": d,
        "hist": hist,
        "bb_u": bb_u,
        "bb_m": bb_m,
        "bb_l": bb_l,
        "atr14": atr14,
        "st": st,
        "e21_mtf": e21_mtf,
        "e55_mtf": e55_mtf,
        "body_ratio": body_ratio,
        "o": o,
        "c": c,
    }


def score_from_features(f, adx_min=18.0, mode="balanced"):
    """Vectorish scoring with a single Python loop (cached features)."""
    n = len(f["c"])
    score = np.zeros(n, dtype=np.int16)
    e8, e21, e55 = f["e8"], f["e21"], f["e55"]
    adx_v, pdi, mdi = f["adx"], f["pdi"], f["mdi"]
    rsi7, k, d = f["rsi7"], f["k"], f["d"]
    hist = f["hist"]
    bb_u, bb_m, bb_l = f["bb_u"], f["bb_m"], f["bb_l"]
    st = f["st"]
    e21m, e55m = f["e21_mtf"], f["e55_mtf"]
    br = f["body_ratio"]
    o, c = f["o"], f["c"]

    for i in range(n):
        if not np.isfinite(adx_v[i]) or adx_v[i] < adx_min:
            continue
        bull = bear = 0.0

        # EMA stack (heavy weight)
        if np.isfinite(e8[i]) and np.isfinite(e21[i]) and np.isfinite(e55[i]):
            if e8[i] > e21[i] > e55[i]:
                bull += 1.4
            elif e8[i] < e21[i] < e55[i]:
                bear += 1.4
            elif e8[i] > e21[i]:
                bull += 0.35
            else:
                bear += 0.35

        # Supertrend
        if st[i] > 0:
            bull += 1.1
        elif st[i] < 0:
            bear += 1.1

        # MTF
        if np.isfinite(e21m[i]) and np.isfinite(e55m[i]):
            if e21m[i] > e55m[i]:
                bull += 1.2
            else:
                bear += 1.2

        # DI
        if np.isfinite(pdi[i]) and np.isfinite(mdi[i]):
            if pdi[i] > mdi[i]:
                bull += 0.7
            else:
                bear += 0.7

        # RSI7
        if np.isfinite(rsi7[i]):
            r = rsi7[i]
            if mode == "strict":
                if r <= 30:
                    bull += 0.9
                elif r >= 70:
                    bear += 0.9
            else:
                if r <= 28:
                    bull += 0.85
                elif r >= 72:
                    bear += 0.85
                elif r > 55:
                    bull += 0.3
                elif r < 45:
                    bear += 0.3

        # Stoch
        if np.isfinite(k[i]) and np.isfinite(d[i]):
            if k[i] < 20 and k[i] > d[i]:
                bull += 1.0
            elif k[i] > 80 and k[i] < d[i]:
                bear += 1.0
            elif k[i] > d[i]:
                bull += 0.25
            else:
                bear += 0.25

        # MACD
        if np.isfinite(hist[i]):
            if hist[i] > 0:
                bull += 0.6
            else:
                bear += 0.6

        # BB trend-follow
        if np.isfinite(bb_m[i]) and np.isfinite(bb_u[i]) and np.isfinite(bb_l[i]):
            width = (bb_u[i] - bb_l[i]) or 1.0
            pos = (c[i] - bb_l[i]) / width
            if c[i] > bb_m[i] and pos < 0.9:
                bull += 0.45
            elif c[i] < bb_m[i] and pos > 0.1:
                bear += 0.45

        # Impulse candle
        if br[i] > 0.6:
            if c[i] > o[i]:
                bull += 0.4
            else:
                bear += 0.4

        if mode == "strict":
            # require trend trio agreement or zero out soft scores
            trend_bull = (
                np.isfinite(e8[i])
                and e8[i] > e21[i] > e55[i]
                and st[i] > 0
                and np.isfinite(e21m[i])
                and e21m[i] > e55m[i]
            )
            trend_bear = (
                np.isfinite(e8[i])
                and e8[i] < e21[i] < e55[i]
                and st[i] < 0
                and np.isfinite(e21m[i])
                and e21m[i] < e55m[i]
            )
            if not (trend_bull or trend_bear):
                continue
            if trend_bull and bear > bull:
                continue
            if trend_bear and bull > bear:
                continue

        total = bull + bear
        if total > 0:
            score[i] = int(round(((bull - bear) / total) * 100))
    return score


def in_session(ts: float) -> bool:
    dt = datetime.fromtimestamp(ts, JST)
    if dt.weekday() >= 5:
        return False
    hm = dt.hour * 60 + dt.minute
    return (9 * 60 <= hm < 15 * 60) or (16 * 60 <= hm < 24 * 60)


@dataclass
class Params:
    adx_min: float = 18
    mode: str = "strict"
    entry_score: int = 60
    exit_fade: int = 0
    sl_atr: float = 1.0
    tp_atr: float = 1.8
    cooldown: int = 8
    spread: float = 0.8


def run_edge(times, o, h, l, c, scores, atr14, p: Params, year_filter: int | None = None):
    trades: list[Trade] = []
    pos = 0
    entry = entry_time = sl = tp = 0.0
    last_exit = -10**9
    for i in range(300, len(c) - 1):
        if year_filter is not None:
            y = datetime.fromtimestamp(times[i], timezone.utc).year
            if y != year_filter:
                continue
        if not in_session(times[i]):
            if pos != 0:
                pnl = (c[i] - entry) * pos / PIP - p.spread
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
            flip = (pos > 0 and sc <= -p.entry_score) or (pos < 0 and sc >= p.entry_score)
            fade = (pos > 0 and sc <= p.exit_fade) or (pos < 0 and sc >= -p.exit_fade)
            reason = exit_px = None
            if hit_sl:
                reason, exit_px = "SL", sl
            elif hit_tp:
                reason, exit_px = "TP", tp
            elif flip or fade:
                reason, exit_px = "SIGNAL", c[i]
            if reason:
                pnl = (exit_px - entry) * pos / PIP - p.spread
                trades.append(Trade(pos, entry_time, entry, times[i], exit_px, pnl, pnl * JPY_PER_PIP, reason))
                pos = 0
                last_exit = i
        if pos == 0 and (i - last_exit) >= p.cooldown:
            if sc >= p.entry_score and prev < p.entry_score:
                pos = 1
                entry = o[i + 1] + p.spread * PIP * 0.5
                entry_time = times[i + 1]
                sl = entry - p.sl_atr * a
                tp = entry + p.tp_atr * a
            elif sc <= -p.entry_score and prev > -p.entry_score:
                pos = -1
                entry = o[i + 1] - p.spread * PIP * 0.5
                entry_time = times[i + 1]
                sl = entry + p.sl_atr * a
                tp = entry - p.tp_atr * a
    return trades


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    print("M1…")
    m1 = build_m1(load_hourly())
    times, o, h, l, c = m1[:, 0], m1[:, 1], m1[:, 2], m1[:, 3], m1[:, 4]
    print("features…")
    f = features(o, h, l, c, times)
    atr14 = f["atr14"]

    score_cache = {}
    for adx_min in (16, 18, 22, 25):
        for mode in ("balanced", "strict"):
            print("score", adx_min, mode)
            score_cache[(adx_min, mode)] = score_from_features(f, adx_min=adx_min, mode=mode)

    candidates = []
    for (adx_min, mode), scores in score_cache.items():
        for entry in (55, 60, 65, 70):
            for sl_atr, tp_atr in ((0.9, 1.6), (1.0, 1.8), (1.1, 2.0), (1.2, 2.2)):
                for cooldown in (6, 8, 10, 12):
                    p = Params(
                        adx_min=adx_min,
                        mode=mode,
                        entry_score=entry,
                        sl_atr=sl_atr,
                        tp_atr=tp_atr,
                        cooldown=cooldown,
                        exit_fade=0 if mode == "strict" else 5,
                    )
                    trades = run_edge(times, o, h, l, c, scores, atr14, p, year_filter=2025)
                    s = summarize(trades, 2025)
                    if s["trades"] < 500 or not s["profit_factor"] or s["profit_factor"] < 1.2:
                        continue
                    # prefer holdout-ready: good PF, controlled DD, enough trades
                    obj = s["profit_factor"] * np.sqrt(s["trades"]) - s["max_dd_jpy"] / 400000
                    if s["net_pips"] <= 0:
                        continue
                    candidates.append((obj, p, s, scores))

    candidates.sort(key=lambda x: x[0], reverse=True)
    print("qualified", len(candidates))
    if not candidates:
        # fallback: pick best net pips even if PF soft
        print("Relaxing constraints…")
        for (adx_min, mode), scores in score_cache.items():
            for entry in (60, 65, 70):
                for sl_atr, tp_atr in ((1.0, 1.8), (1.2, 2.2)):
                    for cooldown in (8, 12):
                        p = Params(adx_min=adx_min, mode=mode, entry_score=entry, sl_atr=sl_atr, tp_atr=tp_atr, cooldown=cooldown)
                        trades = run_edge(times, o, h, l, c, scores, atr14, p, year_filter=2025)
                        s = summarize(trades, 2025)
                        if s["trades"] < 300:
                            continue
                        obj = (s["net_pips"]) - s["max_dd_jpy"] / 1000
                        candidates.append((obj, p, s, scores))
        candidates.sort(key=lambda x: x[0], reverse=True)

    top = candidates[:10]
    for i, (obj, p, s, _) in enumerate(top):
        print(i, f"obj={obj:.1f}", asdict(p), f"n={s['trades']} WR={s['win_rate']} pips={s['net_pips']} PF={s['profit_factor']} DD={s['max_dd_jpy']}")

    best_obj, best_p, s2025, best_scores = top[0]
    t2026 = run_edge(times, o, h, l, c, best_scores, atr14, best_p, year_filter=2026)
    s2026 = summarize(t2026, 2026)

    # Also evaluate previous B strategy style for comparison is already known

    report = {
        "name": "KEHAI Edge",
        "stack": [
            "EMA 8/21/55 stack",
            "Supertrend(10,2)",
            "MTF bias (EMA105/275 ≈ 5m 21/55)",
            "ADX(14) +DI/-DI regime",
            "RSI(7)",
            "Stochastic(5,3,3)",
            "MACD histogram",
            "Bollinger(20,2)",
            "Impulse candle body",
            "Tokyo 9-15 / London 16-24 JST",
        ],
        "params": asdict(best_p),
        "y2025_train": s2025,
        "y2026_holdout": s2026,
        "top": [{"objective": o, "params": asdict(p), "y2025": s} for o, p, s, _ in top[:5]],
        "disclaimer": "研究用デモBT。実口座成績ではない。1分足はYahoo 60m実データから再構成。",
    }
    (OUT / "edge_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print("\nHOLD OUT 2026", json.dumps(s2026, ensure_ascii=False, indent=2))
    print("TRAIN 2025", json.dumps(s2025, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
