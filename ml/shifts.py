"""Faithful Python port of the app's wind-shift engine core (src/lib/oscillation.ts).

Direction is circular, so all regression / variance / change-point work happens
on the UNWRAPPED signal. We reuse the *same* logic the live app uses so the
learned model is grounded in the same notion of a "shift" the user sees.

Produces, per contiguous segment: the shift features (mean dir, amplitude, net
shift, shift rate, trend t, OU half-life, swing period, reversals, Hurst, speed,
gust factor, significance, type) + time-of-day / month, and the shift EVENTS
(transitions between consecutive segments).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, asdict
from datetime import datetime, timezone

from data import Sample

D2R = math.pi / 180.0
R2D = 180.0 / math.pi
NAMES = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"]


def compass16(deg: float | None) -> str:
    if deg is None or math.isnan(deg):
        return "—"
    return NAMES[round(((deg % 360) + 360) % 360 / 22.5) % 16]


def ang_diff(a: float, b: float) -> float:
    return (((a - b + 180) % 360) + 360) % 360 - 180


def circular_mean(deg: list[float]) -> float:
    s = sum(math.sin(d * D2R) for d in deg)
    c = sum(math.cos(d * D2R) for d in deg)
    return (math.atan2(s, c) * R2D + 360) % 360


def circular_std(deg: list[float]) -> float:
    n = len(deg)
    if not n:
        return 0.0
    s = sum(math.sin(d * D2R) for d in deg) / n
    c = sum(math.cos(d * D2R) for d in deg) / n
    R = math.sqrt(s * s + c * c)
    if R >= 1:
        return 0.0
    if R <= 1e-9:
        return 90.0
    return math.sqrt(-2 * math.log(R)) * R2D


def _mean(a: list[float]) -> float:
    return sum(a) / len(a) if a else 0.0


def _variance(a: list[float]) -> float:
    n = len(a)
    if n < 2:
        return 0.0
    m = _mean(a)
    return sum((x - m) ** 2 for x in a) / (n - 1)


def _stdev(a: list[float]) -> float:
    return math.sqrt(_variance(a))


def unwrap(dirs: list[float]) -> list[float]:
    out = [dirs[0]]
    for i in range(1, len(dirs)):
        out.append(out[i - 1] + ang_diff(dirs[i], dirs[i - 1]))
    return out


def linreg(xs: list[float], ys: list[float]) -> tuple[float, float, float]:
    """Returns (slope per ms, intercept, t-stat)."""
    n = len(xs)
    if n < 3:
        return 0.0, (ys[0] if ys else 0.0), 0.0
    mx, my = _mean(xs), _mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    slope = sxy / sxx if sxx else 0.0
    intercept = my - slope * mx
    sse = sum((ys[i] - (intercept + slope * xs[i])) ** 2 for i in range(n))
    se = math.sqrt(sse / (n - 2) / sxx) if sxx > 0 else 0.0
    t = slope / se if se > 0 else 0.0
    return slope, intercept, t


def ou_half_life_min(times: list[float], x: list[float]) -> float | None:
    mu = _mean(x)
    num = den = 0.0
    for i in range(len(x) - 1):
        dt = times[i + 1] - times[i]
        if dt <= 0:
            continue
        xc = (x[i] - mu) * dt
        num += (x[i + 1] - x[i]) * xc
        den += xc * xc
    lam = -num / den if den > 0 else 0.0
    return math.log(2) / lam / 60000.0 if lam > 1e-12 else None


def hurst_rs(x: list[float]) -> float | None:
    n = len(x)
    if n < 20:
        return None
    m = _mean(x)
    cum = 0.0
    lo, hi = math.inf, -math.inf
    for v in x:
        cum += v - m
        lo, hi = min(lo, cum), max(hi, cum)
    R = hi - lo
    S = _stdev(x)
    if S <= 0 or R <= 0:
        return None
    return math.log(R / S) / math.log(n)


def welch_t(a: list[float], b: list[float]) -> float:
    va = _variance(a) / len(a)
    vb = _variance(b) / len(b)
    den = math.sqrt(va + vb)
    return (_mean(a) - _mean(b)) / den if den > 1e-9 else 0.0


def detect_change_points(vals: list[float], min_seg=5, thr=3.0, max_depth=2) -> list[int]:
    out: list[int] = []

    def rec(lo: int, hi: int, depth: int):
        if depth <= 0 or hi - lo < 2 * min_seg:
            return
        best_k, best_t = -1, 0.0
        for k in range(lo + min_seg, hi - min_seg + 1):
            t = abs(welch_t(vals[lo:k], vals[k:hi]))
            if t > best_t:
                best_t, best_k = t, k
        if best_k < 0 or best_t < thr:
            return
        out.append(best_k)
        rec(lo, best_k, depth - 1)
        rec(best_k, hi, depth - 1)

    rec(0, len(vals), max_depth)
    return sorted(out)


@dataclass
class Segment:
    start_t: float
    end_t: float
    duration_min: float
    count: int
    type: str
    mean_dir: float | None
    dir_std: float
    amplitude: float
    net_shift: float
    shift_rate: float       # deg/hr
    trend_t: float
    half_life_min: float | None
    period_min: float | None
    reversals: int
    hurst: float | None
    speed_mean: float | None
    gust_factor: float | None
    significance: float
    hour: int               # UTC hour of segment start
    month: int              # UTC month of segment start
    air_c: float | None = None    # mean land air temp over segment, °C
    water_c: float | None = None  # mean lake surface temp over segment, °C


def summarize(samples: list[Sample], calm_cutoff: float, with_hurst: bool) -> Segment:
    s = sorted(samples, key=lambda x: x.t)
    dpts = [(x.t, x.dir) for x in s if x.dir is not None]
    spts = [(x.t, x.speed, x.gust) for x in s if x.speed is not None]
    start_t = s[0].t if s else 0.0
    end_t = s[-1].t if s else 0.0
    dur = (end_t - start_t) / 60000.0
    count = len(dpts)
    start_dt = datetime.fromtimestamp(start_t / 1000, tz=timezone.utc)

    speed_mean = gust_factor = None
    if spts:
        speeds = [p[1] for p in spts]
        speed_mean = _mean(speeds)
        gusts = [p[2] for p in spts if p[2] is not None]
        gmax = max(gusts) if gusts else None
        gust_factor = gmax / speed_mean if speed_mean and gmax else None

    base = Segment(start_t, end_t, dur, count, "insufficient", None, 0.0, 0.0, 0.0,
                   0.0, 0.0, None, None, 0, None, speed_mean, gust_factor, 0.0,
                   start_dt.hour, start_dt.month)
    airs = [x.air_c for x in s if x.air_c is not None]
    waters = [x.water_c for x in s if x.water_c is not None]
    base.air_c = _mean(airs) if airs else None
    base.water_c = _mean(waters) if waters else None

    if speed_mean is not None and speed_mean < calm_cutoff:
        base.type = "calm"
        return base
    if count < 5:
        return base

    dirs = [d for _, d in dpts]
    times = [t for t, _ in dpts]
    mean_dir = circular_mean(dirs)
    dir_std = circular_std(dirs)
    uw = unwrap(dirs)
    mu = _mean(uw)
    centered = [v - mu for v in uw]
    amplitude = max(centered) - min(centered)

    slope, _, t = linreg(times, uw)
    shift_rate = slope * 3_600_000
    net_shift = slope * (times[-1] - times[0])

    hyst = max(2.0, dir_std * 0.6)
    reversals, state = 0, 0
    for d in centered:
        if d > hyst:
            if state == -1:
                reversals += 1
            state = 1
        elif d < -hyst:
            if state == 1:
                reversals += 1
            state = -1
    period_min = (dur / reversals) * 2 if count >= 10 and reversals >= 1 else None
    half_life = ou_half_life_min(times, uw) if count >= 20 else None
    hurst = hurst_rs(uw) if with_hurst else None

    sig_shift = count >= 10 and abs(t) > 2 and abs(net_shift) > 8
    if sig_shift:
        typ = "veering" if net_shift > 0 else "backing"
    elif amplitude < 8:
        typ = "steady"
    else:
        typ = "oscillating"

    conf_w = 1.0 if count >= 20 else 0.6 if count >= 10 else 0.3
    speed_rate = linreg([p[0] for p in spts], [p[1] for p in spts])[0] * 3_600_000 if len(spts) >= 3 else 0.0
    effect = max(abs(net_shift), amplitude * 0.7, abs(speed_rate) * 10)
    eff_score = min(1.0, effect / 40.0)
    real_score = (min(1.0, abs(t) / 4) if typ in ("veering", "backing")
                  else min(1.0, amplitude / 30) if typ == "oscillating" else 0.0)
    significance = conf_w * (0.6 * eff_score + 0.4 * real_score)

    base.type = typ
    base.mean_dir = mean_dir
    base.dir_std = dir_std
    base.amplitude = amplitude
    base.net_shift = net_shift
    base.shift_rate = shift_rate
    base.trend_t = t
    base.half_life_min = half_life
    base.period_min = period_min
    base.reversals = reversals
    base.hurst = hurst
    base.significance = significance
    return base


def detect_regimes(samples: list[Sample], *, calm_cutoff=1.5, min_seg=8, thr=2.5,
                   max_depth=5, with_hurst=True) -> list[Segment]:
    s = sorted(samples, key=lambda x: x.t)
    dpts = [(x.t, x.dir) for x in s if x.dir is not None]
    if len(dpts) < 5:
        return [summarize(s, calm_cutoff, with_hurst)] if s else []
    uw = unwrap([d for _, d in dpts])
    cps = detect_change_points(uw, min_seg, thr, max_depth)
    bounds = [0, *cps, len(dpts)]
    out: list[Segment] = []
    for i in range(len(bounds) - 1):
        t0 = dpts[bounds[i]][0]
        t1 = math.inf if i == len(bounds) - 2 else dpts[bounds[i + 1]][0]
        slice_ = [x for x in s if x.t >= t0 and (t1 == math.inf or x.t < t1)]
        if slice_:
            out.append(summarize(slice_, calm_cutoff, with_hurst))
    return out


@dataclass
class ShiftEvent:
    t: float            # epoch ms of the transition (start of new regime)
    from_dir: float | None
    to_dir: float | None
    delta: float | None   # signed angle change (to - from), (-180,180]
    from_type: str
    to_type: str
    hour: int
    month: int


def shift_events(regimes: list[Segment]) -> list[ShiftEvent]:
    """Transitions between consecutive directional regimes (the actual shifts)."""
    out: list[ShiftEvent] = []
    for a, b in zip(regimes, regimes[1:]):
        if a.mean_dir is None or b.mean_dir is None:
            continue
        dt = datetime.fromtimestamp(b.start_t / 1000, tz=timezone.utc)
        out.append(ShiftEvent(
            t=b.start_t, from_dir=a.mean_dir, to_dir=b.mean_dir,
            delta=ang_diff(b.mean_dir, a.mean_dir),
            from_type=a.type, to_type=b.type, hour=dt.hour, month=dt.month,
        ))
    return out


def segment_dict(seg: Segment) -> dict:
    return asdict(seg)
