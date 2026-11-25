#!/usr/bin/env python3
"""Politely download real USDJPY M1 from Dukascopy ticks (rate-limit aware)."""

from __future__ import annotations

import json
import lzma
import struct
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

OUT = Path(__file__).parent / "data"
UA = {"User-Agent": "Mozilla/5.0 (compatible; kehai-research/1.0)"}


def hour_url(dt: datetime) -> str:
    return (
        f"https://datafeed.dukascopy.com/datafeed/USDJPY/"
        f"{dt.year}/{dt.month - 1:02d}/{dt.day:02d}/{dt.hour:02d}h_ticks.bi5"
    )


def fetch_hour(dt: datetime, retries: int = 4) -> list[tuple[float, float, float]]:
    url = hour_url(dt)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=45) as r:
                raw = r.read()
            if not raw:
                return []
            data = lzma.decompress(raw)
            base_ms = int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)
            out = []
            for i in range(0, len(data) // 20):
                ms, ask, bid, _a, _b = struct.unpack(">IIIff", data[i * 20 : (i + 1) * 20])
                out.append(((base_ms + ms) / 1000.0, bid / 1000.0, ask / 1000.0))
            return out
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return []
            time.sleep(1.5 * (attempt + 1))
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return []


def ticks_to_m1(ticks: list[tuple[float, float, float]]) -> list[dict]:
    buckets: dict[int, list] = {}
    for ts, bid, ask in ticks:
        m = int(ts // 60) * 60
        buckets.setdefault(m, []).append((bid, ask - bid))
    rows = []
    for m in sorted(buckets):
        bids = [b for b, _ in buckets[m]]
        spreads = [s for _, s in buckets[m]]
        rows.append(
            {
                "time": m,
                "open": bids[0],
                "high": max(bids),
                "low": min(bids),
                "close": bids[-1],
                "volume": len(bids),
                "spread": float(np.mean(spreads) / 0.01),
            }
        )
    return rows


def download_range(start: datetime, end: datetime, label: str) -> list[dict]:
    cur = start.replace(minute=0, second=0, microsecond=0, tzinfo=timezone.utc)
    end = end.replace(tzinfo=timezone.utc)
    hours = []
    while cur < end:
        hours.append(cur)
        cur += timedelta(hours=1)
    print(f"{label}: {len(hours)} hours (serial)…", flush=True)
    ticks: list[tuple[float, float, float]] = []
    for i, h in enumerate(hours):
        # skip obvious weekend gaps faster: Sat full / Sun before 21
        if h.weekday() == 5:
            continue
        if h.weekday() == 6 and h.hour < 21:
            continue
        t = fetch_hour(h)
        if t:
            ticks.extend(t)
        if (i + 1) % 100 == 0:
            print(f"  {label} {i+1}/{len(hours)} ticks={len(ticks)}", flush=True)
        time.sleep(0.55)
    ticks.sort(key=lambda x: x[0])
    m1 = ticks_to_m1(ticks)
    print(f"{label}: M1={len(m1)}", flush=True)
    return m1


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    # Focused real-M1 windows for verification (full 3y too slow under 503s)
    windows = [
        (datetime(2025, 1, 2), datetime(2025, 3, 1), "2025q1"),
        (datetime(2025, 9, 1), datetime(2025, 11, 1), "2025q4"),
        (datetime(2026, 9, 1), datetime(2026, 11, 25, 12), "2026aut"),
    ]
    merged = []
    for a, b, label in windows:
        rows = download_range(a, b, label)
        (OUT / f"usdjpy_m1_dukascopy_{label}.json").write_text(json.dumps(rows))
        merged.extend(rows)
    seen = set()
    uniq = []
    for r in sorted(merged, key=lambda x: x["time"]):
        if r["time"] in seen:
            continue
        seen.add(r["time"])
        uniq.append(r)
    out = OUT / "usdjpy_m1_dukascopy_real.json"
    out.write_text(json.dumps(uniq))
    print("MERGED", len(uniq), "avg_spread", round(float(np.mean([r["spread"] for r in uniq] or [0])), 3))
    if uniq:
        print(
            datetime.fromtimestamp(uniq[0]["time"], timezone.utc),
            "→",
            datetime.fromtimestamp(uniq[-1]["time"], timezone.utc),
        )


if __name__ == "__main__":
    main()
