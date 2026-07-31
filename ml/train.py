"""Train the Lake Mendota shift model.

Layer 1 — cluster shift-segments into data-driven archetypes (GMM).
Layer 2 — transition model: P(next archetype | current, hour-bucket, season).
Layer 3 — deep shift-forecaster → ONNX. [STUB — see bottom]

Pulls straight from the SSEC API (decoupled from the app), segments each day
with the same engine the app uses (shifts.py), then learns from the segments
and the shift events between them. Writes compact JSON artifacts the Mendota
views can read at inference time.

Usage:
    pip install -r requirements.txt
    python train.py --days 1825            # 5 years (the real run)
    python train.py --days 60 --stride 3   # quick dev pass (thin to ~3-min)

NOTE on scale: per-day change-point detection over full 1-min data for years is
CPU-heavy in pure Python (~tens of minutes). For the real 5-year artifact run it
overnight, or use --stride for fast iteration. A numpy-vectorized change-point
is the planned speedup.
"""
from __future__ import annotations

import argparse
import json
import os
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np
from sklearn.mixture import GaussianMixture
from sklearn.preprocessing import StandardScaler

import data
import shifts

ARTIFACT_DIR = os.path.join(os.path.dirname(__file__), "artifacts")

# Raw segment features fed to the clusterer (the "shape" of a shift regime).
RAW = [
    "amplitude", "net_shift", "shift_rate", "trend_t",
    "half_life_min", "period_min", "reversals", "hurst",
    "speed_mean", "gust_factor", "dir_std",
]
LOG_COLS = ("amplitude", "period_min", "half_life_min")  # heavy right tails
# Peak-to-peak beyond half a circle isn't a coherent regime — it's a light-air /
# under-segmented artifact (the 386°/431° clusters). Drop before clustering.
MAX_AMP_DEG = 180.0


def group_by_day(samples: list[data.Sample]) -> dict[str, list[data.Sample]]:
    days: dict[str, list[data.Sample]] = defaultdict(list)
    for s in samples:
        key = datetime.fromtimestamp(s.t / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        days[key].append(s)
    return days


def season(month: int) -> str:
    return {12: "DJF", 1: "DJF", 2: "DJF", 3: "MAM", 4: "MAM", 5: "MAM",
            6: "JJA", 7: "JJA", 8: "JJA", 9: "SON", 10: "SON", 11: "SON"}[month]


def _val(seg: shifts.Segment, k: str) -> float:
    v = getattr(seg, k)
    return float("nan") if v is None else float(v)


def build_features(segments: list[shifts.Segment]) -> tuple[np.ndarray, list[str]]:
    """Feature matrix with median-imputed NaNs, presence flags for the
    semantically-missing fields (half-life / period — absent ≠ zero), and
    log-tamed heavy tails."""
    raw = np.array([[_val(s, k) for k in RAW] for s in segments], dtype=float)
    has_hl = (~np.isnan(raw[:, RAW.index("half_life_min")])).astype(float)
    has_pd = (~np.isnan(raw[:, RAW.index("period_min")])).astype(float)
    med = np.nanmedian(raw, axis=0)
    nan = np.isnan(raw)
    raw[nan] = np.take(med, np.where(nan)[1])
    for c in LOG_COLS:
        j = RAW.index(c)
        raw[:, j] = np.log1p(np.clip(raw[:, j], 0, None))
    X = np.hstack([raw, has_hl[:, None], has_pd[:, None]])
    return X, RAW + ["has_half_life", "has_period"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=1825)
    ap.add_argument("--stride", type=int, default=1, help="thin samples (1 = full 1-min)")
    ap.add_argument("--clusters", type=int, default=0, help="0 = auto via BIC (2..8)")
    ap.add_argument("--calm", type=float, default=1.5, help="calm cutoff (kts)")
    args = ap.parse_args()

    print(f"Pulling {args.days} days of Mendota 1-min wind…")
    samples = data.fetch_history(args.days)
    if args.stride > 1:
        samples = samples[:: args.stride]
    if not samples:
        raise SystemExit("No data returned.")

    # --- segment every day into regimes; collect segments + shift events ---
    segments: list[shifts.Segment] = []
    events: list[shifts.ShiftEvent] = []
    for _, day_samples in sorted(group_by_day(samples).items()):
        regimes = shifts.detect_regimes(day_samples, calm_cutoff=args.calm)
        directional = [r for r in regimes if r.mean_dir is not None and r.type != "calm"]
        segments.extend(directional)
        events.extend(shifts.shift_events(regimes))

    # Drop non-physical / light-air-noise segments (peak-to-peak > half a circle).
    dropped = sum(1 for s in segments if s.amplitude > MAX_AMP_DEG)
    segments = [s for s in segments if s.amplitude <= MAX_AMP_DEG]
    print(f"Segments (directional): {len(segments)} kept, {dropped} dropped "
          f"(amp>{MAX_AMP_DEG:.0f}°) · shift events: {len(events)}")
    if len(segments) < 20:
        raise SystemExit("Too few segments to train — pull more days.")

    # --- LAYER 1: cluster shift archetypes ---
    X, feat_names = build_features(segments)
    scaler = StandardScaler().fit(X)
    Xs = scaler.transform(X)

    if args.clusters:
        k = args.clusters
        gmm = GaussianMixture(k, covariance_type="full", random_state=0, n_init=4).fit(Xs)
    else:
        best = None
        for k in range(2, 7):
            g = GaussianMixture(k, covariance_type="full", random_state=0, n_init=4).fit(Xs)
            bic = g.bic(Xs)
            if best is None or bic < best[0]:
                best = (bic, k, g)
        _, k, gmm = best
    labels = gmm.predict(Xs)
    print(f"\nLAYER 1 — {k} shift archetypes:")
    archetypes = []
    for c in range(k):
        idx = np.where(labels == c)[0]
        if not len(idx):
            continue
        segs = [segments[i] for i in idx]
        types = defaultdict(int)
        for s in segs:
            types[s.type] += 1
        dom = max(types, key=types.get)
        mean_dir = shifts.circular_mean([s.mean_dir for s in segs if s.mean_dir is not None])

        def cmean(key):
            vals = [getattr(s, key) for s in segs if getattr(s, key) is not None]
            return float(np.mean(vals)) if vals else float("nan")

        prof = {k2: cmean(k2) for k2 in
                ("amplitude", "net_shift", "period_min", "half_life_min", "speed_mean")}
        archetypes.append({
            "id": c, "n": int(len(idx)), "dominant_type": dom,
            "mean_dir": round(mean_dir, 1), "compass": shifts.compass16(mean_dir),
            # null-out NaN so the JSON stays valid (JS JSON.parse rejects NaN).
            "profile": {kk: (None if vv != vv else round(vv, 1)) for kk, vv in prof.items()},
        })
        fnum = lambda v, s: "—" if v != v else f"{v:.0f}{s}"  # noqa: E731 (v!=v ⇒ NaN)
        print(f"  #{c}  n={len(idx):4d}  {dom:11s}  ~{shifts.compass16(mean_dir):4s} "
              f"amp {fnum(prof['amplitude'], '°')}  period {fnum(prof['period_min'], 'm')}  "
              f"speed {fnum(prof['speed_mean'], 'kt')}")

    # --- LAYER 2: transition model P(next archetype | current, hour, season) ---
    seq = list(labels)
    overall = np.zeros((k, k))
    by_hour = defaultdict(lambda: np.zeros((k, k)))
    by_season = defaultdict(lambda: np.zeros((k, k)))
    for i in range(len(seq) - 1):
        a, b = seq[i], seq[i + 1]
        overall[a, b] += 1
        hr = segments[i].hour
        by_hour[hr][a, b] += 1
        by_season[season(segments[i].month)][a, b] += 1

    def normalize(m: np.ndarray) -> list[list[float]]:
        rs = m.sum(axis=1, keepdims=True)
        rs[rs == 0] = 1
        return (m / rs).round(3).tolist()

    print("\nLAYER 2 — overall transition matrix (rows=current → cols=next):")
    for row in normalize(overall):
        print("  " + " ".join(f"{v:.2f}" for v in row))

    # --- save artifacts ---
    os.makedirs(ARTIFACT_DIR, exist_ok=True)
    artifact = {
        "version": 1,
        "trained_days": args.days,
        "stride": args.stride,
        "n_segments": len(segments),
        "n_events": len(events),
        "features": feat_names,
        "scaler": {"mean": scaler.mean_.tolist(), "scale": scaler.scale_.tolist()},
        "gmm": {
            "k": int(k),
            "means": gmm.means_.tolist(),
            "weights": gmm.weights_.tolist(),
        },
        "archetypes": archetypes,
        "transitions": {
            "overall": normalize(overall),
            "by_hour": {str(h): normalize(m) for h, m in by_hour.items()},
            "by_season": {s: normalize(m) for s, m in by_season.items()},
        },
    }
    out = os.path.join(ARTIFACT_DIR, "shift_model.json")
    with open(out, "w") as f:
        json.dump(artifact, f, indent=2, allow_nan=False)  # JS JSON.parse rejects NaN/Infinity
    print(f"\nWrote {out}")

    # --- LAYER 3 (deep shift-forecaster) — NEXT ---
    # Plan: build overlapping 1-min windows (dir as sin/cos, speed, gust, hour,
    # month) → label each with the next shift event (Δdir, minutes-until, type)
    # from `events`. Train a small TCN/LSTM (PyTorch) to predict P(shift>X° in
    # next N min) + expected direction/timing. Export to ONNX
    # (skl2onnx/torch.onnx) and run via onnxruntime-node on the Mendota view.


if __name__ == "__main__":
    main()
