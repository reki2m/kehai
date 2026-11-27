#!/usr/bin/env python3
"""Fetch ~3 weeks M1 for major FX pairs (skip USDJPY — already on disk)."""
from __future__ import annotations

import json
import lzma
import struct
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path

OUT = Path(__file__).parent / "data" / "duka_multi"
UA = {"User-Agent": "Mozilla/5.0 (compatible; kehai-research/1.0)"}

PAIRS = {
    "EURUSD": 100000,
    "GBPUSD": 100000,
    "AUDUSD": 100000,
    "USDCHF": 100000,
    "EURJPY": 1000,
    "GBPJPY": 1000,
    "CADJPY": 1000,
    "EURGBP": 100000,
}


def hour_url(sym: str, dt: datetime) -> str:
    return (
        f"https://datafeed.dukascopy.com/datafeed/{sym}/"
        f"{dt.year}/{dt.month - 1:02d}/{dt.day:02d}/{dt.hour:02d}h_ticks.bi5"
    )


def fetch_hour(sym: str, dt: datetime, div: int, retries: int = 2):
    url = hour_url(sym, dt)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
            if not raw:
                return []
            data = lzma.decompress(raw)
            base_ms = int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)
            out = []
            for i in range(0, len(data) // 20):
                ms, ask, bid, _a, _b = struct.unpack(
                    ">IIIff", data[i * 20 : (i + 1) * 20]
                )
                out.append(((base_ms + ms) / 1000.0, bid / div, ask / div))
            return out
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return []
            time.sleep(0.4 * (attempt + 1))
        except Exception:
            time.sleep(0.4 * (attempt + 1))
    return []


def ticks_to_m1(ticks):
    buckets: dict[int, list] = {}
    for ts, bid, _ask in ticks:
        m = int(ts // 60) * 60
        buckets.setdefault(m, []).append(bid)
    rows = []
    for m in sorted(buckets):
        bids = buckets[m]
        rows.append(
            {
                "time": m,
                "open": bids[0],
                "high": max(bids),
                "low": min(bids),
                "close": bids[-1],
                "volume": len(bids),
            }
        )
    return rows


def hour_list(start: datetime, end: datetime):
    cur = start.replace(minute=0, second=0, microsecond=0, tzinfo=timezone.utc)
    end = end.replace(tzinfo=timezone.utc)
    hours = []
    while cur < end:
        if not (cur.weekday() == 5 or (cur.weekday() == 6 and cur.hour < 21)):
            hours.append(cur)
        cur += timedelta(hours=1)
    return hours


def download_pair(sym: str, div: int, start: datetime, end: datetime):
    hours = hour_list(start, end)
    print(f"{sym}: {len(hours)} hours…", flush=True)
    ticks = []
    with ThreadPoolExecutor(max_workers=16) as ex:
        futs = [ex.submit(fetch_hour, sym, h, div) for h in hours]
        done = 0
        for fut in as_completed(futs):
            t = fut.result()
            if t:
                ticks.extend(t)
            done += 1
            if done % 200 == 0:
                print(f"  {sym} {done}/{len(hours)} ticks={len(ticks)}", flush=True)
    ticks.sort(key=lambda x: x[0])
    m1 = ticks_to_m1(ticks)
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{sym}_m1_2026oct.json"
    path.write_text(json.dumps(m1))
    print(f"{sym}: M1={len(m1)} → {path.name}", flush=True)
    return sym, len(m1)


def main():
    # Oct 6 → Oct 31 (skip first week to save time; still ~3.5 weeks)
    start = datetime(2026, 10, 6)
    end = datetime(2026, 11, 1)
    # Also copy USDJPY oct from existing monthly file
    OUT.mkdir(parents=True, exist_ok=True)
    src = Path(__file__).parent / "data" / "usdjpy_m1_dukascopy_2026oct.json"
    if src.exists():
        (OUT / "USDJPY_m1_2026oct.json").write_text(src.read_text())
        print("USDJPY: copied existing oct", flush=True)
    results = []
    for sym, div in PAIRS.items():
        results.append(download_pair(sym, div, start, end))
    print("DONE", results)


if __name__ == "__main__":
    main()
