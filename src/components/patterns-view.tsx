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
  baroLag,
  records,
  thermals,
  windRose,
  type PSample,
  type Unit,
} from "@/lib/patterns";

const MPH_TO_KNOTS = 0.868976;
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

function Section({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[var(--hairline)] bg-[var(--panel)] p-5">
      <div className="mb-4 flex items-baseline justify-between">
        <h3 className={LABEL}>{title}</h3>
        {meta ? <span className="font-mono text-[10px] text-[var(--ink-faint)]">{meta}</span> : null}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[120px] items-center justify-center rounded-md border border-dashed border-[var(--hairline)] px-4 py-6 text-center text-sm text-[var(--ink-faint)]">
      {children}
    </div>
  );
}

// ---- wind rose (custom SVG polar) ----------------------------------------

function point(cx: number, cy: number, bearing: number, r: number) {
  const a = (bearing * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)] as const;
}
function sectorPath(cx: number, cy: number, a0: number, a1: number, ri: number, ro: number) {
  const [x1, y1] = point(cx, cy, a0, ri);
  const [x2, y2] = point(cx, cy, a0, ro);
  const [x3, y3] = point(cx, cy, a1, ro);
  const [x4, y4] = point(cx, cy, a1, ri);
  return `M ${x1} ${y1} L ${x2} ${y2} A ${ro} ${ro} 0 0 1 ${x3} ${y3} L ${x4} ${y4} A ${ri} ${ri} 0 0 0 ${x1} ${y1} Z`;
}

function WindRoseChart({ samples, unit }: { samples: PSample[]; unit: Unit }) {
  const rose = useMemo(() => windRose(samples, unit), [samples, unit]);
  if (!rose.prevailing) {
    return <Empty>No directional wind logged yet — the rose fills in as data accrues.</Empty>;
  }
  const C = 130;
  const cx = C;
  const cy = C;
  const maxR = 108;
  const rings = [0.25, 0.5, 0.75, 1];

  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:justify-between">
      <svg viewBox={`0 0 ${C * 2} ${C * 2}`} className="w-full max-w-[280px]">
        {rings.map((f) => (
          <circle key={f} cx={cx} cy={cy} r={maxR * f} fill="none" stroke="var(--grid)" />
        ))}
        {["N", "E", "S", "W"].map((d, i) => {
          const [x, y] = point(cx, cy, i * 90, maxR + 12);
          return (
            <text key={d} x={x} y={y + 4} textAnchor="middle" fontSize="11" fill="var(--ink-faint)" fontFamily="var(--font-geist-mono)">
              {d}
            </text>
          );
        })}
        {rose.bins.map((b) => {
          if (!b.total) return null;
          const a0 = b.dir - 9;
          const a1 = b.dir + 9;
          let acc = 0;
          return b.bands.map((cnt, bi) => {
            if (!cnt) return null;
            const ri = (acc / rose.max) * maxR;
            acc += cnt;
            const ro = (acc / rose.max) * maxR;
            return (
              <path key={`${b.dir}-${bi}`} d={sectorPath(cx, cy, a0, a1, ri, ro)} fill={rose.bands[bi].color} opacity={0.92} />
            );
          });
        })}
        <circle cx={cx} cy={cy} r={2.5} fill="var(--ink)" />
      </svg>

      <div className="w-full sm:w-44">
        <div className={`mb-2 ${LABEL}`}>Speed bands · {unit}</div>
        <div className="space-y-1.5">
          {rose.bands.map((b) => (
            <div key={b.label} className="flex items-center gap-2 text-xs text-[var(--ink-soft)]">
              <span className="size-2.5 rounded-sm" style={{ background: b.color }} />
              <span className="font-mono tabular-nums">{b.label}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 border-t border-[var(--hairline)] pt-2 font-mono text-[11px] text-[var(--ink-faint)]">
          prevailing {rose.prevailing} · calm {rose.calmPct.toFixed(0)}%
        </div>
      </div>
    </div>
  );
}

// ---- records --------------------------------------------------------------

function RecordsGrid({ samples, unit }: { samples: PSample[]; unit: Unit }) {
  const rec = useMemo(() => records(samples), [samples]);
  const dfmt = useMemo(
    () => new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
    [],
  );
  if (!rec.n) return <Empty>No wind readings logged yet.</Empty>;
  const when = (t: number) => `${dfmt.format(new Date(t))} CT`;
  const items: { label: string; value: string; sub?: string }[] = [
    rec.maxGust
      ? { label: "Strongest gust", value: `${rec.maxGust.v.toFixed(1)} ${unit}`, sub: when(rec.maxGust.t) }
      : { label: "Strongest gust", value: "—" },
    rec.maxSustained
      ? { label: "Peak sustained", value: `${rec.maxSustained.v.toFixed(1)} ${unit}`, sub: when(rec.maxSustained.t) }
      : { label: "Peak sustained", value: "—" },
    rec.windiestDay
      ? { label: "Windiest day", value: `${rec.windiestDay.avg.toFixed(1)} ${unit} avg`, sub: `${rec.windiestDay.day} · peak ${rec.windiestDay.peak.toFixed(0)}` }
      : { label: "Windiest day", value: "—" },
    rec.calmestDay
      ? { label: "Calmest day", value: `${rec.calmestDay.avg.toFixed(1)} ${unit} avg`, sub: rec.calmestDay.day }
      : { label: "Calmest day", value: "—" },
    rec.longestSteadyMin
      ? { label: "Longest steady", value: `${rec.longestSteadyMin.toFixed(0)} min`, sub: "dir within 30°" }
      : { label: "Longest steady", value: "—" },
    { label: "Logged", value: `${rec.n} reads`, sub: `${rec.days} day${rec.days === 1 ? "" : "s"}` },
  ];
  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md bg-[var(--hairline)] sm:grid-cols-3">
      {items.map((it) => (
        <div key={it.label} className="bg-[var(--panel-2)] p-4">
          <div className={LABEL}>{it.label}</div>
          <div className="mt-1 font-mono text-xl tabular-nums text-[var(--ink)]">{it.value}</div>
          {it.sub ? <div className="mt-0.5 font-mono text-[10px] text-[var(--ink-faint)]">{it.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

// ---- thermals -------------------------------------------------------------

function ThermalsPanel({ samples, unit }: { samples: PSample[]; unit: Unit }) {
  const sb = useMemo(() => thermals(samples, unit), [samples, unit]);
  if (!sb.days.length) {
    return (
      <Empty>
        No clear thermal pattern in {sb.scannedDays} day{sb.scannedDays === 1 ? "" : "s"} scanned.
        Looks for a calm morning building to a steadier, stronger afternoon (≥{sb.buildKtsThreshold.toFixed(0)} {unit} jump).
      </Empty>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm text-[var(--ink-soft)]">
        {sb.days.length} day{sb.days.length === 1 ? "" : "s"} with a thermal-build signature — morning calm giving way to a steadier afternoon.
      </p>
      <div className="divide-y divide-[var(--hairline)] border-y border-[var(--hairline)]">
        {sb.days.slice(0, 8).map((d) => (
          <div key={d.day} className="flex items-baseline justify-between gap-3 py-2 font-mono text-sm">
            <span className="text-[var(--ink)]">{d.day}</span>
            <span className="tabular-nums text-[var(--ink-soft)]">
              {d.morningMean.toFixed(1)} → {d.afternoonMean.toFixed(1)} {unit}
              <span className="ml-2 text-[var(--accent)]">+{d.build.toFixed(1)}</span>
              <span className="ml-2 text-[var(--ink-faint)]">from {d.afternoonDir}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- barometer lead/lag ---------------------------------------------------

function BaroLagPanel({ samples }: { samples: PSample[] }) {
  const bl = useMemo(() => baroLag(samples), [samples]);
  if (!bl.ok) {
    return <Empty>{bl.reason}</Empty>;
  }
  const leads = (bl.bestLagMin ?? 0) < 0;
  const mins = Math.abs(bl.bestLagMin!);
  const rTxt = bl.bestR!.toFixed(2).replace("-", "−");
  const headline = leads
    ? bl.bestR! < 0
      ? `Falling pressure leads rising wind by ~${mins} min`
      : `Rising pressure leads rising wind by ~${mins} min`
    : bl.bestR! < 0
      ? `Wind picks up ~${mins} min before pressure falls`
      : `Wind and pressure move together (~${mins} min lag)`;
  return (
    <div>
      <p className="text-sm font-medium leading-snug text-[var(--ink)]">{headline}</p>
      <p className="mt-1 text-sm leading-snug text-[var(--ink-soft)]">
        Correlation r = {rTxt}.{leads ? " Pressure moves first — a handy early-warning tell." : ""}
      </p>
      <div className="mt-3 h-40">
        <div className={`mb-1 ${LABEL}`}>Correlation vs lag · min (negative = pressure leads)</div>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <LineChart data={bl.series} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="lagMin" type="number" domain={["dataMin", "dataMax"]} {...AXIS} />
            <YAxis domain={[-1, 1]} ticks={[-1, 0, 1]} {...AXIS} width={32} />
            <ReferenceLine x={0} stroke="var(--axis)" strokeDasharray="2 2" />
            <ReferenceLine y={0} stroke="var(--axis)" strokeDasharray="2 2" />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v) => [Number(v).toFixed(2), "r"]}
              labelFormatter={(l) => `${l} min`}
            />
            <Line dataKey="r" stroke="var(--accent)" strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---- view -----------------------------------------------------------------

type Range = { label: string; hours: number };
const RANGES: Range[] = [
  { label: "7d", hours: 24 * 7 },
  { label: "30d", hours: 24 * 30 },
  { label: "90d", hours: 24 * 90 },
];

export function PatternsView({ unit }: { unit: Unit }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [hours, setHours] = useState(24 * 30);
  const [spanHours, setSpanHours] = useState(0);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/history?hours=${hours}`, { cache: "no-store" });
      if (!res.ok) return;
      const j = await res.json();
      setRows(j.rows ?? []);
      const s = j.stats;
      setSpanHours(s?.first && s?.last ? (s.last - s.first) / 3_600_000 : 0);
      setLoaded(true);
    } catch {
      /* keep last good */
    }
  }, [hours]);

  useEffect(() => {
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => clearInterval(id);
  }, [load]);

  // Only offer windows we actually have data for (always keep the smallest).
  const availRanges = useMemo(
    () => RANGES.filter((r, i) => i === 0 || spanHours >= r.hours),
    [spanHours],
  );
  useEffect(() => {
    if (!availRanges.some((r) => r.hours === hours)) {
      const largest = availRanges[availRanges.length - 1];
      if (largest && largest.hours !== hours) setHours(largest.hours);
    }
  }, [availRanges, hours]);

  const samples = useMemo<PSample[]>(() => {
    const k = (row: Row, key: string) => (typeof row[key] === "number" ? (row[key] as number) : null);
    const conv = (mph: number | null) => (mph == null ? null : unit === "kts" ? mph * MPH_TO_KNOTS : mph);
    return rows.map((row) => ({
      t: row.observed_at,
      speed: conv(k(row, "wind_speed")),
      gust: conv(k(row, "wind_gust_2min")),
      dir: k(row, "wind_dir"),
      temp: k(row, "temp"),
      baro: k(row, "barometer"),
    }));
  }, [rows, unit]);

  return (
    <div>
      <div className="mb-4 flex items-center justify-end">
        <ToggleGroup
          type="single"
          value={availRanges.some((r) => r.hours === hours) ? String(hours) : ""}
          onValueChange={(v) => v && setHours(Number(v))}
          variant="outline"
          className="border-[var(--hairline)]"
        >
          {availRanges.map((rg) => (
            <ToggleGroupItem key={rg.label} value={String(rg.hours)} className="px-3 font-mono text-xs">
              {rg.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Wind rose" meta={`${samples.length} pts`}>
          <WindRoseChart samples={samples} unit={unit} />
        </Section>
        <Section title="Records & extremes">
          <RecordsGrid samples={samples} unit={unit} />
        </Section>
        <Section title="Thermal builds">
          <ThermalsPanel samples={samples} unit={unit} />
        </Section>
        <Section title="Barometer → wind">
          <BaroLagPanel samples={samples} />
        </Section>
      </div>

      {loaded && rows.length === 0 && (
        <p className="mt-4 text-sm text-[var(--ink-faint)]">No history stored yet — patterns appear once readings accumulate.</p>
      )}
    </div>
  );
}
