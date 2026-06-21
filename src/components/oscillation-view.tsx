"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  detectRegimes,
  glossesFor,
  summarizeRegime,
  tacticalReadout,
  type Regime,
  type RegimeType,
  type WindSample,
} from "@/lib/oscillation";

const MPH_TO_KNOTS = 0.868976;
type WindUnit = "kts" | "mph";
type Row = Record<string, number | string | null> & { observed_at: number };

const LABEL = "text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--ink-faint)]";
const AXIS = { stroke: "var(--axis)", fontSize: 10, fontFamily: "var(--font-geist-mono)" } as const;
const tooltipStyle = {
  background: "var(--panel-2)",
  border: "1px solid var(--hairline)",
  borderRadius: 6,
  color: "var(--ink)",
  fontSize: 12,
  fontFamily: "var(--font-geist-mono)",
} as const;

const TYPE_COLOR: Record<RegimeType, string> = {
  oscillating: "var(--accent)",
  veering: "#f59e0b",
  backing: "#fb7185",
  building: "#f59e0b",
  easing: "#38bdf8",
  steady: "#10b981",
  calm: "var(--ink-faint)",
  insufficient: "var(--ink-faint)",
};
const CONF_CLS = {
  low: "border-amber-500/40 text-amber-600 dark:text-amber-300",
  medium: "border-sky-500/40 text-sky-600 dark:text-sky-300",
  high: "border-emerald-500/40 text-emerald-600 dark:text-emerald-300",
} as const;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="py-2">
      <div className={LABEL}>{label}</div>
      <div className="mt-1 font-mono text-sm tabular-nums text-[var(--ink)]">{value}</div>
    </div>
  );
}

function RegimePanel({ a, unit, current }: { a: Regime; unit: WindUnit; current?: boolean }) {
  const glosses = useMemo(() => glossesFor(a, unit), [a, unit]);
  const color = TYPE_COLOR[a.type];
  const timeFmt = useMemo(
    () => new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" }),
    [],
  );
  const m = useMemo(() => {
    let mx = 5;
    for (const p of a.series) mx = Math.max(mx, Math.abs(p.dev), Math.abs(p.trend));
    return Math.ceil(mx * 1.15);
  }, [a.series]);
  const hasChart = a.series.length > 1 && a.type !== "calm" && a.type !== "insufficient";
  const tactical = current ? tacticalReadout(a) : null;

  return (
    <div className="rounded-lg border border-[var(--hairline)] bg-[var(--panel)] p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--ink)]">
          <span className="size-2 rounded-full" style={{ background: color }} />
          {a.typeLabel}
        </span>
        <span className="font-mono text-xs text-[var(--ink-faint)]">
          {a.durationMin.toFixed(0)} min{current ? " · current" : ""}
        </span>
        {a.type !== "insufficient" && (
          <span className={`ml-auto rounded-md border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${CONF_CLS[a.confidence]}`}>
            {a.confidence} confidence
          </span>
        )}
      </div>

      {tactical && (
        <div className="mb-3 rounded-md border border-[var(--accent)]/40 bg-[color-mix(in_oklab,var(--accent)_8%,transparent)] p-3">
          <div className={`mb-1.5 ${LABEL}`} style={{ color: "var(--accent)" }}>
            Now &amp; next
          </div>
          <p className="text-sm font-medium leading-snug text-[var(--ink)]">{tactical.now}</p>
          <p className="mt-1 text-sm leading-snug text-[var(--ink-soft)]">{tactical.next}</p>
        </div>
      )}

      <div className="space-y-1.5">
        {glosses.map((s, i) => (
          <p key={i} className={`text-sm leading-snug ${i === 0 ? "text-[var(--ink)]" : "text-[var(--ink-soft)]"}`}>
            {s}
          </p>
        ))}
      </div>

      {a.type !== "calm" && a.type !== "insufficient" && (
        <div className="mt-4 grid grid-cols-2 gap-x-6 border-t border-[var(--hairline)] pt-1 sm:grid-cols-3">
          <Stat label="Mean dir" value={`${a.meanCompass} ${Math.round(a.meanDir!)}°`} />
          <Stat label="Amplitude" value={`±${(a.amplitude / 2).toFixed(0)}° · ${a.amplitude.toFixed(0)}° p-p`} />
          <Stat label="Range" value={`${Math.round(a.fromBearing!)}°–${Math.round(a.toBearing!)}°`} />
          <Stat label="Net shift" value={`${a.netShift > 0 ? "+" : ""}${Math.round(a.netShift)}° · ${a.shiftRate > 0 ? "+" : ""}${Math.round(a.shiftRate)}°/hr`} />
          <Stat label="Half-life" value={a.halfLifeMin ? `${a.halfLifeMin.toFixed(1)} min` : a.count >= 20 ? "— not reverting" : "n<20"} />
          <Stat label="Gust factor" value={a.gustFactor ? a.gustFactor.toFixed(1) : "—"} />
        </div>
      )}

      {hasChart && (
        <div className="mt-3 h-40">
          <div className={`mb-1 ${LABEL}`}>Direction vs mean · deg</div>
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <LineChart data={a.series} margin={{ top: 6, right: 8, left: -16, bottom: 0 }}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="t" tickFormatter={(t) => timeFmt.format(new Date(t))} {...AXIS} minTickGap={44} />
              <YAxis domain={[-m, m]} ticks={[-m, 0, m]} {...AXIS} width={34} />
              <ReferenceLine y={0} stroke="var(--axis)" strokeDasharray="2 2" />
              <Tooltip
                contentStyle={tooltipStyle}
                labelFormatter={(t) => timeFmt.format(new Date(Number(t)))}
                formatter={(v, n) => [`${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(0)}°`, n === "trend" ? "trend" : "dev"]}
              />
              <Line dataKey="trend" stroke="var(--ink-faint)" strokeWidth={1} strokeDasharray="4 4" dot={false} isAnimationActive={false} />
              <Line dataKey="dev" stroke={color} strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {a.math.length > 0 && (
        <details className="mt-3 border-t border-[var(--hairline)] pt-2">
          <summary className={`cursor-pointer ${LABEL} hover:text-[var(--ink)]`}>Show the math</summary>
          <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-xs text-[var(--ink-soft)] sm:grid-cols-3">
            {a.math.map((row) => (
              <div key={row.label} className="flex justify-between gap-2">
                <span className="text-[var(--ink-faint)]">{row.label}</span>
                <span className="tabular-nums text-[var(--ink)]">{row.value}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-[var(--ink-faint)]">
            Direction unwrapped before stats. p-values normal-approx. Half-life from an Ornstein-Uhlenbeck
            fit; needs n≥20. Periods ≲6–10 min are unresolved at 3-min sampling.
          </p>
        </details>
      )}

      <div className="mt-2 font-mono text-[10px] text-[var(--ink-faint)]">
        {a.count} readings · {a.durationMin.toFixed(0)} min span
      </div>
    </div>
  );
}

type Mode = "regimes" | "30m" | "1h" | "day";

export function OscillationView({ unit }: { unit: WindUnit }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [mode, setMode] = useState<Mode>("regimes");
  const [selected, setSelected] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/history?hours=24", { cache: "no-store" });
      if (!res.ok) return;
      const j = await res.json();
      setRows(j.rows ?? []);
    } catch {
      /* keep last good */
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const calmCutoff = unit === "kts" ? 1.5 : 1.7;

  const samples = useMemo<WindSample[]>(() => {
    const k = (row: Row, key: string) => (typeof row[key] === "number" ? (row[key] as number) : null);
    const conv = (mph: number | null) => (mph == null ? null : unit === "kts" ? mph * MPH_TO_KNOTS : mph);
    return rows.map((row) => ({
      t: row.observed_at,
      dir: k(row, "wind_dir"),
      speed: conv(k(row, "wind_speed")),
      gust: conv(k(row, "wind_gust_2min")),
    }));
  }, [rows, unit]);

  const nowMs = samples.length ? samples[samples.length - 1].t : Date.now();
  const recent = useMemo(() => samples.filter((s) => s.t >= nowMs - 3 * 3600_000), [samples, nowMs]);
  const regimes = useMemo(() => detectRegimes(recent, { calmCutoff }), [recent, calmCutoff]);
  const totalMin = regimes.reduce((s, r) => s + Math.max(r.durationMin, 1), 0) || 1;

  const lens = useMemo(() => {
    if (mode === "regimes") return null;
    const win = mode === "30m" ? 30 : mode === "1h" ? 60 : 24 * 60;
    const slice = samples.filter((s) => s.t >= nowMs - win * 60_000);
    return summarizeRegime(slice, { calmCutoff, withHurst: mode === "day" });
  }, [mode, samples, nowMs, calmCutoff]);

  const currentIdx = regimes.length - 1;
  const shownIdx = selected != null && selected < regimes.length ? selected : currentIdx;

  return (
    <div>
      <a
        href="/docs#oscillation"
        target="_blank"
        rel="noreferrer"
        className="mb-4 inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--ink-faint)] transition-colors hover:text-[var(--accent)]"
      >
        How this works ↗
      </a>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <ToggleGroup type="single" value={mode} onValueChange={(v) => v && setMode(v as Mode)} variant="outline" className="border-[var(--hairline)]">
          <ToggleGroupItem value="regimes" className="px-3 text-xs">Regimes</ToggleGroupItem>
          <ToggleGroupItem value="30m" className="px-3 font-mono text-xs">30m</ToggleGroupItem>
          <ToggleGroupItem value="1h" className="px-3 font-mono text-xs">1h</ToggleGroupItem>
          <ToggleGroupItem value="day" className="px-3 font-mono text-xs">Day</ToggleGroupItem>
        </ToggleGroup>
        {mode !== "regimes" && (
          <span className="text-xs text-[var(--ink-faint)]">fixed lens — may straddle regimes</span>
        )}
      </div>

      {mode === "regimes" ? (
        <>
          {/* regime timeline */}
          <div className="mb-4">
            <div className={`mb-2 ${LABEL}`}>Last 3 h · {regimes.length} regime{regimes.length === 1 ? "" : "s"}</div>
            <div className="flex h-9 w-full overflow-hidden rounded-md border border-[var(--hairline)]">
              {regimes.map((rg, i) => (
                <button
                  key={i}
                  onClick={() => setSelected(i)}
                  title={`${rg.typeLabel} · ${rg.durationMin.toFixed(0)} min`}
                  className="group relative flex min-w-[8%] items-center justify-center border-r border-[var(--hairline)] last:border-r-0"
                  style={{
                    width: `${(Math.max(rg.durationMin, 1) / totalMin) * 100}%`,
                    background: `color-mix(in oklab, ${TYPE_COLOR[rg.type]} ${i === shownIdx ? 32 : 16}%, transparent)`,
                  }}
                >
                  <span className="truncate px-1 text-[10px] font-medium text-[var(--ink)]">
                    {rg.typeLabel.split(" ")[0]}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <RegimePanel a={regimes[shownIdx]} unit={unit} current={shownIdx === currentIdx} />
        </>
      ) : (
        lens && <RegimePanel a={lens} unit={unit} />
      )}
    </div>
  );
}
