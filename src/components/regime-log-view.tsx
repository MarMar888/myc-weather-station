"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Loader } from "@/components/loader";

// Stored regimes are kts-native (server logs in knots), so the Log reads in kts
// regardless of the page unit toggle — the baked plain-English gloss is in kts.

interface RegimeRow {
  start_t: number;
  end_t: number;
  closed: number;
  type: string | null;
  type_label: string | null;
  confidence: string | null;
  significance: number | null;
  duration_min: number | null;
  count: number | null;
  mean_dir: number | null;
  amplitude: number | null;
  net_shift: number | null;
  shift_rate: number | null;
  trend_t: number | null;
  trend_p: number | null;
  half_life_min: number | null;
  period_min: number | null;
  hurst: number | null;
  speed_mean: number | null;
  speed_min: number | null;
  speed_max: number | null;
  gust_factor: number | null;
  speed_rate: number | null;
  gloss: string | null;
}

const LABEL = "text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--ink-faint)]";

const TYPE_COLOR: Record<string, string> = {
  oscillating: "var(--accent)",
  veering: "#f59e0b",
  backing: "#fb7185",
  building: "#f59e0b",
  easing: "#38bdf8",
  steady: "#10b981",
};
const CONF_CLS: Record<string, string> = {
  low: "border-amber-500/40 text-amber-600 dark:text-amber-300",
  medium: "border-sky-500/40 text-sky-600 dark:text-sky-300",
  high: "border-emerald-500/40 text-emerald-600 dark:text-emerald-300",
};

// quant gloss: trending (persistent) vs mean-reverting (oscillating)
function behaviour(r: RegimeRow): string {
  if (r.type === "veering" || r.type === "backing") return "Trending";
  if (r.type === "oscillating") return r.half_life_min ? "Mean-reverting" : "Oscillating";
  return r.type_label ?? "—";
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className={LABEL}>{label}</div>
      <div className="mt-0.5 font-mono text-sm tabular-nums text-[var(--ink)]">{value}</div>
    </div>
  );
}

function RegimeCard({ r, fmt }: { r: RegimeRow; fmt: Intl.DateTimeFormat }) {
  const color = (r.type && TYPE_COLOR[r.type]) || "var(--ink-faint)";
  const conviction = Math.round((r.significance ?? 0) * 100);
  return (
    <div className="rounded-lg border border-[var(--hairline)] bg-[var(--panel)] p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--ink)]">
          <span className="size-2 rounded-full" style={{ background: color }} />
          {r.type_label}
        </span>
        <span className="font-mono text-xs text-[var(--ink-soft)]">{behaviour(r)}</span>
        <span className="font-mono text-xs text-[var(--ink-faint)]">
          {fmt.format(new Date(r.start_t))} → {fmt.format(new Date(r.end_t))} CT · {(r.duration_min ?? 0).toFixed(0)} min
        </span>
        {r.closed === 0 && (
          <span className="rounded border border-[var(--accent)]/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--accent)]">
            live
          </span>
        )}
        {r.confidence && (
          <span className={`ml-auto rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${CONF_CLS[r.confidence] ?? ""}`}>
            {r.confidence}
          </span>
        )}
      </div>

      {/* conviction bar */}
      <div className="mt-3 flex items-center gap-3">
        <span className={LABEL}>Conviction</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--hairline)]">
          <div className="h-full rounded-full" style={{ width: `${conviction}%`, background: color }} />
        </div>
        <span className="font-mono text-xs tabular-nums text-[var(--ink)]">{conviction}</span>
      </div>

      {r.gloss && <p className="mt-3 text-sm leading-snug text-[var(--ink-soft)]">{r.gloss}</p>}

      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-[var(--hairline)] pt-3 sm:grid-cols-4">
        <Metric label="Net shift" value={`${(r.net_shift ?? 0) > 0 ? "+" : ""}${Math.round(r.net_shift ?? 0)}° · ${(r.shift_rate ?? 0) > 0 ? "+" : ""}${Math.round(r.shift_rate ?? 0)}°/hr`} />
        <Metric label="Amplitude" value={`±${((r.amplitude ?? 0) / 2).toFixed(0)}°`} />
        <Metric label="Half-life" value={r.half_life_min ? `${r.half_life_min.toFixed(1)} min` : "—"} />
        <Metric label="Hurst" value={r.hurst != null ? r.hurst.toFixed(2) : "—"} />
        <Metric label="Trend t" value={r.trend_t != null ? r.trend_t.toFixed(2) : "—"} />
        <Metric label="Mean dir" value={r.mean_dir != null ? `${Math.round(r.mean_dir)}°` : "—"} />
        <Metric label="Speed" value={r.speed_mean != null ? `${r.speed_mean.toFixed(1)} kt` : "—"} />
        <Metric label="Gust factor" value={r.gust_factor ? r.gust_factor.toFixed(1) : "—"} />
      </div>
    </div>
  );
}

type Floor = "all" | "notable" | "strong";
// Conviction is now speed-gated (light air ≈ 0), so floors sit a touch lower than
// the old amplitude-only scale.
const FLOORS: Record<Floor, number> = { all: 0, notable: 0.35, strong: 0.55 };

type Win = "48h" | "7d";
const WIN_HOURS: Record<Win, number> = { "48h": 48, "7d": 168 };

export function RegimeLogView() {
  const [rows, setRows] = useState<RegimeRow[]>([]);
  const [floor, setFloor] = useState<Floor>("all");
  const [win, setWin] = useState<Win>("48h");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/regimes?hours=${WIN_HOURS[win]}`, { cache: "no-store" });
      if (!res.ok) return;
      const j = await res.json();
      setRows(j.rows ?? []);
      setLoaded(true);
    } catch {
      /* keep last good */
    }
  }, [win]);

  useEffect(() => {
    load();
    const id = setInterval(load, 3 * 60_000);
    return () => clearInterval(id);
  }, [load]);

  const fmt = useMemo(
    () => new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    [],
  );

  const shown = useMemo(
    () => rows.filter((r) => (r.significance ?? 0) >= FLOORS[floor]),
    [rows, floor],
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <a
          href="/docs#oscillation"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--ink-faint)] transition-colors hover:text-[var(--accent)]"
        >
          How this works ↗
        </a>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            value={win}
            onValueChange={(v) => v && setWin(v as Win)}
            variant="outline"
            className="border-[var(--hairline)]"
          >
            <ToggleGroupItem value="48h" className="px-3 font-mono text-xs">48h</ToggleGroupItem>
            <ToggleGroupItem value="7d" className="px-3 font-mono text-xs">7d</ToggleGroupItem>
          </ToggleGroup>
          <ToggleGroup
            type="single"
            value={floor}
            onValueChange={(v) => v && setFloor(v as Floor)}
            variant="outline"
            className="border-[var(--hairline)]"
          >
            <ToggleGroupItem value="all" className="px-3 text-xs">All</ToggleGroupItem>
            <ToggleGroupItem value="notable" className="px-3 text-xs">Notable</ToggleGroupItem>
            <ToggleGroupItem value="strong" className="px-3 text-xs">Strong</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>

      <p className="mb-4 font-mono text-[11px] text-[var(--ink-faint)]">
        {shown.length} significant regime{shown.length === 1 ? "" : "s"} · clean, non-overlapping breaks recomputed from the last {win === "7d" ? "7 days" : "48 h"} · kts
      </p>

      {!loaded ? (
        <Loader minH={200} />
      ) : shown.length === 0 ? (
        <div className="flex min-h-[160px] items-center justify-center rounded-lg border border-dashed border-[var(--hairline)] px-4 text-center text-sm text-[var(--ink-faint)]">
          No significant regimes logged yet — they accumulate as the wind produces real, sustained shifts.
        </div>
      ) : (
        <div className="space-y-3">
          {shown.map((r) => (
            <RegimeCard key={r.start_t} r={r} fmt={fmt} />
          ))}
        </div>
      )}
    </div>
  );
}
