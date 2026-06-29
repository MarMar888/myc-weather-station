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
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
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

/**
 * Recursive binary segmentation on a continuous series; returns split indices.
 * A split must be both statistically detectable (Welch t ≥ thr) AND practically
 * meaningful (mean change ≥ minEffect, in the series' own units — degrees here).
 * The effect gate is what stops boundary jitter from spawning near-duplicate
 * regimes run after run.
 */
function detectChangePoints(
  vals: number[],
  minSeg = 5,
  thr = 3,
  maxDepth = 2,
  minEffect = 15,
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
    const lhs = mean(vals.slice(lo, bestK)), rhs = mean(vals.slice(bestK, hi));
    if (Math.abs(rhs - lhs) < minEffect) return; // statistically real but tactically trivial
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
  amplitude: number; // robust 10–90 pct band of deviation (headline ±band)
  ampP2P: number; // raw peak-to-peak (outlier-sensitive; shown in "the math" only)
  dirUndefined: boolean; // circular σ so high the mean is meaningless (light, swirly air)
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
  // tactical "now & next" (meaningful for the current/live regime)
  nowBearing: number | null; // latest actual direction reading
  nowPos: "ccw" | "mid" | "cw" | null; // where "now" sits inside the swing
  proj15: number | null; // simple trend extrapolation, 15 min out (sig. trend only)
  proj30: number | null;
  // significance / "conviction": 0..1, blends sample confidence, effect size,
  // and statistical realness. Used to decide which regimes are worth logging.
  significance: number;
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
  // Change-point detector tuning. Any field left unset is self-scaled from the
  // window span in detectRegimes (longer windows ⇒ more depth, coarser segments).
  cp?: {
    minSeg?: number;
    thr?: number;
    maxDepth?: number;
    minEffect?: number; // ° mean change required to accept a split
    minSegMin?: number; // minimum regime duration (min); shorter ones get merged
  };
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
    meanDir: null, meanCompass: "—", dirStd: 0, amplitude: 0, ampP2P: 0, dirUndefined: false,
    fromBearing: null, toBearing: null, startBearing: null, endBearing: null,
    netShift: 0, shiftRate: 0, trendT: 0, trendP: 1,
    halfLifeMin: null, meanReverting: null, periodMin: null, reversals: 0, hurst: null,
    speedMean: null, speedMin: null, speedMax: null, gustMax: null, gustFactor: null,
    speedStd: null, speedRate: 0,
    nowBearing: null, nowPos: null, proj15: null, proj30: null, significance: 0,
    series: [], math: [],
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
  const dirUndefined = dirStd > 60; // mean direction is meaningless in this much scatter
  const uw = unwrap(dirs);
  const muU = mean(uw);
  const centered = uw.map((v) => v - muU);
  const minDev = Math.min(...centered), maxDev = Math.max(...centered);
  const ampP2P = maxDev - minDev; // raw peak-to-peak: one excursion blows it up, grows with window
  // Robust amplitude: 10th–90th percentile band of the centered deviations. Bounded
  // by the bulk of the data, stable across window length — this is the headline ±band.
  const sortedDev = [...centered].sort((a, b) => a - b);
  const pctl = (p: number) =>
    sortedDev[Math.min(sortedDev.length - 1, Math.max(0, Math.round(p * (sortedDev.length - 1))))];
  const amplitude = Math.max(0, pctl(0.9) - pctl(0.1));

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

  // classify. A "trend" on top of >60° circular scatter is an unwrapping artifact,
  // not a shift you can favour — swirly air is never called veering/backing.
  const sigShift = count >= 10 && !dirUndefined && Math.abs(reg.t) > 2 && Math.abs(netShift) > 8;
  let type: RegimeType;
  if (sigShift) type = netShift > 0 ? "veering" : "backing";
  else if (amplitude < 8) type = "steady";
  else type = "oscillating";

  // significance ("conviction"), 0..1. Honest in light air: a big swing in 1.5 kt
  // is meaningless (you can't even sail it), so wind speed gates everything. For
  // oscillators we reward a *clean, periodic, mean-reverting* swing — not a big
  // swirly range. For trends we require both statistical and practical shift.
  const speedW = clamp01(((base.speedMean ?? 0) - 2) / 4); // 0 at ≤2, full credit at ≥6 (display unit)
  const confW = count >= 20 ? 1 : count >= 10 ? 0.7 : 0.4;
  const hasPeriod = periodMin != null ? 1 : 0;
  const ouW = meanReverting && ou.halfLifeMin != null ? 1 : 0;
  const coherence = 0.5 * hasPeriod + 0.5 * ouW;
  const trendReal = Math.min(1, Math.abs(reg.t) / 4) * Math.min(1, Math.abs(netShift) / 20);
  const effScore = Math.min(1, amplitude / 40); // amplitude = robust band
  const significance =
    type === "veering" || type === "backing"
      ? speedW * confW * (0.7 * trendReal + 0.3 * effScore)
      : type === "oscillating"
        ? speedW * confW * (0.6 * coherence + 0.4 * effScore)
        : 0; // steady / calm / insufficient → not significant

  // tactical "now & next": where the latest reading sits in the swing, and a
  // plain trend extrapolation (only when the trend is statistically real).
  const nowDev = centered[count - 1];
  const frac = ampP2P > 0 ? (nowDev - minDev) / ampP2P : 0.5; // position within the full swing
  const nowPos: "ccw" | "mid" | "cw" = frac > 0.66 ? "cw" : frac < 0.34 ? "ccw" : "mid";
  const projAt = (mins: number) => (((uw[count - 1] + reg.slope * mins * 60_000) % 360) + 360) % 360;
  const proj15 = sigShift ? projAt(15) : null;
  const proj30 = sigShift ? projAt(30) : null;

  const series = dirPts.map((p, i) => ({
    t: p.t,
    dev: centered[i],
    trend: reg.intercept + reg.slope * times[i] - muU,
  }));

  const math: { label: string; value: string }[] = [
    { label: "samples (n)", value: `${count}` },
    { label: "mean dir", value: dirUndefined ? "swirly / undefined" : `${Math.round(meanDir)}° (${compass16(meanDir)})` },
    { label: "circular σ", value: `${dirStd.toFixed(1)}°` },
    { label: "amp band / p-p", value: `±${(amplitude / 2).toFixed(0)}° · ${ampP2P.toFixed(0)}° p-p` },
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
    meanDir, meanCompass: compass16(meanDir), dirStd, amplitude, ampP2P, dirUndefined,
    fromBearing: ((meanDir + minDev) % 360 + 360) % 360,
    toBearing: ((meanDir + maxDev) % 360 + 360) % 360,
    startBearing: dirs[0], endBearing: dirs[count - 1],
    netShift, shiftRate, trendT: reg.t, trendP: reg.p,
    halfLifeMin: ou.halfLifeMin, meanReverting, periodMin, reversals, hurst,
    nowBearing: dirs[count - 1], nowPos, proj15, proj30, significance,
    series, math,
  };
}

const MERGE_DIR_DEG = 20; // adjacent same-type regimes whose means sit within this collapse to one

/**
 * Collapse a contiguous list of sample-slices: repeatedly merge the single most
 * warranted adjacent pair — either same-type with near-identical mean (a
 * "look-alike"), or one too short to stand alone (absorbed into its closest
 * neighbour). Runs to convergence. This is the safety net that guarantees no two
 * adjacent near-duplicate regimes survive — the root cause of the old Log mess.
 */
function mergeSlices(slices: WindSample[][], opts: RegimeOpts, minSegMin: number): WindSample[][] {
  let cur = slices;
  for (let pass = 0; pass < 24 && cur.length > 1; pass++) {
    const sum = cur.map((s) => summarizeRegime(s, opts));
    let bestI = -1, bestCost = Infinity;
    for (let i = 0; i < cur.length - 1; i++) {
      const a = sum[i], b = sum[i + 1];
      const dmean = a.meanDir != null && b.meanDir != null ? Math.abs(angDiff(a.meanDir, b.meanDir)) : 180;
      const lookAlike = a.type === b.type && dmean <= MERGE_DIR_DEG;
      const tooShort = a.durationMin < minSegMin || b.durationMin < minSegMin;
      if (!lookAlike && !tooShort) continue;
      if (dmean < bestCost) { bestCost = dmean; bestI = i; } // merge the most-similar eligible pair
    }
    if (bestI < 0) break;
    cur = [...cur.slice(0, bestI), cur[bestI].concat(cur[bestI + 1]), ...cur.slice(bestI + 2)];
  }
  return cur;
}

/** Split the recent samples into data-determined regimes (oldest → newest). */
export function detectRegimes(samples: WindSample[], opts: RegimeOpts): Regime[] {
  const sorted = samples.slice().sort((a, b) => a.t - b.t);
  const dirPts = sorted.filter((s) => s.dir != null) as { t: number; dir: number }[];
  if (dirPts.length < 5) return [summarizeRegime(sorted, opts)];

  // Self-scale the detector to the window span unless the caller pins a value: a
  // longer window gets more recursion depth (so more regimes are *possible*) but a
  // coarser minimum segment and a longer min-duration, so a quiet 12h stretch never
  // shatters into noise.
  const spanH = Math.max((dirPts[dirPts.length - 1].t - dirPts[0].t) / 3_600_000, 0.01);
  const perHour = dirPts.length / spanH;
  const cp = opts.cp ?? {};
  const minSeg = cp.minSeg ?? Math.max(5, Math.round(perHour * 0.5)); // ~½h of samples
  const thr = cp.thr ?? 3;
  const maxDepth = cp.maxDepth ?? Math.max(2, Math.min(6, Math.ceil(Math.log2(Math.max(2, spanH))) + 2));
  const minEffect = cp.minEffect ?? 15;
  const minSegMin = cp.minSegMin ?? (spanH > 6 ? 45 : 20);

  const uw = unwrap(dirPts.map((p) => p.dir));
  const cps = detectChangePoints(uw, minSeg, thr, maxDepth, minEffect); // indices into dirPts
  const bounds = [0, ...cps, dirPts.length];

  const slices: WindSample[][] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const t0 = dirPts[bounds[i]].t;
    const t1 = i === bounds.length - 2 ? Infinity : dirPts[bounds[i + 1]].t;
    const slice = sorted.filter((s) => s.t >= t0 && (t1 === Infinity ? true : s.t < t1));
    if (slice.length) slices.push(slice);
  }

  return mergeSlices(slices, opts, minSegMin).map((s) => summarizeRegime(s, opts));
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
    if (a.dirUndefined) {
      out.push(
        `Swirly / undefined — circular σ ${a.dirStd.toFixed(0)}°, swinging across more than half the compass around a nominal ${a.meanCompass}. Light, shifty air; no reliable mean to play.`,
      );
    } else {
      out.push(
        `Oscillating ±${half}° around ${a.meanCompass} (${r(a.meanDir!)}°), ${compass16(a.fromBearing)} ${r(a.fromBearing!)}° to ${compass16(a.toBearing)} ${r(a.toBearing!)}°. No real trend (t=${a.trendT.toFixed(1)}).`,
      );
      if (a.halfLifeMin) out.push(`Mean-reverting: a header decays halfway back in ~${a.halfLifeMin.toFixed(1)} min${a.periodMin ? `, full swings ~${a.periodMin.toFixed(0)} min` : ""}. Play the shifts.`);
      else if (a.periodMin) out.push(`Swinging through its mean about every ${(a.periodMin / 2).toFixed(0)} min (${a.reversals} reversals).`);
    }
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

/**
 * Course-free tactical "now & next" for the live regime: where the wind sits in
 * its swing right now, and the higher-odds next move. The projection is a plain
 * extrapolation of the already-fitted trend (not a forecast model) and only
 * appears when that trend is statistically real.
 */
export function tacticalReadout(a: Regime): { now: string; next: string } | null {
  if (a.type === "calm" || a.type === "insufficient" || a.nowBearing == null || a.meanDir == null) {
    return null;
  }
  if (a.dirUndefined && a.type !== "veering" && a.type !== "backing") {
    return {
      now: `Now ${compass16(a.nowBearing)} ${r(a.nowBearing)}° — but direction is swirling across the compass (σ ${a.dirStd.toFixed(0)}°).`,
      next: `Too shifty to commit to a side — wait for the breeze to fill and settle before playing it.`,
    };
  }
  const posWord =
    a.nowPos === "cw"
      ? "near the right (clockwise) edge of the swing"
      : a.nowPos === "ccw"
        ? "near the left (counter-clockwise) edge of the swing"
        : "mid-swing";
  const now = `Now ${compass16(a.nowBearing)} ${r(a.nowBearing)}° — ${posWord} (mean ${r(a.meanDir)}°).`;

  let next: string;
  if (a.type === "veering" || a.type === "backing") {
    const side = a.type === "veering" ? "right" : "left";
    next =
      a.proj15 != null && a.proj30 != null
        ? `If the trend holds → ~${compass16(a.proj15)} ${r(a.proj15)}° in 15 min, ~${compass16(a.proj30)} ${r(a.proj30)}° in 30 min. Favour the new (${side}) side.`
        : `Shifting ${side} — favour the new side.`;
  } else if (a.type === "oscillating") {
    if (a.nowPos === "mid") {
      next = `Mid-swing — the next move could break either way around ${r(a.meanDir)}°.`;
    } else {
      const back = a.nowPos === "cw" ? "left / CCW" : "right / CW";
      const when = a.periodMin
        ? ` (~${r(a.periodMin / 2)} min back to mean)`
        : a.halfLifeMin
          ? ` (~${r(a.halfLifeMin)} min half-life)`
          : "";
      next = `At the edge — better odds the next move is a header back ${back} toward ${r(a.meanDir)}°${when}.`;
    }
  } else {
    next = `Holding ${compass16(a.meanDir)} ${r(a.meanDir)}° — no shift signalled.`;
  }
  return { now, next };
}
