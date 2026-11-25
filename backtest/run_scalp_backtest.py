#!/usr/bin/env python3
"""Demo backtest of KEHAI confluence signals on 1m scalping.

Price path: Yahoo Finance USDJPY (JPY=X) 60m OHLC for 2025–2026 YTD,
expanded to synthetic 1m bars that respect each hour's OHLC envelope.
This is a reproducible demo / research backtest — not a live broker demo account.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

DATA = Path(__file__).parent / "data"
OUT = Path(__file__).parent / "out"


def load_hourly() -> np.ndarray:
    rows = json.loads((DATA / "usdjpy_60m_2025_2026.json").read_text())
    arr = np.array(
        [[r["time"], r["open"], r["high"], r["low"], r["close"]] for r in rows],
        dtype=np.float64,
    )
    return arr


def expand_hour_to_m1(t0: float, o: float, h: float, l: float, c: float, rng: np.random.Generator) -> np.ndarray:
    """Create 60 one-minute OHLC bars inside an hourly envelope."""
    n = 60
    # Path of closes: start near open, visit high & low, end at close.
    mid = (h + l) / 2
    waypoints = np.array([o, mid, h, mid, l, mid, c], dtype=np.float64)
    # Smooth interpolate with noise
    x = np.linspace(0, 1, len(waypoints))
    xi = np.linspace(0, 1, n)
    base = np.interp(xi, x, waypoints)
    noise = rng.normal(0, (h - l) * 0.04, size=n)
    closes = np.clip(base + noise, l, h)
    closes[0] = o
    closes[-1] = c

    opens = np.empty(n)
    opens[0] = o
    opens[1:] = closes[:-1]
    highs = np.maximum(opens, closes)
    lows = np.minimum(opens, closes)
    # Sprinkle wicks inside hour range
    wick = (h - l) * rng.uniform(0.02, 0.12, size=n)
    highs = np.minimum(h, highs + wick * rng.random(n))
    lows = np.maximum(l, lows - wick * rng.random(n))
    highs = np.maximum(highs, np.maximum(opens, closes))
    lows = np.minimum(lows, np.minimum(opens, closes))
    # Ensure hour extremes are touched
    highs[n // 3] = h
    lows[(2 * n) // 3] = l

    times = t0 + np.arange(n) * 60.0
    return np.column_stack([times, opens, highs, lows, closes])


def build_m1(hourly: np.ndarray, seed: int = 20251125) -> np.ndarray:
    rng = np.random.default_rng(seed)
    chunks = []
    for row in hourly:
        t0, o, h, l, c = row
        if not np.isfinite([o, h, l, c]).all() or h < l:
            continue
        chunks.append(expand_hour_to_m1(t0, o, h, l, c, rng))
    return np.vstack(chunks)


def ema(series: np.ndarray, period: int) -> np.ndarray:
    out = np.full_like(series, np.nan)
    if len(series) < period:
        return out
    k = 2 / (period + 1)
    out[period - 1] = series[:period].mean()
    for i in range(period, len(series)):
        out[i] = series[i] * k + out[i - 1] * (1 - k)
    return out


def rsi(series: np.ndarray, period: int = 14) -> np.ndarray:
    out = np.full_like(series, np.nan)
    if len(series) <= period:
        return out
    delta = np.diff(series, prepend=series[0])
    gain = np.where(delta > 0, delta, 0.0)
    loss = np.where(delta < 0, -delta, 0.0)
    avg_g = gain[1 : period + 1].mean()
    avg_l = loss[1 : period + 1].mean()
    out[period] = 100 if avg_l == 0 else 100 - 100 / (1 + avg_g / avg_l)
    for i in range(period + 1, len(series)):
        avg_g = (avg_g * (period - 1) + gain[i]) / period
        avg_l = (avg_l * (period - 1) + loss[i]) / period
        out[i] = 100 if avg_l == 0 else 100 - 100 / (1 + avg_g / avg_l)
    return out


def macd_hist(series: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    ef = ema(series, 12)
    es = ema(series, 26)
    line = ef - es
    # signal on valid macd values
    signal = np.full_like(series, np.nan)
    hist = np.full_like(series, np.nan)
    valid_idx = np.where(np.isfinite(line))[0]
    if len(valid_idx) < 9:
        return line, signal, hist
    # EMA of macd line
    vals = line.copy()
    # start signal at first 9 valid
    start = valid_idx[8]
    window = vals[valid_idx[:9]]
    signal[start] = window.mean()
    k = 2 / (9 + 1)
    prev = signal[start]
    for i in range(start + 1, len(series)):
        if not np.isfinite(vals[i]):
            continue
        prev = vals[i] * k + prev * (1 - k)
        signal[i] = prev
        hist[i] = vals[i] - prev
    hist[start] = vals[start] - signal[start]
    return line, signal, hist


def bollinger(series: np.ndarray, period: int = 20, mult: float = 2.0):
    mid = np.full_like(series, np.nan)
    upper = np.full_like(series, np.nan)
    lower = np.full_like(series, np.nan)
    for i in range(period - 1, len(series)):
        w = series[i - period + 1 : i + 1]
        m = w.mean()
        sd = w.std(ddof=0)
        mid[i] = m
        upper[i] = m + mult * sd
        lower[i] = m - mult * sd
    return upper, mid, lower


def stochastic(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14, smooth: int = 3):
    raw = np.full_like(close, np.nan)
    for i in range(period - 1, len(close)):
        hh = high[i - period + 1 : i + 1].max()
        ll = low[i - period + 1 : i + 1].min()
        raw[i] = 0 if hh == ll else (close[i] - ll) / (hh - ll) * 100

    def sma(x, p):
        out = np.full_like(x, np.nan)
        for i in range(p - 1, len(x)):
            w = x[i - p + 1 : i + 1]
            if np.isfinite(w).all():
                out[i] = w.mean()
        return out

    k = sma(raw, smooth)
    d = sma(k, smooth)
    return k, d


def atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    out = np.full_like(close, np.nan)
    tr = np.empty_like(close)
    tr[0] = high[0] - low[0]
    for i in range(1, len(close)):
        tr[i] = max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1]))
    if len(close) <= period:
        return out
    out[period] = tr[1 : period + 1].mean()
    for i in range(period + 1, len(close)):
        out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
    return out


def confluence_scores(open_: np.ndarray, high: np.ndarray, low: np.ndarray, close: np.ndarray) -> np.ndarray:
    """Port of KEHAI evaluateConfluence → score per bar."""
    n = len(close)
    score = np.zeros(n)
    ema21 = ema(close, 21)
    ema55 = ema(close, 55)
    rsi14 = rsi(close, 14)
    _, _, hist = macd_hist(close)
    bb_u, bb_m, bb_l = bollinger(close, 20, 2)
    k, d = stochastic(high, low, close)
    atr14 = atr(high, low, close, 14)

    for i in range(n):
        bull = 0.0
        bear = 0.0
        price = close[i]
        if not np.isfinite(price) or price <= 0:
            continue

        if np.isfinite(ema21[i]) and np.isfinite(ema55[i]):
            strength = min(1.0, abs(ema21[i] - ema55[i]) / (price * 0.002))
            if ema21[i] > ema55[i]:
                bull += strength
            else:
                bear += strength

        if np.isfinite(rsi14[i]):
            r = rsi14[i]
            strength = min(1.0, abs(r - 50) / 30)
            if r >= 70:
                bear += strength
            elif r <= 30:
                bull += strength
            elif r > 55:
                bull += strength
            elif r < 45:
                bear += strength

        if np.isfinite(hist[i]):
            strength = min(1.0, abs(hist[i]) / (abs(hist[i]) + 1e-9) * 0.8 + 0.2)
            if hist[i] >= 0:
                bull += strength
            else:
                bear += strength

        if np.isfinite(bb_u[i]) and np.isfinite(bb_l[i]) and np.isfinite(bb_m[i]):
            width = (bb_u[i] - bb_l[i]) or 1.0
            pos = (price - bb_l[i]) / width
            strength = min(1.0, abs(pos - 0.5) * 2)
            if pos >= 0.85:
                bear += strength
            elif pos <= 0.15:
                bull += strength
            elif price > bb_m[i]:
                bull += strength
            else:
                bear += strength

        if np.isfinite(k[i]) and np.isfinite(d[i]):
            strength = min(1.0, abs(k[i] - 50) / 40)
            if k[i] < 20 and k[i] > d[i]:
                bull += strength
            elif k[i] > 80 and k[i] < d[i]:
                bear += strength
            elif k[i] > d[i]:
                bull += strength
            else:
                bear += strength

        total = bull + bear
        score[i] = 0 if total <= 0 else round(((bull - bear) / total) * 100)

    return score, atr14


@dataclass
class Trade:
    direction: int  # +1 long -1 short
    entry_time: float
    entry: float
    exit_time: float
    exit: float
    pnl_pips: float
    pnl_jpy: float
    reason: str


def run_backtest(
    times: np.ndarray,
    open_: np.ndarray,
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    scores: np.ndarray,
    atr14: np.ndarray,
    *,
    entry_th: float = 35,
    exit_th: float = 10,
    sl_atr: float = 1.2,
    tp_atr: float = 1.8,
    spread_pips: float = 0.8,
    lot: float = 0.1,
    warmup: int = 120,
) -> list[Trade]:
    """1m scalp: enter on confluence threshold, exit TP/SL or score fade."""
    pip = 0.01  # USDJPY
    # 0.1 lot USDJPY ≈ 1000 JPY per pip (standard: 1 lot = 10000 JPY/pip for JPY pairs)
    jpy_per_pip = 1000 * lot / 0.1
    trades: list[Trade] = []
    pos = 0
    entry = 0.0
    entry_time = 0.0
    sl = 0.0
    tp = 0.0

    for i in range(warmup, len(close) - 1):
        sc = scores[i]
        a = atr14[i]
        if not np.isfinite(a) or a <= 0:
            continue
        px = close[i]
        nxt = open_[i + 1]

        if pos != 0:
            hit_sl = (low[i] <= sl) if pos > 0 else (high[i] >= sl)
            hit_tp = (high[i] >= tp) if pos > 0 else (low[i] <= tp)
            fade = (pos > 0 and sc <= exit_th) or (pos < 0 and sc >= -exit_th)
            flip = (pos > 0 and sc <= -entry_th) or (pos < 0 and sc >= entry_th)
            reason = None
            exit_px = None
            if hit_sl:
                reason = "SL"
                exit_px = sl
            elif hit_tp:
                reason = "TP"
                exit_px = tp
            elif flip or fade:
                reason = "SIGNAL"
                exit_px = px

            if reason:
                # spread on round turn already applied at entry via worse fill; exit at exit_px
                pnl_price = (exit_px - entry) * pos
                pnl_pips = pnl_price / pip - spread_pips  # charge spread once more conservatively? already at entry
                # We charged half-spread at entry by filling worse; charge remaining at exit:
                pnl_pips = (exit_px - entry) * pos / pip - spread_pips
                trades.append(
                    Trade(
                        direction=pos,
                        entry_time=entry_time,
                        entry=entry,
                        exit_time=times[i],
                        exit=exit_px,
                        pnl_pips=pnl_pips,
                        pnl_jpy=pnl_pips * jpy_per_pip,
                        reason=reason,
                    )
                )
                pos = 0

        if pos == 0:
            if sc >= entry_th:
                pos = 1
                entry = nxt + spread_pips * pip * 0.5
                entry_time = times[i + 1]
                sl = entry - sl_atr * a
                tp = entry + tp_atr * a
            elif sc <= -entry_th:
                pos = -1
                entry = nxt - spread_pips * pip * 0.5
                entry_time = times[i + 1]
                sl = entry + sl_atr * a
                tp = entry - tp_atr * a

    return trades


def summarize(trades: list[Trade], year: int | None = None) -> dict:
    if year is not None:
        trades = [
            t
            for t in trades
            if datetime.fromtimestamp(t.entry_time, timezone.utc).year == year
        ]
    n = len(trades)
    if n == 0:
        return {
            "year": year,
            "trades": 0,
            "wins": 0,
            "losses": 0,
            "win_rate": 0.0,
            "net_pips": 0.0,
            "net_jpy": 0.0,
            "avg_pips": 0.0,
            "profit_factor": 0.0,
            "max_dd_jpy": 0.0,
            "avg_hold_min": 0.0,
            "tp": 0,
            "sl": 0,
            "signal_exits": 0,
            "monthly": [],
        }

    pnls = np.array([t.pnl_jpy for t in trades])
    pips = np.array([t.pnl_pips for t in trades])
    wins = int((pnls > 0).sum())
    losses = int((pnls <= 0).sum())
    gross_win = float(pnls[pnls > 0].sum()) if wins else 0.0
    gross_loss = float(-pnls[pnls <= 0].sum()) if losses else 0.0
    equity = np.cumsum(pnls)
    peak = np.maximum.accumulate(equity)
    dd = peak - equity
    holds = [(t.exit_time - t.entry_time) / 60 for t in trades]

    monthly_map: dict[str, float] = {}
    for t in trades:
        key = datetime.fromtimestamp(t.entry_time, timezone.utc).strftime("%Y-%m")
        monthly_map[key] = monthly_map.get(key, 0.0) + t.pnl_jpy
    monthly = [{"month": k, "pnl_jpy": round(v)} for k, v in sorted(monthly_map.items())]

    return {
        "year": year,
        "trades": n,
        "wins": wins,
        "losses": losses,
        "win_rate": round(100 * wins / n, 1),
        "net_pips": round(float(pips.sum()), 1),
        "net_jpy": round(float(pnls.sum())),
        "avg_pips": round(float(pips.mean()), 2),
        "profit_factor": round(gross_win / gross_loss, 2) if gross_loss > 0 else None,
        "max_dd_jpy": round(float(dd.max())),
        "avg_hold_min": round(float(np.mean(holds)), 1),
        "tp": sum(1 for t in trades if t.reason == "TP"),
        "sl": sum(1 for t in trades if t.reason == "SL"),
        "signal_exits": sum(1 for t in trades if t.reason == "SIGNAL"),
        "monthly": monthly,
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    print("Loading hourly…")
    hourly = load_hourly()
    print("Expanding to M1…", len(hourly), "hours")
    m1 = build_m1(hourly)
    times, o, h, l, c = m1[:, 0], m1[:, 1], m1[:, 2], m1[:, 3], m1[:, 4]
    print("M1 bars:", len(m1))

    print("Computing confluence scores…")
    scores, atr14 = confluence_scores(o, h, l, c)

    print("Running scalp backtest…")
    trades = run_backtest(times, o, h, l, c, scores, atr14)

    summary = {
        "meta": {
            "pair": "USDJPY",
            "timeframe": "1m",
            "style": "scalping",
            "source": "Yahoo Finance JPY=X 60m → synthetic M1 inside hourly OHLC",
            "note": "デモ再現バックテスト。実ブローカードモ口座の成績ではない。",
            "rules": {
                "entry": "気配スコア ≥ +35 買い / ≤ -35 売り",
                "exit": "TP 1.8×ATR / SL 1.2×ATR / スコア中立化・反転",
                "spread": "0.8 pips",
                "lot": 0.1,
                "jpy_per_pip": 1000,
            },
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
        "all": summarize(trades),
        "y2025": summarize(trades, 2025),
        "y2026": summarize(trades, 2026),
    }

    (OUT / "scalp_summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    # trade log csv-ish json
    trade_rows = [
        {
            "dir": "LONG" if t.direction > 0 else "SHORT",
            "entry_time": datetime.fromtimestamp(t.entry_time, timezone.utc).isoformat(),
            "exit_time": datetime.fromtimestamp(t.exit_time, timezone.utc).isoformat(),
            "entry": round(t.entry, 5),
            "exit": round(t.exit, 5),
            "pips": round(t.pnl_pips, 2),
            "jpy": round(t.pnl_jpy),
            "reason": t.reason,
        }
        for t in trades
    ]
    (OUT / "scalp_trades.json").write_text(json.dumps(trade_rows, ensure_ascii=False))
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
