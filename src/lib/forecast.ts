// "What's next" — a plain-English, explainable wind forecast for sailors.
//
// No model, no ML: it blends a handful of cheap, legible signals and always
// degrades gracefully to "nothing to call" when the data is thin. Two horizons:
//   • near — the next 30–60 min (momentum of the current regime, or the next
//     header/lift for an oscillator)
//   • day  — a softer rest-of-day note from this station's own history
//     (recurring afternoon thermal, a leading barometer, or a multi-hour
//     directional walk that smells like a front)
//
// Speeds arrive already in the display unit; baro is inHg.

import { compass16, type Regime } from "./oscillation";
import { thermals, baroLag, ctHour, type PSample, type Unit } from "./patterns";

export interface Forecast {
  near: string;
  nearConfidence: "low" | "medium" | "high";
  day: string | null;
  basis: string[]; // which signals fired, for a "why" disclosure
}

const r = (n: number) => Math.round(n);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const conf = (score: number): Forecast["nearConfidence"] =>
  score >= 0.66 ? "high" : score >= 0.4 ? "medium" : "low";
const speedWeight = (v: number | null) => clamp01(((v ?? 0) - 2) / 4);

/** inHg/hr tendency of the barometer over the last `lookbackMin` minutes. */
function baroSlopePerHr(history: PSample[], now: number, lookbackMin = 90): number | null {
  const since = now - lookbackMin * 60_000;
  const pts = history.filter((s) => s.baro != null && s.t >= since) as (PSample & { baro: number })[];
  if (pts.length < 4) return null;
  const xs = pts.map((p) => p.t);
  const ys = pts.map((p) => p.baro);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) return null;
  return (sxy / sxx) * 3_600_000; // per ms → per hr
}

/** Most-common item in a list (first-seen wins ties). */
function modal(items: string[]): string | null {
  if (!items.length) return null;
  const counts = new Map<string, number>();
  let best = items[0], bestN = 0;
  for (const it of items) {
    const n = (counts.get(it) ?? 0) + 1;
    counts.set(it, n);
    if (n > bestN) { bestN = n; best = it; }
  }
  return best;
}

/**
 * Build the near-term + rest-of-day forecast from the current regime, the recent
 * regime sequence, and the day's worth of raw samples.
 */
export function forecastNext(
  current: Regime,
  recentRegimes: Regime[],
  history: PSample[],
  unit: Unit,
  now: number = Date.now(),
): Forecast {
  const basis: string[] = [];
  let near = "No clear near-term shift — current regime looks like it's holding.";
  let nearScore = 0.3;

  // ---- NEAR: 0) too light to sail ---------------------------------------------
  if (current.type === "calm") {
    near = "Too light to sail or read a shift — wait for the breeze to fill in.";
    nearScore = 0.2;
    basis.push("calm / light air");
  }
  // ---- NEAR: 1) momentum of a real trend -------------------------------------
  else if ((current.type === "veering" || current.type === "backing") && Math.abs(current.trendT) > 2) {
    const side = current.type === "veering" ? "right / clockwise" : "left / counter-clockwise";
    const sw = speedWeight(current.speedMean);
    nearScore = clamp01(Math.abs(current.trendT) / 4) * (0.4 + 0.6 * sw);
    if (current.proj30 != null) {
      near =
        `Shift is real and ${side} — if it holds, ~${compass16(current.proj30)} ${r(current.proj30)}° within 30 min. ` +
        `Favour the new side, but expect the rate to ease within the hour (winds rarely keep turning one way for long).`;
    } else {
      near = `Persistent ${side} shift underway — favour the new side; expect it to ease within the hour.`;
    }
    basis.push(`current ${current.type} trend (t=${current.trendT.toFixed(1)})`);
  }
  // ---- NEAR: 2) mean-reversion timing for an oscillator ----------------------
  else if (current.type === "oscillating") {
    if (current.dirUndefined) {
      near = "Light and swirly — direction is all over the compass. Wait for the breeze to fill and settle before reading a shift.";
      nearScore = 0.2;
      basis.push("swirly / undefined direction");
    } else if (current.meanDir != null) {
      const toMeanMin = current.periodMin != null ? current.periodMin / 2 : current.halfLifeMin ?? null;
      const resolved = toMeanMin != null && toMeanMin >= 10; // 3-min sampling can't resolve faster swings
      const sw = speedWeight(current.speedMean);
      if (current.nowPos === "mid") {
        near = `Mid-swing around ${r(current.meanDir)}° — the next break could go either way; play the next header as it comes${resolved ? ` (~${r(toMeanMin!)} min swings)` : ""}.`;
        nearScore = 0.35 + 0.2 * sw;
      } else {
        const back = current.nowPos === "cw" ? "left / CCW" : "right / CW";
        near =
          `At the ${current.nowPos === "cw" ? "right" : "left"} edge of the swing — better odds the next move is a header back ${back} toward ~${r(current.meanDir)}°` +
          (resolved ? ` in ~${r(toMeanMin!)} min.` : `, though swings are too fast to time at 3-min sampling.`);
        nearScore = (resolved ? 0.5 : 0.35) + 0.15 * sw;
      }
      basis.push(current.halfLifeMin ? `mean-reverting (half-life ${current.halfLifeMin.toFixed(1)} min)` : "oscillation timing");
    }
  }

  // ---- DAY: pick the most salient rest-of-day signal -------------------------
  let day: string | null = null;
  const hour = ctHour(now);

  // 5) multi-hour directional walk → frontal/synoptic smell (highest priority)
  const trend = recentRegimes.filter((g) => g.type === "veering" || g.type === "backing");
  if (trend.length >= 2) {
    const spanH = (trend[trend.length - 1].endT - trend[0].startT) / 3_600_000;
    const totalShift = trend.reduce((s, g) => s + g.netShift, 0);
    const sameWay = trend.every((g) => Math.sign(g.netShift) === Math.sign(totalShift));
    if (sameWay && spanH >= 4 && Math.abs(totalShift) >= 40) {
      const way = totalShift > 0 ? "veered (right)" : "backed (left)";
      const then = totalShift > 0 ? "back/left" : "veer/right";
      day = `Wind has ${way} steadily for ~${r(spanH)}h (${r(Math.abs(totalShift))}° total) — consistent with an approaching front. Expect the turn to continue, then a sharper clearing shift the other way (${then}).`;
      basis.push("multi-hour directional walk");
    }
  }

  // 3) recurring afternoon thermal (morning only, when it's still actionable)
  if (!day && hour >= 7 && hour <= 14) {
    const th = thermals(history, unit);
    if (th.days.length >= 2) {
      const dir = modal(th.days.map((d) => d.afternoonDir));
      const avgBuild = th.days.reduce((s, d) => s + d.build, 0) / th.days.length;
      day = `Afternoon thermal likely — on ${th.days.length} recent days like this it filled from ~${dir} and built about +${avgBuild.toFixed(0)} ${unit} after noon. Watch for it to steady up and clock in early afternoon.`;
      basis.push(`thermal prior (${th.days.length} days)`);
    }
  }

  // 4) leading barometer (early-warning heads-up)
  if (!day) {
    const bl = baroLag(history);
    const slope = baroSlopePerHr(history, now);
    if (bl.ok && bl.bestLagMin != null && bl.bestLagMin < 0 && slope != null && Math.abs(slope) > 0.02) {
      const dir = slope < 0 ? "falling" : "rising";
      day = `Barometer ${dir} (${slope > 0 ? "+" : ""}${slope.toFixed(2)} inHg/hr) — at this station pressure changes have tended to lead the wind by ~${r(Math.abs(bl.bestLagMin))} min, so a change may be coming.`;
      basis.push(`barometer leads wind by ${r(Math.abs(bl.bestLagMin))} min`);
    }
  }

  return { near, nearConfidence: conf(nearScore), day, basis };
}
