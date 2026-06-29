// History analytics for the Patterns tab. Pure functions over normalized
// samples. "Cool, not heavy": readable heuristics, gracefully thin when the
// table is young. Speeds arrive already in the display unit; °F / inHg as-is.

import { compass16 } from "./oscillation";

export type Unit = "kts" | "mph";

export interface PSample {
  t: number;
  speed: number | null; // display unit (kts|mph)
  gust: number | null;
  dir: number | null;
  temp: number | null; // °F
  baro: number | null; // inHg
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** Hour-of-day (0–23) in US Central, the club's local time. */
export function ctHour(t: number): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    hour12: false,
  }).format(new Date(t));
  return Number(h) % 24;
}

/** Central-time calendar-day key (YYYY-MM-DD) for grouping. */
function ctDayKey(t: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(t));
}

// ---- wind rose ------------------------------------------------------------

export interface RoseBin {
  dir: number; // sector center, degrees
  label: string; // compass16
  total: number; // readings in this sector (excl. calm)
  bands: number[]; // count per speed band
}
export interface WindRose {
  bins: RoseBin[];
  bands: { label: string; min: number; color: string }[];
  max: number; // largest bin total (for scaling)
  n: number; // directional readings considered
  calmPct: number;
  prevailing: string | null;
}

// light → strong
const BAND_COLORS = ["#38bdf8", "#22d3ee", "#34d399", "#f59e0b", "#fb7185"];

export function windRose(samples: PSample[], unit: Unit): WindRose {
  const cuts =
    unit === "kts"
      ? [
          { label: "<5", min: 0 },
          { label: "5–10", min: 5 },
          { label: "10–15", min: 10 },
          { label: "15–20", min: 15 },
          { label: "20+", min: 20 },
        ]
      : [
          { label: "<6", min: 0 },
          { label: "6–12", min: 6 },
          { label: "12–18", min: 12 },
          { label: "18–24", min: 18 },
          { label: "24+", min: 24 },
        ];
  const bands = cuts.map((b, i) => ({ ...b, color: BAND_COLORS[i] }));
  const calmCut = unit === "kts" ? 1 : 1.2;

  const bins: RoseBin[] = Array.from({ length: 16 }, (_, i) => ({
    dir: i * 22.5,
    label: compass16(i * 22.5),
    total: 0,
    bands: new Array(bands.length).fill(0),
  }));

  let calm = 0;
  let n = 0;
  for (const s of samples) {
    if (s.dir == null || s.speed == null) continue;
    n++;
    if (s.speed < calmCut) {
      calm++;
      continue;
    }
    const bi = Math.round(((((s.dir % 360) + 360) % 360) / 22.5)) % 16;
    let band = 0;
    for (let k = bands.length - 1; k >= 0; k--) {
      if (s.speed >= bands[k].min) {
        band = k;
        break;
      }
    }
    bins[bi].bands[band]++;
    bins[bi].total++;
  }
  const max = Math.max(1, ...bins.map((b) => b.total));
  let prevailing: string | null = null;
  let best = 0;
  for (const b of bins) if (b.total > best) (best = b.total), (prevailing = b.label);
  return { bins, bands, max, n, calmPct: n ? (calm / n) * 100 : 0, prevailing: best > 0 ? prevailing : null };
}

// ---- records & extremes ---------------------------------------------------

export interface Extreme {
  v: number;
  t: number;
}
export interface DayAgg {
  day: string;
  avg: number;
  peak: number;
}
export interface Records {
  n: number;
  days: number;
  maxGust: Extreme | null;
  maxSustained: Extreme | null;
  windiestDay: DayAgg | null;
  calmestDay: DayAgg | null;
  longestSteadyMin: number | null;
}

export function records(samples: PSample[]): Records {
  const withSpeed = samples.filter((s) => s.speed != null) as (PSample & { speed: number })[];
  const n = withSpeed.length;
  if (!n) {
    return {
      n: 0, days: 0, maxGust: null, maxSustained: null,
      windiestDay: null, calmestDay: null, longestSteadyMin: null,
    };
  }

  let maxGust: Extreme | null = null;
  let maxSustained: Extreme | null = null;
  for (const s of withSpeed) {
    if (maxSustained == null || s.speed > maxSustained.v) maxSustained = { v: s.speed, t: s.t };
    if (s.gust != null && (maxGust == null || s.gust > maxGust.v)) maxGust = { v: s.gust, t: s.t };
  }

  // daily aggregates
  const byDay = new Map<string, number[]>();
  for (const s of withSpeed) {
    const k = ctDayKey(s.t);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(s.speed);
  }
  const dayAggs: DayAgg[] = [...byDay.entries()].map(([day, sp]) => ({
    day,
    avg: mean(sp),
    peak: Math.max(...sp),
  }));
  let windiestDay: DayAgg | null = null;
  let calmestDay: DayAgg | null = null;
  for (const d of dayAggs) {
    if (windiestDay == null || d.avg > windiestDay.avg) windiestDay = d;
    if (calmestDay == null || d.avg < calmestDay.avg) calmestDay = d;
  }

  // longest "steady" stretch: consecutive readings whose direction stays within
  // a 30° band (gaps > 12 min break the run).
  const dirPts = samples.filter((s) => s.dir != null) as (PSample & { dir: number })[];
  let longest = 0;
  let runStart = 0;
  let runMinDir = 0;
  let runMaxDir = 0;
  for (let i = 0; i < dirPts.length; i++) {
    if (i === 0) {
      runStart = dirPts[i].t;
      runMinDir = runMaxDir = dirPts[i].dir;
      continue;
    }
    const gap = dirPts[i].t - dirPts[i - 1].t;
    const within =
      gap <= 12 * 60_000 &&
      Math.max(runMaxDir, dirPts[i].dir) - Math.min(runMinDir, dirPts[i].dir) <= 30;
    if (within) {
      runMinDir = Math.min(runMinDir, dirPts[i].dir);
      runMaxDir = Math.max(runMaxDir, dirPts[i].dir);
    } else {
      longest = Math.max(longest, dirPts[i - 1].t - runStart);
      runStart = dirPts[i].t;
      runMinDir = runMaxDir = dirPts[i].dir;
    }
  }
  if (dirPts.length) longest = Math.max(longest, dirPts[dirPts.length - 1].t - runStart);

  return {
    n,
    days: dayAggs.length,
    maxGust,
    maxSustained,
    windiestDay,
    calmestDay,
    longestSteadyMin: longest > 0 ? longest / 60_000 : null,
  };
}

// ---- thermal-build heuristic ----------------------------------------------

export interface ThermalDay {
  day: string;
  morningMean: number;
  afternoonMean: number;
  build: number; // afternoon − morning
  afternoonDir: string;
  dirSpread: number; // circular σ-ish, smaller = steadier
}
export interface Thermals {
  enough: boolean;
  buildKtsThreshold: number;
  days: ThermalDay[]; // flagged thermal-build days, most recent first
  scannedDays: number;
}

function circSpread(dirs: number[]): number {
  if (dirs.length < 2) return 0;
  const D2R = Math.PI / 180;
  let s = 0;
  let c = 0;
  for (const d of dirs) {
    s += Math.sin(d * D2R);
    c += Math.cos(d * D2R);
  }
  s /= dirs.length;
  c /= dirs.length;
  const R = Math.sqrt(s * s + c * c);
  if (R >= 1) return 0;
  return Math.sqrt(-2 * Math.log(R)) * (180 / Math.PI);
}
function circMean(dirs: number[]): number {
  const D2R = Math.PI / 180;
  let s = 0;
  let c = 0;
  for (const d of dirs) {
    s += Math.sin(d * D2R);
    c += Math.cos(d * D2R);
  }
  return ((Math.atan2(s, c) * (180 / Math.PI)) + 360) % 360;
}

/**
 * A lake thermal reads as a calm-ish morning giving way to a steadier,
 * stronger afternoon from a consistent direction. We flag days where the
 * afternoon (12–18h CT) mean beats the morning (6–11h CT) mean by a threshold
 * and the afternoon direction is reasonably steady.
 */
export function thermals(samples: PSample[], unit: Unit): Thermals {
  const buildKtsThreshold = unit === "kts" ? 4 : 4.6;
  const byDay = new Map<string, PSample[]>();
  for (const s of samples) {
    const k = ctDayKey(s.t);
    (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(s);
  }
  const flagged: ThermalDay[] = [];
  for (const [day, ss] of byDay) {
    const morning = ss.filter((s) => {
      const h = ctHour(s.t);
      return h >= 6 && h < 11 && s.speed != null;
    });
    const afternoon = ss.filter((s) => {
      const h = ctHour(s.t);
      return h >= 12 && h < 18 && s.speed != null;
    });
    if (morning.length < 3 || afternoon.length < 3) continue;
    const mMean = mean(morning.map((s) => s.speed!));
    const aMean = mean(afternoon.map((s) => s.speed!));
    const build = aMean - mMean;
    const aDirs = afternoon.filter((s) => s.dir != null).map((s) => s.dir!);
    const spread = circSpread(aDirs);
    if (build >= buildKtsThreshold && aDirs.length >= 3 && spread <= 35) {
      flagged.push({
        day,
        morningMean: mMean,
        afternoonMean: aMean,
        build,
        afternoonDir: compass16(circMean(aDirs)),
        dirSpread: spread,
      });
    }
  }
  flagged.sort((a, b) => (a.day < b.day ? 1 : -1));
  return { enough: byDay.size >= 1, buildKtsThreshold, days: flagged, scannedDays: byDay.size };
}

// ---- barometer lead/lag ---------------------------------------------------

export interface BaroLag {
  ok: boolean;
  reason: string;
  bestLagMin: number | null; // negative ⇒ pressure change leads wind
  bestR: number | null;
  series: { lagMin: number; r: number }[];
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

/**
 * Does a falling barometer precede a wind change? We resample to a fixed grid,
 * correlate the pressure tendency (Δbaro) against wind speed at a range of
 * lags, and report the lag with the strongest relationship. Negative lag means
 * the pressure move comes BEFORE the wind — an early-warning signal.
 */
export function baroLag(samples: PSample[]): BaroLag {
  const stepMin = 15;
  const step = stepMin * 60_000;
  const pts = samples
    .filter((s) => s.baro != null && s.speed != null)
    .sort((a, b) => a.t - b.t);
  if (pts.length < 24) {
    return { ok: false, reason: "Needs several hours of pressure + wind data.", bestLagMin: null, bestR: null, series: [] };
  }

  // resample onto a uniform grid (nearest within half a step)
  const t0 = pts[0].t;
  const t1 = pts[pts.length - 1].t;
  const grid: { baro: number; wind: number }[] = [];
  let j = 0;
  for (let t = t0; t <= t1; t += step) {
    while (j < pts.length - 1 && Math.abs(pts[j + 1].t - t) <= Math.abs(pts[j].t - t)) j++;
    if (Math.abs(pts[j].t - t) <= step) grid.push({ baro: pts[j].baro!, wind: pts[j].speed! });
    else grid.push({ baro: NaN, wind: NaN });
  }
  // pressure tendency
  const dBaro = grid.map((g, i) => (i === 0 ? NaN : g.baro - grid[i - 1].baro));
  const wind = grid.map((g) => g.wind);

  const maxLagSteps = Math.min(12, Math.floor(grid.length / 3)); // up to ±3h
  const series: { lagMin: number; r: number }[] = [];
  let bestR = 0;
  let bestLag: number | null = null;
  for (let lag = -maxLagSteps; lag <= maxLagSteps; lag++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < grid.length; i++) {
      const k = i + lag; // wind at i+lag vs dBaro at i
      if (k < 0 || k >= grid.length) continue;
      if (Number.isNaN(dBaro[i]) || Number.isNaN(wind[k])) continue;
      xs.push(dBaro[i]);
      ys.push(wind[k]);
    }
    if (xs.length < 8) continue;
    const r = pearson(xs, ys);
    series.push({ lagMin: lag * stepMin, r });
    if (Math.abs(r) > Math.abs(bestR)) {
      bestR = r;
      bestLag = lag * stepMin;
    }
  }
  if (!series.length || Math.abs(bestR) < 0.2) {
    return { ok: false, reason: "No clear pressure→wind relationship yet.", bestLagMin: null, bestR: null, series };
  }
  return { ok: true, reason: "", bestLagMin: bestLag, bestR, series };
}
