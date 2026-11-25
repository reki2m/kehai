#!/usr/bin/env python3
"""
Famous TradingView-style indicators for 1m FX scalp research.

Sources (public algorithms widely used on TV):
  - UT Bot Alerts (HPotter / QuantNomad ATR trailing)
  - WaveTrend Oscillator (LazyBear)
  - SSL Channel (ssl / ma cross of high/low)
  - HalfTrend (everget-style ATR channel flip)
  - QQE Mod (RSI + ATR bands, simplified cross)
"""

from __future__ import annotations

import numpy as np

from run_scalp_backtest import atr, ema, rsi


def ut_bot_dir(h, l, c, key=2.0, atr_period=10):
    """+1 / -1 trailing stop direction. Buy when close crosses above trailing stop."""
    a = atr(h, l, c, atr_period)
    n = len(c)
    trail = np.full(n, np.nan)
    direction = np.zeros(n)
    for i in range(atr_period, n):
        if not np.isfinite(a[i]):
            continue
        nloss = key * a[i]
        prev = trail[i - 1] if np.isfinite(trail[i - 1]) else c[i]
        if c[i] > prev and c[i - 1] > prev:
            trail[i] = max(prev, c[i] - nloss)
        elif c[i] < prev and c[i - 1] < prev:
            trail[i] = min(prev, c[i] + nloss)
        elif c[i] > prev:
            trail[i] = c[i] - nloss
        else:
            trail[i] = c[i] + nloss
        direction[i] = 1 if c[i] > trail[i] else -1
    return direction, trail


def wavetrend(h, l, c, channel=10, average=21):
    """LazyBear WaveTrend: wt1, wt2. Cross up = bull."""
    n = len(c)
    ap = (h + l + c) / 3.0
    esa = ema(ap, channel)
    d = ema(np.abs(ap - esa), channel)
    ci = np.where(d > 0, (ap - esa) / (0.015 * d), 0.0)
    wt1 = ema(ci, average)
    # wt2 = SMA of wt1
    wt2 = np.full(n, np.nan)
    for i in range(average - 1, n):
        if np.all(np.isfinite(wt1[i - average + 1 : i + 1])):
            wt2[i] = np.mean(wt1[i - average + 1 : i + 1])
    return wt1, wt2


def ssl_dir(h, l, c, period=10):
    """SSL Channel: MA of high vs MA of low; close vs baseline."""
    n = len(c)
    ma_h = ema(h, period)
    ma_l = ema(l, period)
    direction = np.zeros(n)
    hlv = 0
    for i in range(period, n):
        if not (np.isfinite(ma_h[i]) and np.isfinite(ma_l[i])):
            continue
        if c[i] > ma_h[i]:
            hlv = 1
        elif c[i] < ma_l[i]:
            hlv = -1
        direction[i] = hlv
    return direction


def halftrend_dir(h, l, c, amplitude=2, channel_period=2):
    """HalfTrend-like: ATR deviation flip."""
    a = atr(h, l, c, 100)
    n = len(c)
    direction = np.zeros(n)
    trend = 0
    next_high = next_low = np.nan
    for i in range(100, n):
        if not np.isfinite(a[i]):
            continue
        high_price = np.max(h[max(0, i - channel_period + 1) : i + 1])
        low_price = np.min(l[max(0, i - channel_period + 1) : i + 1])
        if trend == 0:
            trend = 1
            next_high = high_price
            next_low = low_price
        high_ma = high_price
        low_ma = low_price
        if trend == 1:
            if np.isfinite(next_low):
                next_low = max(next_low, low_ma)
            if a[i] * amplitude < high_ma - next_low and c[i] < next_low:
                trend = -1
                next_high = high_ma
        else:
            if np.isfinite(next_high):
                next_high = min(next_high, high_ma)
            if a[i] * amplitude < next_high - low_ma and c[i] > next_high:
                trend = 1
                next_low = low_ma
        direction[i] = trend
    return direction


def qqe_dir(c, rsi_period=14, sf=5, wilders=4.236):
    """Simplified QQE: RSI smoothed + ATR-of-RSI bands; direction by RSI vs long band."""
    r = rsi(c, rsi_period)
    n = len(c)
    # smooth RSI with EMA(sf)
    rs = ema(np.nan_to_num(r, nan=50.0), sf)
    # ATR of RSI
    tr = np.zeros(n)
    for i in range(1, n):
        if np.isfinite(rs[i]) and np.isfinite(rs[i - 1]):
            tr[i] = abs(rs[i] - rs[i - 1])
    dar = ema(tr, rsi_period * 2 - 1)
    direction = np.zeros(n)
    longband = shortband = np.nan
    trend = 0
    for i in range(rsi_period * 2, n):
        if not (np.isfinite(rs[i]) and np.isfinite(dar[i])):
            continue
        delta = dar[i] * wilders
        new_long = rs[i] - delta
        new_short = rs[i] + delta
        if np.isfinite(longband):
            if rs[i - 1] > longband and new_long > longband:
                longband = new_long
            elif rs[i - 1] <= longband:
                longband = new_long
            else:
                longband = max(longband, new_long) if rs[i] > longband else new_long
        else:
            longband = new_long
        if np.isfinite(shortband):
            if rs[i - 1] < shortband and new_short < shortband:
                shortband = new_short
            elif rs[i - 1] >= shortband:
                shortband = new_short
            else:
                shortband = min(shortband, new_short) if rs[i] < shortband else new_short
        else:
            shortband = new_short
        if rs[i] > shortband and rs[i - 1] <= shortband:
            trend = 1
        elif rs[i] < longband and rs[i - 1] >= longband:
            trend = -1
        direction[i] = trend
    return direction, rs


def cross_up(a, b, i):
    return np.isfinite(a[i]) and np.isfinite(b[i]) and np.isfinite(a[i - 1]) and np.isfinite(b[i - 1]) and a[i] > b[i] and a[i - 1] <= b[i - 1]


def cross_dn(a, b, i):
    return np.isfinite(a[i]) and np.isfinite(b[i]) and np.isfinite(a[i - 1]) and np.isfinite(b[i - 1]) and a[i] < b[i] and a[i - 1] >= b[i - 1]
