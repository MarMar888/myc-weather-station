// Server-side macro regime logger.
//
// Re-segments the trailing ~2 days into data-determined regimes (structural
// breaks), scores each for significance ("conviction"), and persists the
// significant ones — so the Log accumulates a permanent record of the
// meaningful wind shifts, far beyond the rolling detection window.
//
// The data picks the periods, not us (same principle as the live Oscillation
// tab) — just over a longer horizon, tuned coarser, and filtered to what's
// statistically and practically significant.

import { detectRegimes, glossesFor, type Regime, type WindSample } from "./oscillation";
import { getHistory, upsertRegime, type HistoryRow, type RegimeRow } from "./db";

const MPH_TO_KNOTS = 0.868976;

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

export interface RegimeLogConfig {
  horizonHours: number; // detection lookback
  minSignificance: number; // floor to persist (0..1)
  minDurationMin: number;
  minSamples: number;
}

export function regimeLogConfig(): RegimeLogConfig {
  return {
    horizonHours: envNum("REGIME_HORIZON_H", 48),
    minSignificance: envNum("REGIME_MIN_SIG", 0.35),
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
    mean_dir: a.meanDir,
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

export interface RegimeLogResult {
  detected: number;
  logged: number;
}

/**
 * Detect macro regimes over the horizon and upsert the significant ones.
 * Never throws. The oldest regime in the window is skipped (its left edge is the
 * window boundary, not a real break, so its start drifts as the window slides);
 * it was already logged when it was interior.
 */
export async function runRegimeLog(): Promise<RegimeLogResult> {
  const cfg = regimeLogConfig();
  const now = Date.now();

  let rows: HistoryRow[];
  try {
    rows = await getHistory(cfg.horizonHours);
  } catch {
    return { detected: 0, logged: 0 };
  }
  if (rows.length < cfg.minSamples * 2) return { detected: 0, logged: 0 };

  const samples: WindSample[] = rows.map((r) => ({
    t: r.observed_at,
    dir: num(r, "wind_dir"),
    speed: kts(num(r, "wind_speed")),
    gust: kts(num(r, "wind_gust_2min")),
  }));

  // Coarser tuning than the live 3h window: larger minimum segment, more depth.
  const regimes = detectRegimes(samples, {
    calmCutoff: 1.5,
    withHurst: true,
    cp: { minSeg: 8, thr: 2.5, maxDepth: 5 },
  });

  let logged = 0;
  for (let i = 0; i < regimes.length; i++) {
    if (i === 0) continue; // window-edge regime: drifts, already logged earlier
    const a = regimes[i];
    const isOpen = i === regimes.length - 1; // newest = still forming
    if (a.type === "calm" || a.type === "insufficient" || a.type === "steady") continue;
    if (a.significance < cfg.minSignificance) continue;
    if (a.durationMin < cfg.minDurationMin) continue;
    if (a.count < cfg.minSamples) continue;
    try {
      await upsertRegime(toRow(a, !isOpen, now));
      logged++;
    } catch {
      /* one bad upsert shouldn't abort the rest */
    }
  }
  return { detected: regimes.length, logged };
}
