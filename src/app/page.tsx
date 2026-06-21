"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import posthog from "posthog-js";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ThemeToggle } from "@/components/theme-toggle";
import { OscillationView } from "@/components/oscillation-view";

// ---- types ---------------------------------------------------------------

type Row = Record<string, number | string | null> & { observed_at: number };

interface HistoryResponse {
  hours: number;
  rows: Row[];
  latest: Row | null;
  stats: { count: number; first: number | null; last: number | null };
}

// ---- units / format ------------------------------------------------------

const MPH_TO_KNOTS = 0.868976;
type WindUnit = "kts" | "mph";

function windVal(mph: number | null | undefined, unit: WindUnit): number | null {
  if (mph == null) return null;
  return unit === "kts" ? mph * MPH_TO_KNOTS : mph;
}

const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];
function compass(deg: number | null | undefined): string {
  if (deg == null) return "—";
  return COMPASS[Math.round(deg / 22.5) % 16];
}

const RANGES = [
  { label: "3h", hours: 3 },
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 24 * 7 },
  { label: "30d", hours: 24 * 30 },
];

function num(r: Row | null, k: string): number | null {
  if (!r) return null;
  const v = r[k];
  return typeof v === "number" ? v : null;
}
function fmt(n: number | null | undefined, digits = 1): string {
  return n == null ? "—" : n.toFixed(digits);
}
function baroTrend(t: number | null): string {
  if (t == null) return "—";
  if (t > 0.02) return "Rising";
  if (t < -0.02) return "Falling";
  return "Steady";
}

// ---- shared primitives ---------------------------------------------------

const LABEL = "text-[10px] font-medium uppercase tracking-[0.16em] text-[var(--ink-faint)]";

function StatRow({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2.5">
      <span className={LABEL}>{label}</span>
      <span className="font-mono text-sm tabular-nums text-[var(--ink)]">
        {value}
        {unit ? <span className="ml-1 text-[11px] text-[var(--ink-faint)]">{unit}</span> : null}
      </span>
    </div>
  );
}

function TelemetryRail({
  title,
  side,
  items,
}: {
  title: string;
  side: "left" | "right";
  items: { label: string; value: string; unit?: string }[];
}) {
  return (
    <aside
      className={`fixed top-0 z-20 hidden h-screen w-[200px] flex-col justify-center px-6 min-[1600px]:flex ${
        side === "left" ? "left-0" : "right-0"
      }`}
    >
      <div className="mb-3 flex items-center gap-2">
        <span className="size-1 rounded-full bg-[var(--accent)]" />
        <span className="text-[10px] uppercase tracking-[0.24em] text-[var(--ink-faint)]">{title}</span>
      </div>
      <div className="divide-y divide-[var(--hairline)] border-y border-[var(--hairline)]">
        {items.map((it) => (
          <StatRow key={it.label} label={it.label} value={it.value} unit={it.unit} />
        ))}
      </div>
    </aside>
  );
}

function WindCompass({ deg }: { deg: number | null }) {
  const angle = deg ?? 0;
  return (
    <div className="relative size-40 shrink-0">
      <svg viewBox="0 0 200 200" className="size-full">
        <circle cx="100" cy="100" r="92" fill="var(--panel-2)" stroke="var(--hairline)" />
        {["N", "E", "S", "W"].map((d, i) => {
          const a = (i * 90 - 90) * (Math.PI / 180);
          return (
            <text
              key={d}
              x={100 + Math.cos(a) * 78}
              y={100 + Math.sin(a) * 78 + 4}
              textAnchor="middle"
              fontSize="12"
              fill="var(--ink-faint)"
              fontFamily="var(--font-geist-mono)"
            >
              {d}
            </text>
          );
        })}
        {Array.from({ length: 16 }).map((_, i) => {
          const a = (i * 22.5 - 90) * (Math.PI / 180);
          const r1 = i % 4 === 0 ? 64 : 70;
          return (
            <line
              key={i}
              x1={100 + Math.cos(a) * r1}
              y1={100 + Math.sin(a) * r1}
              x2={100 + Math.cos(a) * 74}
              y2={100 + Math.sin(a) * 74}
              stroke="var(--grid)"
            />
          );
        })}
        {deg != null && (
          <g transform={`rotate(${angle} 100 100)`}>
            <polygon points="100,26 108,100 100,88 92,100" fill="var(--accent)" />
            <polygon points="100,174 108,100 100,112 92,100" fill="var(--ink-faint)" />
          </g>
        )}
        <circle cx="100" cy="100" r="4" fill="var(--ink)" />
      </svg>
    </div>
  );
}

const AXIS = { stroke: "var(--axis)", fontSize: 11, fontFamily: "var(--font-geist-mono)", fill: "var(--axis)" } as const;
const tooltipStyle = {
  background: "var(--panel-2)",
  border: "1px solid var(--hairline)",
  borderRadius: 6,
  color: "var(--ink)",
  fontSize: 12,
  fontFamily: "var(--font-geist-mono)",
} as const;

function ChartCard({
  title,
  meta,
  children,
  height = 230,
  className = "",
}: {
  title: string;
  meta?: string;
  children: React.ReactElement;
  height?: number;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-[var(--hairline)] bg-[var(--panel)] p-4 ${className}`}>
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className={LABEL}>{title}</h3>
        {meta ? <span className="font-mono text-[10px] text-[var(--ink-faint)]">{meta}</span> : null}
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---- modals --------------------------------------------------------------

function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  // close on Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-md rounded-md border border-[var(--hairline)] bg-[var(--panel)] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function FeatureModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [email, setEmail] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    const subject = encodeURIComponent("MYC Weather Station — Feature Request");
    const body = encodeURIComponent(
      `${text.trim()}${email.trim() ? `\n\nFrom: ${email.trim()}` : ""}`,
    );
    posthog.capture("feature_request_submitted", { has_email: !!email.trim() });
    window.open(`mailto:marleyhansenbarrett@gmail.com?subject=${subject}&body=${body}`);
    onClose();
  }

  return (
    <Modal onClose={onClose}>
      <div className="mb-5 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">
          Request a Feature
        </span>
        <button
          type="button"
          onClick={onClose}
          className="font-mono text-sm text-[var(--ink-faint)] transition-colors hover:text-[var(--ink)]"
        >
          ✕
        </button>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Describe the feature..."
          rows={4}
          className="w-full rounded border border-[var(--hairline)] bg-[var(--panel-2)] px-3 py-2 font-mono text-xs text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:outline-none"
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Your email (optional)"
          className="w-full rounded border border-[var(--hairline)] bg-[var(--panel-2)] px-3 py-2 font-mono text-xs text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:outline-none"
        />
        <div className="flex items-center justify-between pt-1">
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[11px] text-[var(--ink-faint)] transition-colors hover:text-[var(--ink)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!text.trim()}
            className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)] transition-colors hover:text-[var(--ink)] disabled:pointer-events-none disabled:opacity-40"
          >
            Send →
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CustomRangeModal({ current, onApply, onClose }: { current: number; onApply: (h: number) => void; onClose: () => void }) {
  const [days, setDays] = useState(Math.floor(current / 24) || "");
  const [hrs, setHrs] = useState(current % 24 || "");

  const total = (Number(days) || 0) * 24 + (Number(hrs) || 0);

  function handleApply() {
    if (total < 1) return;
    const capped = Math.min(total, 2160);
    posthog.capture("custom_range_applied", { hours: capped });
    onApply(capped);
    onClose();
  }

  return (
    <Modal onClose={onClose}>
      <div className="mb-5 flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--ink-faint)]">
          Custom Range
        </span>
        <button
          onClick={onClose}
          className="font-mono text-sm text-[var(--ink-faint)] transition-colors hover:text-[var(--ink)]"
        >
          ✕
        </button>
      </div>
      <p className="mb-4 font-mono text-xs text-[var(--ink-faint)]">
        Show data for the last N days / hours. Max 90 days.
      </p>
      <div className="flex gap-3">
        <label className="flex-1">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--ink-faint)]">Days</span>
          <input
            type="number"
            min={0}
            max={90}
            value={days}
            onChange={(e) => setDays(e.target.value === "" ? "" : Number(e.target.value))}
            placeholder="0"
            className="w-full rounded border border-[var(--hairline)] bg-[var(--panel-2)] px-3 py-2 font-mono text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none"
          />
        </label>
        <label className="flex-1">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--ink-faint)]">Hours</span>
          <input
            type="number"
            min={0}
            max={23}
            value={hrs}
            onChange={(e) => setHrs(e.target.value === "" ? "" : Number(e.target.value))}
            placeholder="0"
            className="w-full rounded border border-[var(--hairline)] bg-[var(--panel-2)] px-3 py-2 font-mono text-sm text-[var(--ink)] focus:border-[var(--accent)] focus:outline-none"
          />
        </label>
      </div>
      {total > 0 && (
        <p className="mt-2 font-mono text-[11px] text-[var(--ink-faint)]">
          = {total >= 48 ? `${(total / 24).toFixed(1)} days` : `${total}h`}
          {total > 2160 ? " (capped at 90d)" : ""}
        </p>
      )}
      <div className="mt-5 flex items-center justify-between">
        <button
          onClick={onClose}
          className="font-mono text-[11px] text-[var(--ink-faint)] transition-colors hover:text-[var(--ink)]"
        >
          Cancel
        </button>
        <button
          onClick={handleApply}
          disabled={total < 1}
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--accent)] transition-colors hover:text-[var(--ink)] disabled:pointer-events-none disabled:opacity-40"
        >
          Apply →
        </button>
      </div>
    </Modal>
  );
}

// ---- page ----------------------------------------------------------------

type Tab = "live" | "osc";

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>("live");
  const [hours, setHours] = useState(24);
  const [unit, setUnit] = useState<WindUnit>("kts");
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [live, setLive] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [featureOpen, setFeatureOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/history?hours=${hours}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`history ${res.status}`);
      setData(await res.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [hours]);

  const loadLive = useCallback(async () => {
    try {
      const res = await fetch("/api/live", { cache: "no-store" });
      if (!res.ok) return;
      setLive(await res.json());
      setUpdatedAt(Date.now());
    } catch {
      /* keep last good value */
    }
  }, []);

  useEffect(() => {
    loadHistory();
    const id = setInterval(loadHistory, 5 * 60_000);
    return () => clearInterval(id);
  }, [loadHistory]);

  useEffect(() => {
    loadLive();
    const id = setInterval(loadLive, 30_000);
    return () => clearInterval(id);
  }, [loadLive]);

  const current = live ?? data?.latest ?? null;
  const u = unit;
  const isWide = hours > 48;

  const timeFmt = useMemo(
    () =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Chicago",
        ...(isWide
          ? { month: "numeric", day: "numeric" }
          : { hour: "2-digit", minute: "2-digit", hour12: false }),
      }),
    [isWide],
  );
  const tickFmt = (t: number) => timeFmt.format(new Date(t));

  const series = useMemo(() => {
    const rows = data?.rows ?? [];
    return rows.map((r) => ({
      t: r.observed_at,
      wind: windVal(num(r, "wind_speed"), unit),
      gust: windVal(num(r, "wind_gust_2min"), unit),
      dir: num(r, "wind_dir"),
      temp: num(r, "temp"),
      baro: num(r, "barometer"),
      hum: num(r, "humidity"),
    }));
  }, [data, unit]);

  const windMax = useMemo(() => {
    let m = 0;
    for (const s of series) {
      if (s.wind && s.wind > m) m = s.wind;
      if (s.gust && s.gust > m) m = s.gust;
    }
    return m;
  }, [series]);

  const noData = (data?.stats.count ?? 0) === 0;

  const w = (k: string) => fmt(windVal(num(current, k), unit));
  const windItems = [
    { label: "Speed", value: w("wind_speed"), unit: u },
    { label: "Gust 2m", value: w("wind_gust_2min"), unit: u },
    { label: "Avg 1m", value: w("wind_avg_1min"), unit: u },
    { label: "Avg 2m", value: w("wind_avg_2min"), unit: u },
    { label: "Avg 10m", value: w("wind_avg_10min"), unit: u },
    { label: "Gust 10m", value: w("wind_gust_10min"), unit: u },
    {
      label: "Dir",
      value:
        num(current, "wind_dir") == null
          ? "—"
          : `${Math.round(num(current, "wind_dir") as number)}° ${compass(num(current, "wind_dir"))}`,
    },
  ];
  const atmoItems = [
    { label: "Temp", value: fmt(num(current, "temp")), unit: "°F" },
    { label: "Dew Pt", value: fmt(num(current, "dew_point")), unit: "°F" },
    { label: "Humidity", value: fmt(num(current, "humidity"), 0), unit: "%" },
    { label: "Barometer", value: fmt(num(current, "barometer"), 2), unit: "inHg" },
    { label: "Trend", value: baroTrend(num(current, "bar_trend")) },
    { label: "Heat Idx", value: fmt(num(current, "heat_index")), unit: "°F" },
    { label: "Wind Chill", value: fmt(num(current, "wind_chill")), unit: "°F" },
    { label: "Rain Rate", value: fmt(num(current, "rain_rate"), 2), unit: "in/h" },
    { label: "Rain 60m", value: fmt(num(current, "rain_60min"), 2), unit: "in" },
  ];

  const cluster = [
    { label: "Temperature", value: fmt(num(current, "temp")), unit: "°F" },
    { label: "Humidity", value: fmt(num(current, "humidity"), 0), unit: "%" },
    { label: "Barometer", value: fmt(num(current, "barometer"), 2), unit: "inHg", sub: baroTrend(num(current, "bar_trend")) },
    { label: "Dew Point", value: fmt(num(current, "dew_point")), unit: "°F" },
    { label: "Heat Index", value: fmt(num(current, "heat_index")), unit: "°F" },
    { label: "Wind Chill", value: fmt(num(current, "wind_chill")), unit: "°F" },
    { label: "Rain Rate", value: fmt(num(current, "rain_rate"), 2), unit: "in/h" },
    { label: "Rain 60 min", value: fmt(num(current, "rain_60min"), 2), unit: "in" },
  ];

  const tabBtn = (id: Tab, label: string) => (
    <button
      key={id}
      onClick={() => {
        setTab(id);
        posthog.capture("tab_changed", { tab: id });
      }}
      className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
        tab === id
          ? "border-[var(--accent)] text-[var(--ink)]"
          : "border-transparent text-[var(--ink-soft)] hover:text-[var(--ink)]"
      }`}
    >
      {label}
    </button>
  );

  return (
    <>
      {featureOpen && <FeatureModal onClose={() => setFeatureOpen(false)} />}
      {customOpen && <CustomRangeModal current={hours} onApply={setHours} onClose={() => setCustomOpen(false)} />}

      <TelemetryRail title="Wind" side="left" items={windItems} />
      <TelemetryRail title="Atmosphere" side="right" items={atmoItems} />

      <main className="mx-auto w-full max-w-7xl px-5 py-8 sm:px-8">
        {/* header */}
        <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-1 flex items-center gap-2">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--accent)] opacity-60" />
                <span className="relative inline-flex size-1.5 rounded-full bg-[var(--accent)]" />
              </span>
              <span className="text-[10px] uppercase tracking-[0.24em] text-[var(--ink-faint)]">
                Live
                {updatedAt && (
                  <>
                    {" · "}
                    {new Intl.DateTimeFormat("en-US", {
                      timeZone: "America/Chicago",
                      hour: "numeric",
                      minute: "2-digit",
                      second: "2-digit",
                    }).format(updatedAt)}
                    {" CT"}
                  </>
                )}
              </span>
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--ink)] sm:text-2xl">
              {(current?.owner_name as string) ?? "Minnetonka Yacht Club"}
            </h1>
            <p className="mt-0.5 text-sm text-[var(--ink-soft)]">Wind & weather telemetry</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="/docs"
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--ink-faint)] transition-colors hover:text-[var(--accent)]"
            >
              Docs ↗
            </a>
            <ThemeToggle />
            <ToggleGroup
              type="single"
              value={unit}
              onValueChange={(v) => {
                if (!v) return;
                setUnit(v as WindUnit);
                posthog.capture("wind_unit_changed", { unit: v });
              }}
              variant="outline"
              className="border-[var(--hairline)]"
            >
              {(["kts", "mph"] as WindUnit[]).map((x) => (
                <ToggleGroupItem key={x} value={x} className="px-3 font-mono text-xs">
                  {x}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {tab === "live" && (
              <div className="flex items-center gap-1">
                <ToggleGroup
                  type="single"
                  value={RANGES.some((r) => r.hours === hours) ? String(hours) : ""}
                  onValueChange={(v) => {
                    if (!v) return;
                    setHours(Number(v));
                    posthog.capture("time_range_changed", { hours: Number(v) });
                  }}
                  variant="outline"
                  className="border-[var(--hairline)]"
                >
                  {RANGES.map((r) => (
                    <ToggleGroupItem key={r.label} value={String(r.hours)} className="px-3 font-mono text-xs">
                      {r.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <button
                  onClick={() => setCustomOpen(true)}
                  className={`rounded border px-3 py-1.5 font-mono text-xs transition-colors ${
                    !RANGES.some((r) => r.hours === hours)
                      ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]"
                      : "border-[var(--hairline)] text-[var(--ink-faint)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  }`}
                >
                  {!RANGES.some((r) => r.hours === hours)
                    ? hours >= 48 ? `${(hours / 24).toFixed(0)}d custom` : `${hours}h custom`
                    : "custom"}
                </button>
              </div>
            )}
          </div>
        </header>

        {/* tabs */}
        <nav className="mb-6 flex gap-1 border-b border-[var(--hairline)]">
          {tabBtn("live", "Live")}
          {tabBtn("osc", "Oscillation")}
        </nav>

        {noData && (
          <div className="mb-6 rounded-lg border border-amber-500/30 bg-amber-500/[0.08] px-4 py-2.5 text-sm text-amber-700 dark:text-amber-200/90">
            No history stored yet. Hit{" "}
            <code className="rounded bg-black/10 px-1 font-mono text-xs dark:bg-black/40">/api/cron?force=1</code> to seed it.
          </div>
        )}
        {error && !noData && (
          <div className="mb-6 rounded-lg border border-rose-500/30 bg-rose-500/[0.08] px-4 py-2.5 text-sm text-rose-700 dark:text-rose-200/90">
            Error loading history: {error}
          </div>
        )}

        {tab === "osc" ? (
          <OscillationView unit={unit} />
        ) : (
          <>
            {/* hero — primary wind instrument */}
            <div className="mb-4 rounded-md border border-[var(--hairline)] bg-[var(--panel)]">
              <div className="flex flex-col gap-8 p-6 sm:p-8 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <span className={LABEL}>Wind speed</span>
                  <div className="mt-2 flex items-end gap-3">
                    <span className="font-mono text-7xl font-semibold leading-none tracking-tight text-[var(--speed-color)] tabular-nums sm:text-8xl">
                      {w("wind_speed")}
                    </span>
                    <span className="mb-2 font-mono text-lg text-[var(--ink-faint)]">{u}</span>
                  </div>
                  <div className="mt-6 flex divide-x divide-[var(--hairline)] border-y border-[var(--hairline)]">
                    {[
                      { l: "Gust 2m", v: w("wind_gust_2min") },
                      { l: "Avg 10m", v: w("wind_avg_10min") },
                      { l: "Avg 1m", v: w("wind_avg_1min") },
                    ].map((s, i) => (
                      <div key={s.l} className={`py-3 ${i === 0 ? "pr-5" : "px-5"}`}>
                        <div className={LABEL}>{s.l}</div>
                        <div className="mt-1 font-mono text-lg tabular-nums text-[var(--ink)]">
                          {s.v}
                          <span className="ml-1 text-xs text-[var(--ink-faint)]">{u}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex items-center gap-5">
                  <WindCompass deg={num(current, "wind_dir")} />
                  <div className="hidden sm:block">
                    <span className={LABEL}>From</span>
                    <div className="mt-1 font-mono text-2xl tabular-nums text-[var(--ink)]">
                      {compass(num(current, "wind_dir"))}
                    </div>
                    <div className="mt-1 font-mono text-sm text-[var(--ink-faint)]">
                      {num(current, "wind_dir") == null ? "—" : `${Math.round(num(current, "wind_dir") as number)}°`}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* instrument cluster */}
            <div className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded-lg bg-[var(--hairline)] sm:grid-cols-4">
              {cluster.map((c) => (
                <div key={c.label} className="bg-[var(--panel-2)] p-4">
                  <div className={LABEL}>{c.label}</div>
                  <div className="mt-1.5 font-mono text-2xl tabular-nums text-[var(--ink)]">
                    {c.value}
                    <span className="ml-1 text-xs text-[var(--ink-faint)]">{c.unit}</span>
                  </div>
                  {"sub" in c && c.sub ? (
                    <div className="mt-0.5 font-mono text-[11px] text-[var(--ink-faint)]">{c.sub}</div>
                  ) : null}
                </div>
              ))}
            </div>

            {/* charts */}
            <ChartCard title={`Wind speed & gust · ${u}`} meta={`${series.length} pts`} height={300} className="mb-4">
              <AreaChart data={series} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <defs>
                  <linearGradient id="gWind" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.32} />
                    <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis dataKey="t" tickFormatter={tickFmt} {...AXIS} minTickGap={48} />
                <YAxis {...AXIS} domain={[0, Math.ceil((windMax || 5) * 1.1)]} width={34} />
                <Tooltip contentStyle={tooltipStyle} labelFormatter={(t) => tickFmt(Number(t))} formatter={(v, n) => [v == null ? "—" : Number(v).toFixed(1), n]} />
                <Area type="monotone" dataKey="gust" name="gust" stroke="var(--ink-faint)" strokeWidth={1} fill="none" dot={false} isAnimationActive={false} />
                <Area type="monotone" dataKey="wind" name="wind" stroke="var(--accent)" strokeWidth={2} fill="url(#gWind)" dot={false} isAnimationActive={false} />
              </AreaChart>
            </ChartCard>

            <div className="grid gap-4 lg:grid-cols-2">
              <ChartCard title="Wind direction · deg">
                <ScatterChart margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid stroke="var(--grid)" />
                  <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={tickFmt} {...AXIS} minTickGap={48} />
                  <YAxis dataKey="dir" type="number" domain={[0, 360]} ticks={[0, 90, 180, 270, 360]} {...AXIS} width={34} />
                  <Tooltip contentStyle={tooltipStyle} labelFormatter={(t) => tickFmt(Number(t))} formatter={(v) => [`${Math.round(Number(v))}° ${compass(Number(v))}`, "dir"]} />
                  <Scatter data={series} fill="#5eead4" isAnimationActive={false} />
                </ScatterChart>
              </ChartCard>

              <ChartCard title="Temperature · °F">
                <LineChart data={series} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <CartesianGrid stroke="var(--grid)" vertical={false} />
                  <XAxis dataKey="t" tickFormatter={tickFmt} {...AXIS} minTickGap={48} />
                  <YAxis {...AXIS} domain={["auto", "auto"]} width={34} />
                  <Tooltip contentStyle={tooltipStyle} labelFormatter={(t) => tickFmt(Number(t))} />
                  <Line type="monotone" dataKey="temp" name="°F" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ChartCard>

              <ChartCard title="Barometric pressure · inHg">
                <LineChart data={series} margin={{ top: 8, right: 8, left: -4, bottom: 0 }}>
                  <CartesianGrid stroke="var(--grid)" vertical={false} />
                  <XAxis dataKey="t" tickFormatter={tickFmt} {...AXIS} minTickGap={48} />
                  <YAxis {...AXIS} domain={["auto", "auto"]} width={46} tickFormatter={(v) => Number(v).toFixed(2)} />
                  <Tooltip contentStyle={tooltipStyle} labelFormatter={(t) => tickFmt(Number(t))} formatter={(v) => [Number(v).toFixed(3), "inHg"]} />
                  <Line type="monotone" dataKey="baro" name="inHg" stroke="#2dd4bf" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ChartCard>

              <ChartCard title="Relative humidity · %">
                <AreaChart data={series} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <defs>
                    <linearGradient id="gHum" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#7aa2c8" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#7aa2c8" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--grid)" vertical={false} />
                  <XAxis dataKey="t" tickFormatter={tickFmt} {...AXIS} minTickGap={48} />
                  <YAxis {...AXIS} domain={[0, 100]} width={34} />
                  <Tooltip contentStyle={tooltipStyle} labelFormatter={(t) => tickFmt(Number(t))} />
                  <Area type="monotone" dataKey="hum" name="%" stroke="#7aa2c8" fill="url(#gHum)" strokeWidth={2} dot={false} isAnimationActive={false} />
                </AreaChart>
              </ChartCard>
            </div>
          </>
        )}

        <footer className="mt-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-[var(--hairline)] pt-4 font-mono text-[11px] text-[var(--ink-faint)]">
          <span>
            {data?.stats.count ?? 0} readings · new data every 3 minutes · 360-day retention
          </span>
          <span className="flex items-center gap-4">
            <button
              onClick={() => setFeatureOpen(true)}
              className="transition-colors hover:text-[var(--accent)]"
            >
              Request a Feature
            </button>
            <a
              href="https://www.weatherlink.com/embeddablePage/show/25aa5d18618f41a8894a5ba0b092df3d/summary"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-[var(--accent)]"
            >
              Source
            </a>
            <a
              href="https://github.com/MarMar888/myc-weather-station"
              target="_blank"
              rel="noreferrer"
              className="transition-colors hover:text-[var(--accent)]"
            >
              GitHub
            </a>
            <a href="mailto:marley@squeakycleanboats.com" className="transition-colors hover:text-[var(--accent)]">
              marley@squeakycleanboats.com
            </a>
          </span>
        </footer>
      </main>
    </>
  );
}
