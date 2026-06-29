// Macro regime detection for the Log — now compute-on-read.
//
// We re-segment a trailing window of raw readings into data-determined regimes
// (structural breaks) and keep the significant ones. The route runs this FRESH on
// every request from the 360-day raw readings, so the Log is always a single
// clean, non-overlapping timeline. (It used to accumulate one row per cron run
// keyed on start_t, which piled up overlapping near-duplicates of the same
// period — that whole write path is gone.)
//
// The data picks the periods, not us — same principle as the live Trends tab,
// just over a longer horizon and filtered to what's statistically and practically
// significant.

import { detectRegimes, glossesFor, type Regime, type WindSample } from "./oscillation";
import { type HistoryRow, type RegimeRow } from "./db";

const MPH_TO_KNOTS = 0.868976;

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export interface RegimeLogConfig {
  minSignificance: number; // floor to surface (0..1)
  minDurationMin: number;
  minSamples: number;
}

export function regimeLogConfig(): RegimeLogConfig {
  return {
    minSignificance: envNum("REGIME_MIN_SIG", 0.3),
    minDurationMin: envNum("REGIME_MIN_MIN", 20),
    minSamples: envNum("REGIME_MIN_N", 8),
  };
}

const num = (r: HistoryRow, k: string): number | null =>
  typeof r[k] === "number" ? (r[k] as number) : null;
const kts = (mph: number | null): number | null => (mph == null ? null : mph * MPH_TO_KNOTS);

function toRow(a: Regime, closed: boolean, now: number): RegimeRow {
  return {
    start_t: Math.round(a.startT),
    end_t: Math.round(a.endT),
    closed: closed ? 1 : 0,
    type: a.type,
    type_label: a.typeLabel,
    confidence: a.confidence,
    significance: a.significance,
    duration_min: a.durationMin,
    count: a.count,
    mean_dir: a.dirUndefined ? null : a.meanDir,
    amplitude: a.amplitude,
    net_shift: a.netShift,
    shift_rate: a.shiftRate,
    trend_t: a.trendT,
    trend_p: a.trendP,
    half_life_min: a.halfLifeMin,
    period_min: a.periodMin,
    hurst: a.hurst,
    speed_mean: a.speedMean,
    speed_min: a.speedMin,
    speed_max: a.speedMax,
    gust_factor: a.gustFactor,
    speed_rate: a.speedRate,
    gloss: glossesFor(a, "kts").join(" "),
    updated_at: now,
  };
}

/**
 * Detect macro regimes over the given readings and return the significant,
 * non-edge ones as rows, newest first. Pure — no DB writes, no accumulation.
 * The oldest regime is dropped: its left edge is the window boundary, not a real
 * break, so it isn't a meaningful structural segment.
 */
export function detectLoggableRegimes(
  rows: HistoryRow[],
  cfg: RegimeLogConfig = regimeLogConfig(),
  now: number = Date.now(),
): RegimeRow[] {
  if (rows.length < cfg.minSamples * 2) return [];

  const samples: WindSample[] = rows.map((r) => ({
    t: r.observed_at,
    dir: num(r, "wind_dir"),
    speed: kts(num(r, "wind_speed")),
    gust: kts(num(r, "wind_gust_2min")),
  }));

  // thr a touch looser than the live tab; minSeg / maxDepth / min-duration all
  // self-scale to the requested window inside detectRegimes.
  const regimes = detectRegimes(samples, {
    calmCutoff: 1.5,
    withHurst: true,
    cp: { thr: 2.5 },
  });

  const out: RegimeRow[] = [];
  for (let i = 0; i < regimes.length; i++) {
    if (i === 0) continue; // window-edge regime, not a real structural break
    const a = regimes[i];
    const isOpen = i === regimes.length - 1; // newest = still forming → "live"
    if (a.type === "calm" || a.type === "insufficient" || a.type === "steady") continue;
    if (a.significance < cfg.minSignificance) continue;
    if (a.durationMin < cfg.minDurationMin) continue;
    if (a.count < cfg.minSamples) continue;
    out.push(toRow(a, !isOpen, now));
  }
  return out.reverse(); // newest first, matching the old API order
}
