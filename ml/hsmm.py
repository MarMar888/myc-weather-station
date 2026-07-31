"""Layers 1-2 as a covariate-dependent Hidden Semi-Markov Model.

A semi-Markov model is a Markov chain over hidden states PLUS an explicit model
of how long each state lasts. The contribution of the Mendota-buoy paper
(arXiv 2109.09949) is making those state-DURATIONS depend on covariates. We do
the same, in a runnable/interpretable form:

  - emission states : GMM over segment shape + direction features
  - transitions     : Markov state -> state matrix
  - durations       : Poisson GLM,  E[duration_min] = exp(Xβ),
                      X = [state one-hots, hour harmonics, season harmonics,
                           lake-breeze ε, ΔT(land-water)]

So "how long does this regime hold before it shifts?" becomes a learned
function of time-of-day, season, and the lake-breeze forcing — exactly the
afternoon-breeze physics, learned from data.

Parameters are estimated from the change-point segmentation (shifts.py), which
is a faithful port of the app's engine. A fully-joint Baum-Welch / Bayesian
(NumPyro) version is the planned follow-up; this gives states + durations +
covariates today.

Run:
    pip install -r requirements.txt
    python hsmm.py --days 365
    python hsmm.py --days 60 --stride 3   # quick dev pass
"""
from __future__ import annotations

import argparse
import json
import os
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np
from sklearn.linear_model import PoissonRegressor
from sklearn.mixture import GaussianMixture
from sklearn.preprocessing import StandardScaler

import data
import shifts

ART = os.path.join(os.path.dirname(__file__), "artifacts")
MAX_AMP_DEG = 180.0
KNOTS_TO_MS = 0.514444

# Emission features that define a wind "state" (shape + where it points).
SHAPE = ["amplitude", "net_shift", "trend_t", "reversals", "hurst",
         "speed_mean", "gust_factor", "dir_std"]
LOG_COLS = ("amplitude",)


def _val(seg, k):
    v = getattr(seg, k)
    return float("nan") if v is None else float(v)


def emission_matrix(segments):
    """Shape features + direction (sin/cos), NaN-median-imputed, tails tamed."""
    raw = np.array([[_val(s, k) for k in SHAPE] for s in segments], float)
    med = np.nanmedian(raw, axis=0)
    nan = np.isnan(raw)
    raw[nan] = np.take(med, np.where(nan)[1])
    for c in LOG_COLS:
        j = SHAPE.index(c)
        raw[:, j] = np.log1p(np.clip(raw[:, j], 0, None))
    rad = np.radians([s.mean_dir or 0.0 for s in segments])
    X = np.hstack([raw, np.sin(rad)[:, None], np.cos(rad)[:, None]])
    return X, SHAPE + ["dir_sin", "dir_cos"]


def seg_breeze(seg):
    """(ΔT, ε) for a segment. ΔT = land air − lake water; ε = U²/ΔT (0 if ΔT≤0)."""
    if seg.air_c is None or seg.water_c is None:
        return float("nan"), float("nan")
    dt = seg.air_c - seg.water_c
    if dt <= 0:
        return dt, 0.0
    u = (seg.speed_mean or 0.0) * KNOTS_TO_MS
    return dt, (u * u) / dt


def duration_design(segments, labels, k):
    """X for the duration GLM + human-readable covariate names."""
    rows, dts, epss = [], [], []
    for s in segments:
        dt, eps = seg_breeze(s)
        dts.append(dt)
        epss.append(eps)
    dts = np.array(dts)
    epss = np.array(epss)
    dts[np.isnan(dts)] = np.nanmedian(dts) if np.isfinite(np.nanmedian(dts)) else 0.0
    epss[np.isnan(epss)] = 0.0

    for i, s in enumerate(segments):
        h = s.hour * np.pi / 12.0       # 2π·hour/24
        m = s.month * np.pi / 6.0       # 2π·month/12
        onehot = [1.0 if labels[i] == c else 0.0 for c in range(k)]
        rows.append(onehot + [
            np.sin(h), np.cos(h), np.sin(2 * h), np.cos(2 * h),  # diurnal
            np.sin(m), np.cos(m),                                # seasonal
            epss[i], dts[i],
        ])
    names = [f"state_{c}" for c in range(k)] + [
        "sin_h", "cos_h", "sin_2h", "cos_2h", "sin_m", "cos_m", "eps", "dt"]
    return np.array(rows, float), names, epss, dts


def group_by_day(samples):
    days = defaultdict(list)
    for s in samples:
        key = datetime.fromtimestamp(s.t / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        days[key].append(s)
    return days


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--stride", type=int, default=1)
    ap.add_argument("--states", type=int, default=0, help="0 = auto via BIC (2..6)")
    ap.add_argument("--calm", type=float, default=1.5)
    args = ap.parse_args()

    print(f"Pulling {args.days} days of Mendota 1-min wind + lake-breeze inputs…")
    samples = data.fetch_history(args.days)
    if args.stride > 1:
        samples = samples[:: args.stride]

    segments = []
    for _, day in sorted(group_by_day(samples).items()):
        for r in shifts.detect_regimes(day, calm_cutoff=args.calm):
            if r.mean_dir is not None and r.type != "calm" and r.duration_min > 0 \
                    and r.amplitude <= MAX_AMP_DEG:
                segments.append(r)
    print(f"Directional segments: {len(segments)}")
    if len(segments) < 30:
        raise SystemExit("Too few segments — pull more days.")

    # --- emission states (GMM) ---
    X, _ = emission_matrix(segments)
    scaler = StandardScaler().fit(X)
    Xs = scaler.transform(X)
    if args.states:
        k = args.states
        gmm = GaussianMixture(k, covariance_type="full", random_state=0, n_init=4).fit(Xs)
    else:
        best = None
        for kk in range(2, 7):
            g = GaussianMixture(kk, covariance_type="full", random_state=0, n_init=4).fit(Xs)
            b = g.bic(Xs)
            if best is None or b < best[0]:
                best = (b, kk, g)
        _, k, gmm = best
    labels = gmm.predict(Xs)

    # --- transitions ---
    trans = np.zeros((k, k))
    for i in range(len(labels) - 1):
        trans[labels[i], labels[i + 1]] += 1
    rs = trans.sum(1, keepdims=True)
    rs[rs == 0] = 1
    trans_n = (trans / rs)

    # --- covariate-dependent durations (Poisson GLM, log link) ---
    Xd, dnames, epss, dts = duration_design(segments, labels, k)
    y = np.array([s.duration_min for s in segments])
    # standardize the continuous covariates (last 8 cols) for stable coefficients
    cont = slice(k, k + 8)
    cscaler = StandardScaler().fit(Xd[:, cont])
    Xd[:, cont] = cscaler.transform(Xd[:, cont])
    glm = PoissonRegressor(alpha=1e-3, fit_intercept=False, max_iter=2000).fit(Xd, y)

    # --- report ---
    print(f"\nHSMM — {k} states (emission · transition · covariate durations)\n")
    cmean = lambda key, segs: float(np.mean([getattr(s, key) for s in segs
                                             if getattr(s, key) is not None]) or 0)  # noqa: E731
    states_out = []
    for c in range(k):
        segs = [segments[i] for i in range(len(segments)) if labels[i] == c]
        if not segs:
            continue
        types = defaultdict(int)
        for s in segs:
            types[s.type] += 1
        dom = max(types, key=types.get)
        md = shifts.circular_mean([s.mean_dir for s in segs if s.mean_dir is not None])
        dur = float(np.median([s.duration_min for s in segs]))
        print(f"  state {c}: n={len(segs):4d}  {dom:11s}  ~{shifts.compass16(md):4s} "
              f"({md:.0f}°)  median dur {dur:.0f} min  speed {cmean('speed_mean', segs):.1f}kt")
        states_out.append({"id": c, "n": len(segs), "dominant_type": dom,
                           "mean_dir": round(md, 1), "compass": shifts.compass16(md),
                           "median_duration_min": round(dur, 1)})

    # covariate sensitivities: hold every covariate at its (already-standardized)
    # mean, then vary one at a time and predict E[duration].
    eidx = dnames.index("eps")
    elo, ehi = np.percentile(epss, 10), np.percentile(epss, 90)
    row = Xd.mean(0)
    lo = row.copy(); hi = row.copy()
    eps_std = (np.array([elo, ehi]) - cscaler.mean_[eidx - k]) / cscaler.scale_[eidx - k]
    lo[eidx], hi[eidx] = eps_std
    d_lo, d_hi = glm.predict(np.vstack([lo, hi]))
    print(f"\n  lake-breeze ε effect on duration:  ε low(p10)={elo:.2f} → {d_lo:.0f} min   "
          f"ε high(p90)={ehi:.2f} → {d_hi:.0f} min")

    # hour sweep (UTC → note CT = UTC-5/6)
    hsin, hcos = dnames.index("sin_h"), dnames.index("cos_h")
    h2s, h2c = dnames.index("sin_2h"), dnames.index("cos_2h")
    preds = []
    for hr in range(24):
        r = row.copy()
        h = hr * np.pi / 12.0
        vals = {hsin: np.sin(h), hcos: np.cos(h), h2s: np.sin(2 * h), h2c: np.cos(2 * h)}
        for j, v in vals.items():
            r[j] = (v - cscaler.mean_[j - k]) / cscaler.scale_[j - k]
        preds.append(glm.predict(r[None])[0])
    hi_h, lo_h = int(np.argmax(preds)), int(np.argmin(preds))
    print(f"  hour-of-day effect:  longest regimes ~{hi_h:02d}h UTC ({preds[hi_h]:.0f} min), "
          f"shortest ~{lo_h:02d}h UTC ({preds[lo_h]:.0f} min)")

    os.makedirs(ART, exist_ok=True)
    out = os.path.join(ART, "hsmm_model.json")
    with open(out, "w") as f:
        json.dump({
            "version": 1,
            "trained_days": args.days,
            "stride": args.stride,
            "n_segments": len(segments),
            "k_states": int(k),
            "emission": {
                "features": SHAPE + ["dir_sin", "dir_cos"],
                "scaler_mean": scaler.mean_.tolist(),
                "scaler_scale": scaler.scale_.tolist(),
                "gmm_means": gmm.means_.tolist(),
                "gmm_weights": gmm.weights_.tolist(),
            },
            "transitions": trans_n.round(3).tolist(),
            "duration_glm": {
                "features": dnames,
                "coef": glm.coef_.tolist(),
                "cont_scaler_mean": cscaler.mean_.tolist(),
                "cont_scaler_scale": cscaler.scale_.tolist(),
                "note": "E[duration_min]=exp(coef·X); continuous cols (eps,dt,harmonics) standardized.",
            },
            "states": states_out,
        }, f, indent=2, allow_nan=False)
    print(f"\nWrote {out}")


if __name__ == "__main__":
    main()
