#!/usr/bin/env python3
"""
Re-verify KEHAI Simple (UT×SSL, SL7/TP10, one position) for 50–70枚 plan.
Target: ¥500–700k / month → then +8–12枚 scale-up.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

from apex_engine import session_vwap
from famous_indicators import ut_bot_dir, ssl_dir
from holy_grail_forward import BASE
from run_real_m1_edge import load_m1, news_blackout
from run_scalp_backtest import OUT, Trade, ema, summarize
from scalp_edge import PIP
from triple_session_search import session_of, yspread, BROKER_SPREAD

DATA = Path(__file__).parent / "data"
SL, TP = 7.0, 10.0
MAX_HOLD = 45
YEN_PER_PIP_PER_MAI = 100  # 1枚=1万通貨 USDJPY


def prep(times, h, l, c):
    vol = np.maximum(1.0, np.abs(np.diff(c, prepend=c[0])) / PIP * 8)
    pre = {
        "vwap": session_vwap(times, h, l, c, vol),
        "news": np.array([not news_blackout(float(t)) for t in times], bool),
        "e21": ema(c, 21),
        "e55": ema(c, 55),
        "ut": {},
        "ssl": {},
    }
    for key in (1.5, 2.0, 3.0):
        for ap in (7, 10):
            pre["ut"][(key, ap)] = ut_bot_dir(h, l, c, key, ap)
    pre["ssl"][10] = ssl_dir(h, l, c, 10)
    return pre


def run(
    times,
    o,
    h,
    l,
    c,
    spread,
    pre,
    slip=0.3,
    only_sessions=None,
    sl=SL,
    tp=TP,
):
    n = len(c)
    vwap, news, e21, e55 = pre["vwap"], pre["news"], pre["e21"], pre["e55"]
    trades: list[Trade] = []
    pos = 0
    entry = et = stop = tp_px = 0.0
    ei = last = -(10**9)
    sess_allow = only_sessions

    for i in range(80, n - 1):
        sp = float(spread[i])
        dtx = datetime.fromtimestamp(float(times[i]), timezone.utc)
        hm = dtx.hour * 60 + dtx.minute
        sess = session_of(hm)

        if pos != 0:
            hit_sl = l[i] <= stop if pos > 0 else h[i] >= stop
            hit_tp = h[i] >= tp_px if pos > 0 else l[i] <= tp_px
            timed = (i - ei) >= MAX_HOLD
            gap = times[i] - times[i - 1] > 120
            reason = exit_px = None
            if gap:
                reason, exit_px = "TIME", float(c[i])
            elif hit_sl:
                reason, exit_px = "SL", stop
            elif hit_tp:
                reason, exit_px = "TP", tp_px
            elif timed:
                reason, exit_px = "TIME", float(c[i])
            if reason:
                exit_px = exit_px - slip * PIP if pos > 0 else exit_px + slip * PIP
                pnl = (exit_px - entry) * pos / PIP - sp
                # tag session via entry time
                trades.append(
                    Trade(pos, et, entry, times[i], exit_px, pnl, pnl * 1000, reason)
                )
                pos = 0
                last = i
            continue

        if sess is None or sess not in BASE:
            continue
        if sess_allow is not None and sess not in sess_allow:
            continue
        p = BASE[sess]
        if i - last < 1 or not news[i] or sp > p.max_spread or dtx.weekday() >= 5:
            continue
        ut, _ = pre["ut"][(p.ut_key, p.ut_atr)]
        ssl = pre["ssl"][p.ssl_len]
        long_setup = ut[i] > 0 and ut[i - 1] <= 0 and ssl[i] > 0
        short_setup = ut[i] < 0 and ut[i - 1] >= 0 and ssl[i] < 0
        if p.require_vwap:
            long_setup = long_setup and c[i] >= vwap[i]
            short_setup = short_setup and c[i] <= vwap[i]
        if p.require_ema:
            long_setup = long_setup and np.isfinite(e21[i]) and e21[i] > e55[i]
            short_setup = short_setup and np.isfinite(e21[i]) and e21[i] < e55[i]
        if not (long_setup or short_setup):
            continue
        if long_setup:
            pos = 1
            entry = float(o[i + 1]) + sp * PIP * 0.5 + slip * PIP
            stop = entry - sl * PIP
            tp_px = entry + tp * PIP
        else:
            pos = -1
            entry = float(o[i + 1]) - sp * PIP * 0.5 - slip * PIP
            stop = entry + sl * PIP
            tp_px = entry - tp * PIP
        et = times[i + 1]
        ei = i + 1
    return trades


def month_buckets(trades: list[Trade]):
    by = defaultdict(list)
    for t in trades:
        dt = datetime.fromtimestamp(float(t.entry_time), timezone.utc)
        by[dt.strftime("%Y-%m")].append(t.pnl_pips)
    return {m: sum(v) for m, v in sorted(by.items())}


def week_folds(times, trades):
    """Assign each trade to ISO week of entry."""
    by = defaultdict(list)
    for t in trades:
        dt = datetime.fromtimestamp(float(t.entry_time), timezone.utc)
        by[dt.strftime("%G-W%V")].append(t.pnl_pips)
    return {w: sum(v) for w, v in sorted(by.items())}


def session_tag_trades(times, o, h, l, c, spread, pre, slip=0.3):
    """Same as run but attach session of entry to each trade via parallel list."""
    n = len(c)
    vwap, news, e21, e55 = pre["vwap"], pre["news"], pre["e21"], pre["e55"]
    trades = []
    tags = []
    pos = 0
    entry = et = stop = tp_px = 0.0
    ei = last = -(10**9)
    entry_sess = None
    for i in range(80, n - 1):
        sp = float(spread[i])
        dtx = datetime.fromtimestamp(float(times[i]), timezone.utc)
        hm = dtx.hour * 60 + dtx.minute
        sess = session_of(hm)
        if pos != 0:
            hit_sl = l[i] <= stop if pos > 0 else h[i] >= stop
            hit_tp = h[i] >= tp_px if pos > 0 else l[i] <= tp_px
            timed = (i - ei) >= MAX_HOLD
            gap = times[i] - times[i - 1] > 120
            reason = exit_px = None
            if gap:
                reason, exit_px = "TIME", float(c[i])
            elif hit_sl:
                reason, exit_px = "SL", stop
            elif hit_tp:
                reason, exit_px = "TP", tp_px
            elif timed:
                reason, exit_px = "TIME", float(c[i])
            if reason:
                exit_px = exit_px - slip * PIP if pos > 0 else exit_px + slip * PIP
                pnl = (exit_px - entry) * pos / PIP - sp
                trades.append(
                    Trade(pos, et, entry, times[i], exit_px, pnl, pnl * 1000, reason)
                )
                tags.append(entry_sess)
                pos = 0
                last = i
            continue
        if sess is None or sess not in BASE:
            continue
        p = BASE[sess]
        if i - last < 1 or not news[i] or sp > p.max_spread or dtx.weekday() >= 5:
            continue
        ut, _ = pre["ut"][(p.ut_key, p.ut_atr)]
        ssl = pre["ssl"][p.ssl_len]
        long_setup = ut[i] > 0 and ut[i - 1] <= 0 and ssl[i] > 0
        short_setup = ut[i] < 0 and ut[i - 1] >= 0 and ssl[i] < 0
        if p.require_vwap:
            long_setup = long_setup and c[i] >= vwap[i]
            short_setup = short_setup and c[i] <= vwap[i]
        if p.require_ema:
            long_setup = long_setup and np.isfinite(e21[i]) and e21[i] > e55[i]
            short_setup = short_setup and np.isfinite(e21[i]) and e21[i] < e55[i]
        if not (long_setup or short_setup):
            continue
        if long_setup:
            pos = 1
            entry = float(o[i + 1]) + sp * PIP * 0.5 + slip * PIP
            stop = entry - SL * PIP
            tp_px = entry + TP * PIP
        else:
            pos = -1
            entry = float(o[i + 1]) - sp * PIP * 0.5 - slip * PIP
            stop = entry + SL * PIP
            tp_px = entry - TP * PIP
        et = times[i + 1]
        ei = i + 1
        entry_sess = sess
    return trades, tags


def yen(pips: float, mai: int) -> float:
    return pips * YEN_PER_PIP_PER_MAI * mai


def max_dd_pips(trades: list[Trade]) -> float:
    eq = peak = 0.0
    dd = 0.0
    for t in trades:
        eq += t.pnl_pips
        peak = max(peak, eq)
        dd = min(dd, eq - peak)
    return dd


def report_block(label, trades, days_span):
    s = summarize(trades)
    months = month_buckets(trades)
    full_months = {m: p for m, p in months.items() if not m.endswith("-11") or True}
    # Prefer months with enough calendar coverage: skip first/last if partial
    vals = list(months.values())
    avg_mo = float(np.mean(vals)) if vals else 0.0
    med_mo = float(np.median(vals)) if vals else 0.0
    neg_mo = sum(1 for v in vals if v < 0)
    weeks = week_folds(None, trades)
    wvals = list(weeks.values())
    return {
        "label": label,
        "summary": s,
        "months": months,
        "avg_month_pips": avg_mo,
        "median_month_pips": med_mo,
        "negative_months": neg_mo,
        "n_months": len(vals),
        "weeks": weeks,
        "avg_week_pips": float(np.mean(wvals)) if wvals else 0.0,
        "neg_weeks": sum(1 for v in wvals if v < 0),
        "max_dd_pips": max_dd_pips(trades),
        "days_span": days_span,
        "pips_per_day": s["net_pips"] / days_span if days_span else 0,
    }


def main():
    print("=== KEHAI Simple re-verify for 50–70枚 / 月50–70万 ===\n", flush=True)
    yt, yo, yh, yl, yc, _ = load_m1(DATA / "usdjpy_m1_yahoo_recent.json")
    ysp = yspread(yt)
    ypre = prep(yt, yh, yl, yc)
    y_days = (yt[-1] - yt[0]) / 86400

    dt, do, dh, dl, dc, dsp = load_m1(DATA / "usdjuspy_m1_dukascopy_2026nov_session.json") if False else load_m1(
        DATA / "usdjpy_m1_dukascopy_2026nov_session.json"
    )
    dcost = np.maximum(dsp, BROKER_SPREAD)
    dpre = prep(dt, dh, dl, dc)
    d_days = (dt[-1] - dt[0]) / 86400

    results = {"yahoo": {}, "duka": {}, "lot_plan": {}, "scale_rule": {}}

    print("--- Yahoo M1 slip sweep ---")
    for slip in (0.0, 0.2, 0.3, 0.4, 0.5):
        tr = run(yt, yo, yh, yl, yc, ysp, ypre, slip=slip)
        blk = report_block(f"yahoo_slip_{slip}", tr, y_days)
        results["yahoo"][str(slip)] = {
            "trades": blk["summary"]["trades"],
            "win_rate": blk["summary"]["win_rate"],
            "net_pips": blk["summary"]["net_pips"],
            "pf": blk["summary"]["profit_factor"],
            "avg_month_pips": blk["avg_month_pips"],
            "median_month_pips": blk["median_month_pips"],
            "months": blk["months"],
            "max_dd_pips": blk["max_dd_pips"],
            "pips_per_day": blk["pips_per_day"],
            "neg_weeks": blk["neg_weeks"],
            "n_weeks": len(blk["weeks"]),
        }
        print(
            f"  slip {slip}: n={blk['summary']['trades']} net={blk['summary']['net_pips']:.1f}p "
            f"WR={blk['summary']['win_rate']} PF={blk['summary']['profit_factor']} "
            f"avgMo={blk['avg_month_pips']:.1f}p DD={blk['max_dd_pips']:.1f}p"
        )

    print("\n--- Dukascopy confirm ---")
    for slip in (0.2, 0.3, 0.5):
        tr = run(dt, do, dh, dl, dc, dcost, dpre, slip=slip)
        blk = report_block(f"duka_slip_{slip}", tr, d_days)
        results["duka"][str(slip)] = {
            "trades": blk["summary"]["trades"],
            "win_rate": blk["summary"]["win_rate"],
            "net_pips": blk["summary"]["net_pips"],
            "pf": blk["summary"]["profit_factor"],
            "avg_month_pips": blk["avg_month_pips"],
            "max_dd_pips": blk["max_dd_pips"],
            "days": d_days,
            "pips_per_day": blk["pips_per_day"],
            "annualized_month_pips": blk["pips_per_day"] * 20,  # ~20 trading days
        }
        print(
            f"  slip {slip}: n={blk['summary']['trades']} net={blk['summary']['net_pips']:.1f}p "
            f"WR={blk['summary']['win_rate']} PF={blk['summary']['profit_factor']} "
            f"~mo={blk['pips_per_day']*20:.1f}p DD={blk['max_dd_pips']:.1f}p"
        )

    print("\n--- Session breakdown (Yahoo slip 0.3) ---")
    tr, tags = session_tag_trades(yt, yo, yh, yl, yc, ysp, ypre, 0.3)
    by_sess = defaultdict(float)
    cnt = defaultdict(int)
    for t, s in zip(tr, tags):
        by_sess[s] += t.pnl_pips
        cnt[s] += 1
    results["sessions"] = {}
    for s in ("tokyo", "london", "ny"):
        results["sessions"][s] = {"pips": by_sess[s], "n": cnt[s]}
        print(f"  {s}: n={cnt[s]} net={by_sess[s]:.1f}p")

    # Drop worst session
    ranked = sorted(by_sess.items(), key=lambda x: x[1])
    worst = ranked[0][0] if ranked else None
    if worst:
        keep = tuple(s for s in ("tokyo", "london", "ny") if s != worst)
        tr2 = run(yt, yo, yh, yl, yc, ysp, ypre, 0.3, only_sessions=keep)
        s2 = summarize(tr2)
        results["drop_worst"] = {
            "dropped": worst,
            "keep": keep,
            "net_pips": s2["net_pips"],
            "trades": s2["trades"],
            "pf": s2["profit_factor"],
            "win_rate": s2["win_rate"],
        }
        print(f"  drop {worst}: n={s2['trades']} net={s2['net_pips']:.1f}p PF={s2['profit_factor']}")

    print("\n--- SL/TP sensitivity (Yahoo slip 0.3) ---")
    results["sltp"] = {}
    for sl, tp in ((5, 8), (6, 9), (7, 10), (7, 12), (7, 15), (8, 12)):
        tr = run(yt, yo, yh, yl, yc, ysp, ypre, 0.3, sl=sl, tp=tp)
        s = summarize(tr)
        results["sltp"][f"{sl}/{tp}"] = {
            "net_pips": s["net_pips"],
            "trades": s["trades"],
            "pf": s["profit_factor"],
            "win_rate": s["win_rate"],
            "dd": max_dd_pips(tr),
        }
        print(
            f"  {sl}/{tp}: n={s['trades']} net={s['net_pips']:.1f}p PF={s['profit_factor']} WR={s['win_rate']} DD={max_dd_pips(tr):.1f}"
        )

    # Core estimate: Yahoo slip 0.3 monthly
    core = results["yahoo"]["0.3"]
    # Use pips/day * 20 as month estimate AND avg of observed months
    obs_mo = core["avg_month_pips"]
    # scale observed months: data may be ~28 days = ~1 month only
    # better: annualize from daily
    mo_from_daily = core["pips_per_day"] * 20
    # blend: prefer observed if n_months>=2 else daily*20
    n_mo = len(core["months"])
    est_mo_pips = obs_mo if n_mo >= 2 else mo_from_daily
    # Also use calendar: total pips / (days/30)
    cal_mo = core["net_pips"] / (y_days / 30.0)

    print(f"\n--- Month pip estimates (Yahoo slip0.3) ---")
    print(f"  observed avg month buckets: {obs_mo:.1f}p ({n_mo} buckets)")
    print(f"  calendar (net / days*30): {cal_mo:.1f}p")
    print(f"  trading-day ×20: {mo_from_daily:.1f}p")
    # For ~28d sample, calendar monthly is the right scale of "one month sample"
    # annualize carefully
    est = {
        "pessimistic_slip0.5_cal": results["yahoo"]["0.5"]["net_pips"] / (y_days / 30.0),
        "base_slip0.3_cal": cal_mo,
        "optimistic_slip0.2_cal": results["yahoo"]["0.2"]["net_pips"] / (y_days / 30.0),
        "duka_slip0.3_x20": results["duka"]["0.3"]["annualized_month_pips"],
    }
    results["month_est_pips"] = est
    for k, v in est.items():
        print(f"  {k}: {v:.1f}p/mo")

    print("\n--- Yen at 50 / 60 / 70枚 ---")
    lot_plan = {}
    for mai in (50, 60, 70):
        row = {}
        for name, pips in est.items():
            y = yen(pips, mai)
            hit = 500_000 <= y <= 900_000 or y >= 500_000
            row[name] = {"yen": round(y), "hit_50_70万": y >= 500_000}
            print(f"  {mai}枚 × {name}: ¥{y:,.0f}/月  {'✓目標帯以上' if y >= 500_000 else '×未達'}")
        # DD in yen
        dd = abs(core["max_dd_pips"])
        row["sample_max_dd_yen"] = round(yen(dd, mai))
        row["sl_one_yen"] = 7 * YEN_PER_PIP_PER_MAI * mai
        lot_plan[str(mai)] = row
        print(f"    sample max DD ≈ ¥{yen(dd, mai):,.0f}  SL1回=¥{7*100*mai:,}")

    results["lot_plan"] = lot_plan

    # Scale rule: if month >= 500k at current size, add 8-12
    print("\n--- Scale rule (+8〜12枚) ---")
    scale = {
        "start_mai": 50,
        "cap_mai": 70,
        "step_mai": [8, 12],
        "gate_month_yen": 500_000,
        "logic": "固定ルールで1ヶ月実測。月≥50万なら+8〜12枚（上限70）。未達・DD悪化なら据え置き/減枚。",
        "paths": {
            "50→58→70": "月ゲート2回クリアで上限",
            "50→62": "一回+12で上限近く",
        },
    }
    # Expected yen after scale if edge holds (same pips)
    for base_mai, add in ((50, 8), (50, 12), (60, 10)):
        new = min(70, base_mai + add)
        for scen, pips in (("base", est["base_slip0.3_cal"]), ("pess", est["pessimistic_slip0.5_cal"])):
            print(
                f"  {base_mai}+{add}→{new}枚 {scen}: ¥{yen(pips, new):,.0f}/月"
            )
    results["scale_rule"] = scale

    # Verdict
    base50 = yen(est["base_slip0.3_cal"], 50)
    base70 = yen(est["base_slip0.3_cal"], 70)
    pess50 = yen(est["pessimistic_slip0.5_cal"], 50)
    duka50 = yen(est["duka_slip0.3_x20"], 50)
    verdict = {
        "logic_still_best_sltp": results["sltp"]["7/10"]["net_pips"]
        == max(v["net_pips"] for v in results["sltp"].values()),
        "yahoo_slip03_50mai_yen": round(base50),
        "yahoo_slip03_70mai_yen": round(base70),
        "yahoo_slip05_50mai_yen": round(pess50),
        "duka_slip03_50mai_yen": round(duka50),
        "target_50_70万_at_50_70mai": bool(base50 >= 500_000 or base70 >= 500_000),
        "recommendation": "",
    }
    if base50 >= 500_000 and pess50 >= 400_000:
        verdict["recommendation"] = (
            "ロジック維持（SL7/TP10）。50枚スタートで月50万帯は基準シナリオで到達見込み。"
            "滑り0.5でも大きく崩壊しない。達成月に+8〜12枚、上限70。"
        )
    elif base70 >= 500_000:
        verdict["recommendation"] = (
            "50枚では月50万がギリギリ〜未達の月あり得る。70枚なら基準シナリオで到達。"
            "まず50枚で実測、安定後に上限まで段階上げ。"
        )
    else:
        verdict["recommendation"] = (
            "バックテスト月次は目標に届かない可能性。枚数上限内では期待値を下げて運用し、"
            "実弾1ヶ月のpipsを見て判断。"
        )
    results["verdict"] = verdict
    print("\n=== VERDICT ===")
    print(json.dumps(verdict, ensure_ascii=False, indent=2))

    out = OUT / "reverify_lot_plan.json"
    out.write_text(json.dumps(results, ensure_ascii=False, indent=2, default=str))
    print(f"\nwrote {out}")


if __name__ == "__main__":
    main()
