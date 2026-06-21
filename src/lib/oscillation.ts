// Wind oscillation / shift analysis.
//
// Direction is circular (wraps at 360), so we work on the UNWRAPPED signal
// (continuous degrees) for every regression / variance / change-point step.
// Periods are discovered by change-point detection, not chosen by the user, and
// every statistic is gated on sample size so small-n noise is never dressed up
// as a finding.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

const NAMES = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];
export function compass16(deg: number | null | undefined): string {
  if (deg == null || Number.isNaN(deg)) return "—";
  return NAMES[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** Signed smallest angle a-b, in (-180, 180]. */
export function angDiff(a: number, b: number): number {
  return ((((a - b + 180) % 360) + 360) % 360) - 180;
}

function circularMean(deg: number[]): number {
  let s = 0, c = 0;
  for (const d of deg) {
    s += Math.sin(d * D2R);
    c += Math.cos(d * D2R);
  }
  return ((Math.atan2(s, c) * R2D) + 360) % 360;
}

function circularStd(deg: number[]): number {
  const n = deg.length;
  if (!n) return 0;
  let s = 0, c = 0;
  for (const d of deg) {
    s += Math.sin(d * D2R);
    c += Math.cos(d * D2R);
  }
  s /= n; c /= n;
  const R = Math.sqrt(s * s + c * c);
  if (R >= 1) return 0;
  if (R <= 1e-9) return 90;
  return Math.sqrt(-2 * Math.log(R)) * R2D;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
function variance(a: number[]): number {
  const n = a.length;
  if (n < 2) return 0;
  const m = mean(a);
  return a.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1);
}
const stdev = (a: number[]) => Math.sqrt(variance(a));

// erf / normal CDF for an approximate two-sided p-value from a t-statistic.
function erf(x: number): number {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return s * y;
}
function pFromT(t: number): number {
  // normal approximation; fine for a UI gloss, labelled "≈"
  return Math.max(0, Math.min(1, 2 * (1 - 0.5 * (1 + erf(Math.abs(t) / Math.SQRT2)))));
}

/** Unwrap a circular degree series into continuous degrees. */
function unwrap(dirs: number[]): number[] {
  const out = [dirs[0]];
  for (let i = 1; i < dirs.length; i++) out.push(out[i - 1] + angDiff(dirs[i], dirs[i - 1]));
  return out;
}

interface LinReg {
  slope: number; // y per ms
  intercept: number;
  t: number; // slope / SE
  p: number;
}
function linreg(xs: number[], ys: number[]): LinReg {
  const n = xs.length;
  if (n < 3) return { slope: 0, intercept: ys[0] ?? 0, t: 0, p: 1 };
  const mx = mean(xs), my = mean(ys);
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - (intercept + slope * xs[i])) ** 2;
  const seSlope = sxx > 0 ? Math.sqrt(sse / (n - 2) / sxx) : 0;
  const t = seSlope > 0 ? slope / seSlope : 0;
  return { slope, intercept, t, p: pFromT(t) };
}

/**
 * Ornstein-Uhlenbeck mean-reversion fit (handles irregular dt):
 *   dx ≈ -λ (x - mean) dt
 * λ > 0 ⇒ mean-reverting; half-life = ln2 / λ.
 */
function ouHalfLifeMin(times: number[], x: number[]): { lambda: number; halfLifeMin: number | null } {
  const mu = mean(x);
  let num = 0, den = 0;
  for (let i = 0; i < x.length - 1; i++) {
    const dt = times[i + 1] - times[i];
    if (dt <= 0) continue;
    const xc = (x[i] - mu) * dt;
    num += (x[i + 1] - x[i]) * xc;
    den += xc * xc;
  }
  const lambda = den > 0 ? -num / den : 0; // per ms
  const halfLifeMin = lambda > 1e-12 ? Math.LN2 / lambda / 60000 : null;
  return { lambda, halfLifeMin };
}

/** Rescaled-range Hurst estimate for one series. ~0.5 random, <0.5 mean-reverting, >0.5 trending. */
function hurstRS(x: number[]): number | null {
  const n = x.length;
  if (n < 20) return null;
  const m = mean(x);
  let cum = 0, min = Infinity, max = -Infinity;
  for (const v of x) {
    cum += v - m;
    if (cum < min) min = cum;
    if (cum > max) max = cum;
  }
  const R = max - min;
  const S = stdev(x);
  if (S <= 0 || R <= 0) return null;
  return Math.log(R / S) / Math.log(n);
}

function welchT(a: number[], b: number[]): number {
  const va = variance(a) / a.length, vb = variance(b) / b.length;
  const den = Math.sqrt(va + vb);
  if (den <= 1e-9) return 0;
  return (mean(a) - mean(b)) / den;
}

/** Recursive binary segmentation on a continuous series; returns split indices. */
function detectChangePoints(
  vals: number[],
  minSeg = 5,
  thr = 3,
  maxDepth = 2,
): number[] {
  const out: number[] = [];
  const rec = (lo: number, hi: number, depth: number) => {
    if (depth <= 0 || hi - lo < 2 * minSeg) return;
    let bestK = -1, bestT = 0;
    for (let k = lo + minSeg; k <= hi - minSeg; k++) {
      const t = Math.abs(welchT(vals.slice(lo, k), vals.slice(k, hi)));
      if (t > bestT) { bestT = t; bestK = k; }
    }
    if (bestK < 0 || bestT < thr) return;
    out.push(bestK);
    rec(lo, bestK, depth - 1);
    rec(bestK, hi, depth - 1);
  };
  rec(0, vals.length, maxDepth);
  return out.sort((a, b) => a - b);
}

// ---- public types --------------------------------------------------------

export interface WindSample {
  t: number;
  dir: number | null;
  speed: number | null; // already in display unit
  gust: number | null;
}

export type RegimeType =
  | "oscillating"
  | "veering"
  | "backing"
  | "building"
  | "easing"
  | "steady"
  | "calm"
  | "insufficient";

export type Confidence = "low" | "medium" | "high";

export interface Regime {
  startT: number;
  endT: number;
  durationMin: number;
  count: number;
  confidence: Confidence;
  type: RegimeType;
  typeLabel: string;
  // direction
  meanDir: number | null;
  meanCompass: string;
  dirStd: number;
  amplitude: number;
  fromBearing: number | null;
  toBearing: number | null;
  startBearing: number | null;
  endBearing: number | null;
  netShift: number;
  shiftRate: number; // deg/hr
  trendT: number;
  trendP: number;
  halfLifeMin: number | null;
  meanReverting: boolean | null;
  periodMin: number | null;
  reversals: number;
  hurst: number | null;
  // speed (display unit)
  speedMean: number | null;
  speedMin: number | null;
  speedMax: number | null;
  gustMax: number | null;
  gustFactor: number | null;
  speedStd: number | null;
  speedRate: number;
  // chart + math
  series: { t: number; dev: number; trend: number }[];
  math: { label: string; value: string }[];
}

const TYPE_LABEL: Record<RegimeType, string> = {
  oscillating: "Oscillating",
  veering: "Veering (right)",
  backing: "Backing (left)",
  building: "Building",
  easing: "Easing",
  steady: "Steady",
  calm: "Calm",
  insufficient: "Settling",
};

export interface RegimeOpts {
  calmCutoff: number; // in display unit
  withHurst?: boolean;
}

function confidenceFor(n: number): Confidence {
  if (n >= 20) return "high";
  if (n >= 10) return "medium";
  return "low";
}

/** Summarise one contiguous slice of samples into a Regime. */
export function summarizeRegime(samples: WindSample[], opts: RegimeOpts): Regime {
  const all = samples.slice().sort((a, b) => a.t - b.t);
  const dirPts = all.filter((s) => s.dir != null) as { t: number; dir: number }[];
  const spPts = all.filter((s) => s.speed != null) as {
    t: number; speed: number; gust: number | null;
  }[];
  const startT = all.length ? all[0].t : 0;
  const endT = all.length ? all[all.length - 1].t : 0;
  const durationMin = (endT - startT) / 60000;
  const count = dirPts.length;

  const base: Regime = {
    startT, endT, durationMin, count,
    confidence: confidenceFor(count),
    type: "insufficient", typeLabel: TYPE_LABEL.insufficient,
    meanDir: null, meanCompass: "—", dirStd: 0, amplitude: 0,
    fromBearing: null, toBearing: null, startBearing: null, endBearing: null,
    netShift: 0, shiftRate: 0, trendT: 0, trendP: 1,
    halfLifeMin: null, meanReverting: null, periodMin: null, reversals: 0, hurst: null,
    speedMean: null, speedMin: null, speedMax: null, gustMax: null, gustFactor: null,
    speedStd: null, speedRate: 0, series: [], math: [],
  };

  // speed stats (work regardless of direction availability)
  if (spPts.length) {
    const speeds = spPts.map((p) => p.speed);
    base.speedMean = mean(speeds);
    base.speedMin = Math.min(...speeds);
    base.speedMax = Math.max(...speeds);
    base.speedStd = stdev(speeds);
    const gusts = spPts.map((p) => p.gust).filter((g): g is number => g != null);
    base.gustMax = gusts.length ? Math.max(...gusts) : null;
    base.gustFactor = base.speedMean > 0 && base.gustMax != null ? base.gustMax / base.speedMean : null;
    base.speedRate = spPts.length >= 3 ? linreg(spPts.map((p) => p.t), speeds).slope * 3_600_000 : 0;
  }

  // calm guard: direction is meaningless in light air
  if (base.speedMean != null && base.speedMean < opts.calmCutoff) {
    return { ...base, type: "calm", typeLabel: TYPE_LABEL.calm };
  }
  if (count < 5) return base; // insufficient

  const dirs = dirPts.map((p) => p.dir);
  const times = dirPts.map((p) => p.t);
  const meanDir = circularMean(dirs);
  const dirStd = circularStd(dirs);
  const uw = unwrap(dirs);
  const muU = mean(uw);
  const centered = uw.map((v) => v - muU);
  const minDev = Math.min(...centered), maxDev = Math.max(...centered);
  const amplitude = maxDev - minDev;

  const reg = linreg(times, uw);
  const shiftRate = reg.slope * 3_600_000;
  const netShift = reg.slope * (times[count - 1] - times[0]);

  // reversals (hysteresis) → swing period
  const hyst = Math.max(2, dirStd * 0.6);
  let reversals = 0, state = 0;
  for (const d of centered) {
    if (d > hyst) { if (state === -1) reversals++; state = 1; }
    else if (d < -hyst) { if (state === 1) reversals++; state = -1; }
  }
  const periodMin = count >= 10 && reversals >= 1 ? (durationMin / reversals) * 2 : null;

  const ou = count >= 20 ? ouHalfLifeMin(times, uw) : { lambda: 0, halfLifeMin: null };
  const meanReverting = count >= 20 ? ou.lambda > 1e-12 : null;
  const hurst = opts.withHurst ? hurstRS(uw) : null;

  // classify
  const sigShift = count >= 10 && Math.abs(reg.t) > 2 && Math.abs(netShift) > 8;
  let type: RegimeType;
  if (sigShift) type = netShift > 0 ? "veering" : "backing";
  else if (amplitude < 8) type = "steady";
  else type = "oscillating";

  const series = dirPts.map((p, i) => ({
    t: p.t,
    dev: centered[i],
    trend: reg.intercept + reg.slope * times[i] - muU,
  }));

  const math: { label: string; value: string }[] = [
    { label: "samples (n)", value: `${count}` },
    { label: "mean dir", value: `${Math.round(meanDir)}° (${compass16(meanDir)})` },
    { label: "circular σ", value: `${dirStd.toFixed(1)}°` },
    { label: "trend slope", value: `${shiftRate >= 0 ? "+" : ""}${shiftRate.toFixed(1)}°/hr` },
    { label: "trend t / p", value: `t=${reg.t.toFixed(2)}, p≈${reg.p.toFixed(3)}` },
    { label: "half-life", value: ou.halfLifeMin ? `${ou.halfLifeMin.toFixed(1)} min` : count >= 20 ? "—  (not reverting)" : "n<20" },
    { label: "swing period", value: periodMin ? `${periodMin.toFixed(1)} min` : count >= 10 ? "—" : "n<10" },
    ...(hurst != null ? [{ label: "Hurst (R/S)", value: hurst.toFixed(2) }] : []),
    { label: "speed σ", value: base.speedStd != null ? `${base.speedStd.toFixed(2)}` : "—" },
  ];

  return {
    ...base,
    type, typeLabel: TYPE_LABEL[type],
    meanDir, meanCompass: compass16(meanDir), dirStd, amplitude,
    fromBearing: ((meanDir + minDev) % 360 + 360) % 360,
    toBearing: ((meanDir + maxDev) % 360 + 360) % 360,
    startBearing: dirs[0], endBearing: dirs[count - 1],
    netShift, shiftRate, trendT: reg.t, trendP: reg.p,
    halfLifeMin: ou.halfLifeMin, meanReverting, periodMin, reversals, hurst,
    series, math,
  };
}

/** Split the recent samples into data-determined regimes (oldest → newest). */
export function detectRegimes(samples: WindSample[], opts: RegimeOpts): Regime[] {
  const sorted = samples.slice().sort((a, b) => a.t - b.t);
  const dirPts = sorted.filter((s) => s.dir != null) as { t: number; dir: number }[];
  if (dirPts.length < 5) return [summarizeRegime(sorted, opts)];

  const uw = unwrap(dirPts.map((p) => p.dir));
  const cps = detectChangePoints(uw, 5, 3, 2); // indices into dirPts
  const bounds = [0, ...cps, dirPts.length];

  const regimes: Regime[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const t0 = dirPts[bounds[i]].t;
    const t1 = i === bounds.length - 2 ? Infinity : dirPts[bounds[i + 1]].t;
    const slice = sorted.filter((s) => s.t >= t0 && (t1 === Infinity ? true : s.t < t1));
    if (slice.length) regimes.push(summarizeRegime(slice, opts));
  }
  return regimes;
}

const r = (n: number) => Math.round(n);

/** Plain-English readout for one regime. */
export function glossesFor(a: Regime, unitLabel: string): string[] {
  if (a.type === "calm") {
    return [`Calm — mean ${a.speedMean?.toFixed(1)} ${unitLabel}. Direction is unreliable below ~1 ${unitLabel}, so no shift read.`];
  }
  if (a.type === "insufficient") {
    return [`Settling — only ${a.count} reading${a.count === 1 ? "" : "s"} (need ≥5 / ~15 min before calling a shift).`];
  }
  const out: string[] = [];
  const half = (a.amplitude / 2).toFixed(0);

  if (a.type === "veering" || a.type === "backing") {
    const side = a.type === "veering" ? "right / clockwise" : "left / counter-clockwise";
    out.push(
      `Persistent ${side} shift: ${compass16(a.startBearing)} ${r(a.startBearing!)}° → ${compass16(a.endBearing)} ${r(a.endBearing!)}°, ${a.netShift > 0 ? "+" : ""}${r(a.netShift)}° over ${a.durationMin.toFixed(0)} min (${a.shiftRate > 0 ? "+" : ""}${r(a.shiftRate)}°/hr). Statistically real (t=${a.trendT.toFixed(1)}, p≈${a.trendP.toFixed(2)}) — favour the new side.`,
    );
  } else if (a.type === "oscillating") {
    out.push(
      `Oscillating ±${half}° around ${a.meanCompass} (${r(a.meanDir!)}°), ${compass16(a.fromBearing)} ${r(a.fromBearing!)}° to ${compass16(a.toBearing)} ${r(a.toBearing!)}°. No real trend (t=${a.trendT.toFixed(1)}).`,
    );
    if (a.halfLifeMin) out.push(`Mean-reverting: a header decays halfway back in ~${a.halfLifeMin.toFixed(1)} min${a.periodMin ? `, full swings ~${a.periodMin.toFixed(0)} min` : ""}. Play the shifts.`);
    else if (a.periodMin) out.push(`Swinging through its mean about every ${(a.periodMin / 2).toFixed(0)} min (${a.reversals} reversals).`);
  } else {
    out.push(`Steady from ${a.meanCompass} (${r(a.meanDir!)}°), holding within ±${half}° for ${a.durationMin.toFixed(0)} min.`);
  }

  if (a.hurst != null) {
    const tag = a.hurst < 0.45 ? "choppy / mean-reverting" : a.hurst > 0.55 ? "trending / persistent" : "near random-walk";
    out.push(`Hurst ${a.hurst.toFixed(2)} — ${tag} (0.5 = coin-flip).`);
  }

  if (a.speedMean != null) {
    const trend =
      Math.abs(a.speedRate) < 0.5
        ? "holding"
        : a.speedRate > 0
          ? `building +${a.speedRate.toFixed(1)} ${unitLabel}/hr`
          : `easing ${a.speedRate.toFixed(1)} ${unitLabel}/hr`;
    out.push(
      `Speed ${trend}: mean ${a.speedMean.toFixed(1)} ${unitLabel}, lull ${a.speedMin!.toFixed(1)} / puff ${a.speedMax!.toFixed(1)}${a.gustFactor ? `, gust factor ${a.gustFactor.toFixed(1)}` : ""}.`,
    );
  }
  return out;
}
