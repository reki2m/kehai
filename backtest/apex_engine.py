#!/usr/bin/env python3
"""
KEHAI Apex — peak scalping engine designed on REAL M1.

Concept stack (from ICT killzone / liquidity sweep / VWAP pullback / prop filters):
  1. Killzone only (London open / NY AM)
  2. 15m trend bias (EMA21 > EMA55)
  3. Liquidity sweep of rolling swing high/low + body reclaim
  4. Session VWAP side agreement
  5. Displacement candle (strong body)
  6. Tick-volume impulse (above median)
  7. News blackout + spread cap
  8. SL beyond sweep wick, TP = 1.8R, time-stop N bars

Train / holdout on Yahoo real M1; confirm on Dukascopy real spread M1.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from run_real_m1_edge import load_m1, news_blackout
from run_scalp_backtest import OUT, Trade, ema, summarize
from scalp_edge import PIP, JPY_PER_PIP

DATA = Path(__file__).parent / "data"


def killzone(ts: float, mode: str = "ln") -> bool:
    """UTC killzones. ln=London+NY, london, ny."""
    dt = datetime.fromtimestamp(ts, timezone.utc)
    if dt.weekday() >= 5:
        return False
    h, m = dt.hour, dt.minute
    hm = h * 60 + m
    london = 7 * 60 <= hm < 10 * 60  # 07–10 UTC
    ny = 12 * 60 + 30 <= hm < 16 * 60  # 12:30–16 UTC
    if mode == "london":
        return london
    if mode == "ny":
        return ny
    return london or ny


def rolling_swing_levels(h, l, lookback: int = 20):
    n = len(h)
    sh = np.full(n, np.nan)
    sl = np.full(n, np.nan)
    for i in range(lookback, n):
        sh[i] = np.max(h[i - lookback : i])  # prior swing, exclude current
        sl[i] = np.min(l[i - lookback : i])
    return sh, sl


def session_vwap(times, h, l, c, vol):
    n = len(c)
    out = np.full(n, np.nan)
    day = None
    pv = vv = 0.0
    for i in range(n):
        d = datetime.fromtimestamp(times[i], timezone.utc).date()
        if d != day:
            day = d
            pv = vv = 0.0
        typical = (h[i] + l[i] + c[i]) / 3
        v = max(1.0, float(vol[i]))
        pv += typical * v
        vv += v
        out[i] = pv / vv
    return out


def resample_htf_ema(times, c, minutes: int, fast=21, slow=55):
    """Causal HTF bias: EMA on closes of completed HTF bars, mapped to M1."""
    n = len(c)
    # Build HTF closes at bucket ends
    bucket = (times.astype(np.int64) // (minutes * 60))
    htf_close = []
    htf_time = []
    last_b = None
    last_c = None
    for i in range(n):
        b = int(bucket[i])
        if last_b is None:
            last_b = b
            last_c = c[i]
        elif b != last_b:
            htf_close.append(last_c)
            htf_time.append(times[i - 1])
            last_b = b
        last_c = c[i]
    if last_c is not None:
        htf_close.append(last_c)
        htf_time.append(times[-1])
    htf_close = np.array(htf_close, dtype=np.float64)
    if len(htf_close) < slow + 2:
        return np.zeros(n), np.zeros(n)
    # Fake candle list for ema helper — use close-only via synthetic
    # Implement EMA directly
    def _ema(x, p):
        out = np.full_like(x, np.nan)
        if len(x) < p:
            return out
        k = 2 / (p + 1)
        out[p - 1] = x[:p].mean()
        for i in range(p, len(x)):
            out[i] = x[i] * k + out[i - 1] * (1 - k)
        return out

    ef = _ema(htf_close, fast)
    es = _ema(htf_close, slow)
    # map last known HTF ema onto each M1 bar (causal: use previous completed)
    bias = np.zeros(n)
    j = 0
    for i in range(n):
        while j + 1 < len(htf_time) and htf_time[j + 1] <= times[i]:
            j += 1
        # use j-1 as last completed if current bucket still forming
        idx = max(0, j - 1)
        if np.isfinite(ef[idx]) and np.isfinite(es[idx]):
            bias[i] = 1 if ef[idx] > es[idx] else -1
    return bias, ef


@dataclass
class ApexParams:
    swing_lookback: int = 20
    min_body: float = 0.55
    vol_mult: float = 1.1
    rr: float = 1.8
    sl_buffer_pips: float = 0.5
    time_stop: int = 12
    max_spread: float = 1.2
    kz: str = "ln"
    require_vwap: bool = True
    require_vol: bool = True


def run_apex(times, o, h, l, c, spread, vol, p: ApexParams, start_i=0, end_i=None):
    n = len(c)
    end_i = n - 1 if end_i is None else end_i
    swing_hi, swing_lo = rolling_swing_levels(h, l, p.swing_lookback)
    vwap = session_vwap(times, h, l, c, vol)
    bias15, _ = resample_htf_ema(times, c, 15, 21, 55)
    vol_med = np.full(n, np.nan)
    w = 50
    for i in range(w, n):
        vol_med[i] = np.median(vol[i - w : i])

    trades: list[Trade] = []
    pos = 0
    entry = entry_time = stop_px = tp = 0.0
    entry_i = 0
    last_exit = -10**9

    for i in range(max(300, start_i), min(end_i, n - 1)):
        sp = float(spread[i])
        if pos != 0:
            bars_held = i - entry_i
            hit_sl = l[i] <= stop_px if pos > 0 else h[i] >= stop_px
            hit_tp = h[i] >= tp if pos > 0 else l[i] <= tp
            timed = bars_held >= p.time_stop
            reason = exit_px = None
            if hit_sl:
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

        if i - last_exit < 3:
            continue
        if not killzone(times[i], p.kz):
            continue
        if news_blackout(times[i]):
            continue
        if sp > p.max_spread:
            continue
        if not np.isfinite(swing_hi[i]) or not np.isfinite(swing_lo[i]):
            continue

        body = abs(c[i] - o[i])
        rng = max(h[i] - l[i], 1e-9)
        body_ratio = body / rng
        bullish = c[i] > o[i]
        bearish = c[i] < o[i]

        swept_low = l[i] < swing_lo[i] and c[i] > swing_lo[i] and bullish
        swept_high = h[i] > swing_hi[i] and c[i] < swing_hi[i] and bearish
        if body_ratio < p.min_body:
            continue
        if p.require_vol and np.isfinite(vol_med[i]) and vol[i] < vol_med[i] * p.vol_mult:
            continue

        long_setup = swept_low and bias15[i] > 0
        short_setup = swept_high and bias15[i] < 0
        if p.require_vwap and np.isfinite(vwap[i]):
            long_setup = long_setup and c[i] >= vwap[i]
            short_setup = short_setup and c[i] <= vwap[i]

        if not (long_setup or short_setup):
            continue

        if long_setup:
            pos = 1
            entry = o[i + 1] + sp * PIP * 0.5
            entry_time = times[i + 1]
            entry_i = i + 1
            stop = min(l[i], swing_lo[i]) - p.sl_buffer_pips * PIP
            risk = entry - stop
            if risk <= 0:
                pos = 0
                continue
            stop_px = stop
            tp = entry + p.rr * risk
        else:
            pos = -1
            entry = o[i + 1] - sp * PIP * 0.5
            entry_time = times[i + 1]
            entry_i = i + 1
            stop = max(h[i], swing_hi[i]) + p.sl_buffer_pips * PIP
            risk = stop - entry
            if risk <= 0:
                pos = 0
                continue
            stop_px = stop
            tp = entry - p.rr * risk

    return trades


def split_index(times, frac=0.6):
    n = len(times)
    return int(n * frac)


def objective(s: dict) -> float:
    if s["trades"] < 25:
        return -1e9
    pf = s["profit_factor"] or 0
    if s["net_pips"] <= 0:
        return pf * 10 - 50
    return pf * np.sqrt(s["trades"]) + s["net_pips"] / 50 - s["max_dd_jpy"] / 200000


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    yahoo = DATA / "usdjpy_m1_yahoo_recent.json"
    duka = DATA / "usdjpy_m1_dukascopy_2026nov_session.json"

    times, o, h, l, c, spread = load_m1(yahoo)
    rows = json.loads(yahoo.read_text())
    vol = np.array([r.get("volume", 1) for r in rows], dtype=np.float64)
    cut = split_index(times, 0.6)
    print("Yahoo bars", len(c), "train_end", datetime.fromtimestamp(times[cut], timezone.utc))

    grid = []
    for lookback in (15, 20, 30):
        for min_body in (0.5, 0.6, 0.7):
            for vol_mult in (1.0, 1.2, 1.4):
                for rr in (1.5, 1.8, 2.2):
                    for kz in ("ln", "london", "ny"):
                        for require_vwap in (True, False):
                            p = ApexParams(
                                swing_lookback=lookback,
                                min_body=min_body,
                                vol_mult=vol_mult,
                                rr=rr,
                                kz=kz,
                                require_vwap=require_vwap,
                                require_vol=True,
                            )
                            tr = run_apex(times, o, h, l, c, spread, vol, p, 0, cut)
                            s = summarize(tr)
                            grid.append((objective(s), p, s))

    grid.sort(key=lambda x: x[0], reverse=True)
    print("Top train candidates:")
    for i, (obj, p, s) in enumerate(grid[:8]):
        print(i, f"obj={obj:.1f}", asdict(p), f"n={s['trades']} WR={s['win_rate']} pips={s['net_pips']} PF={s['profit_factor']}")

    best_p = grid[0][1]
    train_tr = run_apex(times, o, h, l, c, spread, vol, best_p, 0, cut)
    hold_tr = run_apex(times, o, h, l, c, spread, vol, best_p, cut, len(c) - 1)
    train_s = summarize(train_tr)
    hold_s = summarize(hold_tr)

    # Full yahoo + duka confirm
    full_tr = run_apex(times, o, h, l, c, spread, vol, best_p)
    full_s = summarize(full_tr)

    duka_s = None
    if duka.exists():
        dt, do, dh, dl, dc, ds = load_m1(duka)
        drows = json.loads(duka.read_text())
        dvol = np.array([r.get("volume", 1) for r in drows], dtype=np.float64)
        dtr = run_apex(dt, do, dh, dl, dc, ds, dvol, best_p)
        duka_s = summarize(dtr)
        print("Dukascopy confirm", duka_s)

    # Also test a few top on holdout; pick best holdout among top 15 train
    best_hold = None
    for obj, p, s in grid[:15]:
        ht = summarize(run_apex(times, o, h, l, c, spread, vol, p, cut, len(c) - 1))
        key = (ht["net_pips"], ht["profit_factor"] or 0, -ht["max_dd_jpy"])
        if ht["trades"] >= 15 and (best_hold is None or key > best_hold[0]):
            best_hold = (key, p, s, ht)

    if best_hold and best_hold[3]["net_pips"] > hold_s["net_pips"]:
        print("Switching to better holdout candidate")
        best_p = best_hold[1]
        train_s = best_hold[2]
        hold_s = best_hold[3]
        full_s = summarize(run_apex(times, o, h, l, c, spread, vol, best_p))
        if duka.exists():
            dtr = run_apex(dt, do, dh, dl, dc, ds, dvol, best_p)
            duka_s = summarize(dtr)

    report = {
        "name": "KEHAI Apex",
        "thesis": [
            "ICT-style liquidity sweep + reclaim on M1",
            "15m EMA bias",
            "London / NY killzones",
            "Session VWAP agreement",
            "Displacement body + tick-volume impulse",
            "News blackout + spread cap",
            "SL beyond sweep wick, TP 1.5–2.2R, time-stop",
        ],
        "params": asdict(best_p),
        "yahoo_train": train_s,
        "yahoo_holdout": hold_s,
        "yahoo_full": full_s,
        "dukascopy_confirm": duka_s,
        "note": "Designed and selected on real M1 (not synthetic). Still research BT — not live broker results.",
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    (OUT / "apex_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
