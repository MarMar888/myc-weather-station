"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface Airport {
  icaoId: string;
  name: string | null;
  lat: number;
  lon: number;
  obsTime: number | null;
  wdir: number | null;
  wdirVariable: boolean;
  wspd: number | null;
  wgst: number | null;
  bearingFromHome: number;
  distanceNm: number;
  upwind: boolean;
}

interface AirportsResponse {
  home: { lat: number; lon: number };
  homeWindDir: number | null;
  airports: Airport[];
}

const LABEL = "text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--ink-faint)]";

const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];
function compass(deg: number | null): string {
  if (deg == null) return "—";
  return COMPASS[Math.round(deg / 22.5) % 16];
}

function ageLabel(obsTime: number | null): string {
  if (obsTime == null) return "—";
  const mins = Math.max(0, Math.round((Date.now() / 1000 - obsTime) / 60));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${(mins / 60).toFixed(1)}h ago`;
}

// Polar placement, matching this app's compass convention: 0deg = north = up,
// degrees increase clockwise.
function polar(angleDeg: number, r: number, cx: number, cy: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + Math.cos(rad) * r, y: cy + Math.sin(rad) * r };
}

const CX = 130;
const CY = 130;
const R_MIN = 26;
const R_MAX = 104;

// Airports cluster tightly around the Twin Cities relative to their distance
// from home, so a linear distance scale packs them on top of each other. A
// sqrt scale gives near airports more breathing room without distorting
// which ones are closer/farther.
function radiusFor(distanceNm: number, maxDist: number): number {
  return R_MIN + Math.sqrt(distanceNm / maxDist) * (R_MAX - R_MIN);
}

interface LabelPos {
  icaoId: string;
  angle: number;
  labelR: number;
}

// Push label anchors (which start just outside each marker) apart along
// their own bearing when two labels would land within collision distance —
// keeps the dense Minneapolis-area cluster legible without moving the
// markers themselves off their true bearing/distance.
function declutterLabels(points: { icaoId: string; angle: number; r: number }[]): LabelPos[] {
  const labels: LabelPos[] = points.map((p) => ({ icaoId: p.icaoId, angle: p.angle, labelR: p.r + 15 }));
  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const pa = polar(labels[i].angle, labels[i].labelR, CX, CY);
        const pb = polar(labels[j].angle, labels[j].labelR, CX, CY);
        if (Math.hypot(pa.x - pb.x, pa.y - pb.y) < 24) {
          labels[j].labelR += 9;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return labels;
}

function speedLabel(a: Airport): string {
  if (a.wdirVariable) return "VRB";
  if (a.wspd == null) return "—";
  if (a.wspd === 0) return "calm";
  return `${Math.round(a.wspd)}${a.wgst != null ? `G${Math.round(a.wgst)}` : ""}kt`;
}

function AirportsMap({
  airports,
  hoveredId,
  onHover,
}: Pick<AirportsResponse, "homeWindDir" | "airports"> & {
  hoveredId: string | null;
  onHover: (id: string | null) => void;
}) {
  const maxDist = Math.max(...airports.map((a) => a.distanceNm), 1);
  const rings = [0.33, 0.66, 1];

  const placed = airports.map((a) => {
    const r = radiusFor(a.distanceNm, maxDist);
    return { a, r, p: polar(a.bearingFromHome, r, CX, CY) };
  });
  const labels = declutterLabels(placed.map(({ a, r }) => ({ icaoId: a.icaoId, angle: a.bearingFromHome, r })));
  const labelById = new Map(labels.map((l) => [l.icaoId, l]));

  return (
    <svg viewBox="0 0 260 260" className="size-full">
      {rings.map((f) => (
        <circle key={f} cx={CX} cy={CY} r={R_MIN + f * (R_MAX - R_MIN)} fill="none" stroke="var(--grid)" strokeWidth={0.75} />
      ))}
      {rings.map((f) => (
        <text
          key={`ring-label-${f}`}
          x={CX}
          y={CY - (R_MIN + f * (R_MAX - R_MIN)) - 3}
          textAnchor="middle"
          fontSize="8"
          fill="var(--ink-faint)"
        >
          {Math.round(f * f * maxDist)}nm
        </text>
      ))}

      {placed.map(({ a, p }) => (
        <line
          key={`spoke-${a.icaoId}`}
          x1={CX}
          y1={CY}
          x2={p.x}
          y2={p.y}
          stroke={a.icaoId === hoveredId ? "var(--ink-soft)" : "var(--hairline)"}
          strokeWidth={a.icaoId === hoveredId ? 1 : 0.5}
        />
      ))}

      {placed.map(({ a, p }) => {
        const hasWind = a.wdir != null && !a.wdirVariable && (a.wspd ?? 0) > 0;
        const active = a.icaoId === hoveredId;
        const color = a.upwind ? "var(--accent)" : active ? "var(--ink)" : "var(--ink-soft)";
        // Wind-vane arrow, sized by speed so faster stations read as "louder" on the map.
        const speedScale = hasWind ? Math.min(1.6, 0.7 + (a.wspd ?? 0) / 18) : 1;

        return (
          <g
            key={`marker-${a.icaoId}`}
            onMouseEnter={() => onHover(a.icaoId)}
            onMouseLeave={() => onHover(null)}
            style={{ cursor: "pointer" }}
          >
            {active && <circle cx={p.x} cy={p.y} r={11} fill="none" stroke="var(--accent)" strokeWidth={1} opacity={0.5} />}
            {hasWind ? (
              <g transform={`translate(${p.x} ${p.y}) rotate(${a.wdir}) scale(${speedScale})`}>
                <path d="M0,-8 L5,5 L0,1.5 L-5,5 Z" fill={color} stroke={color} />
              </g>
            ) : (
              <circle cx={p.x} cy={p.y} r={a.upwind || active ? 5 : 3.5} fill="var(--panel-2)" stroke={color} strokeWidth={1.25} />
            )}
            {/* Wider invisible hit target so hover is easy to land on small markers. */}
            <circle cx={p.x} cy={p.y} r={10} fill="transparent" />
          </g>
        );
      })}

      {placed.map(({ a }) => {
        const label = labelById.get(a.icaoId);
        if (!label) return null;
        const lp = polar(label.angle, label.labelR, CX, CY);
        const code = a.icaoId.replace(/^K/, "");
        const speed = speedLabel(a);
        const text = `${code} · ${speed}`;
        const w = text.length * 5.4 + 6;
        const active = a.icaoId === hoveredId;
        return (
          <g
            key={`label-${a.icaoId}`}
            onMouseEnter={() => onHover(a.icaoId)}
            onMouseLeave={() => onHover(null)}
            style={{ cursor: "pointer" }}
          >
            <rect
              x={lp.x - w / 2}
              y={lp.y - 8}
              width={w}
              height={13}
              rx={3}
              fill="var(--panel)"
              stroke={active ? "var(--accent)" : "none"}
              strokeWidth={1}
              opacity={active ? 1 : 0.85}
            />
            <text
              x={lp.x}
              y={lp.y + 2}
              textAnchor="middle"
              fontSize="9"
              fontWeight={a.upwind || active ? 700 : 400}
              fill={a.upwind || active ? "var(--accent)" : "var(--ink)"}
            >
              <tspan fontWeight={700}>{code}</tspan>
              <tspan fill="var(--ink-faint)" fontWeight={400}>
                {" "}
                · {speed}
              </tspan>
            </text>
          </g>
        );
      })}

      <circle cx={CX} cy={CY} r={4} fill="var(--ink)" />
      <text x={CX} y={CY + 17} textAnchor="middle" fontSize="9" fill="var(--ink-faint)">
        MYC
      </text>
    </svg>
  );
}

export function AirportsWindCard() {
  const [data, setData] = useState<AirportsResponse | null>(null);
  const [error, setError] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/airports", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const j = (await res.json()) as AirportsResponse;
      setData(j);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  // DISABLED: API polling is off (see src/lib/features.ts). Uncomment to re-enable.
  // useEffect(() => {
  //   load();
  //   const id = setInterval(load, 3 * 60_000);
  //   return () => clearInterval(id);
  // }, [load]);

  const upwind = useMemo(() => data?.airports.filter((a) => a.upwind) ?? [], [data]);

  return (
    <div className="rounded-lg border border-[var(--hairline)] bg-[var(--panel)] p-6">
      <div className="mb-5 flex items-baseline justify-between">
        <h3 className={LABEL}>Nearby airports · wind</h3>
        <span className="font-mono text-xs text-[var(--ink-faint)]">
          {data?.homeWindDir != null ? `home from ${compass(data.homeWindDir)}` : "—"}
        </span>
      </div>

      {error && !data ? (
        <div className="py-24 text-center font-mono text-sm text-[var(--ink-faint)]">Airport data unavailable</div>
      ) : !data ? (
        <div className="py-24 text-center font-mono text-sm text-[var(--ink-faint)]">Loading…</div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[420px_1fr]">
          <div className="mx-auto size-[420px]">
            <AirportsMap {...data} hoveredId={hoveredId} onHover={setHoveredId} />
          </div>

          <div className="divide-y divide-[var(--hairline)] self-center">
            {data.airports.map((a) => {
              const active = a.icaoId === hoveredId;
              return (
                <div
                  key={a.icaoId}
                  onMouseEnter={() => setHoveredId(a.icaoId)}
                  onMouseLeave={() => setHoveredId(null)}
                  className={`flex items-center justify-between gap-3 rounded-md px-2 py-4 font-mono text-sm transition-colors ${
                    active ? "bg-[var(--panel-2)]" : ""
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span className={`inline-block size-2 rounded-full ${a.upwind ? "bg-[var(--accent)]" : "bg-[var(--ink-faint)]"}`} />
                    <span className={a.upwind || active ? "font-semibold text-[var(--accent)]" : "text-[var(--ink)]"}>
                      {a.icaoId}
                    </span>
                    <span className="text-[var(--ink-faint)]">{Math.round(a.distanceNm)}nm {compass(a.bearingFromHome)}</span>
                  </div>
                  <div className="flex items-center gap-4 text-[var(--ink-soft)]">
                    <span>
                      {a.wdirVariable ? "VRB" : compass(a.wdir)}
                      {a.wspd != null ? ` ${Math.round(a.wspd)}` : " —"}
                      {a.wgst != null ? `G${Math.round(a.wgst)}` : ""} kt
                    </span>
                    <span className="text-[var(--ink-faint)]">{ageLabel(a.obsTime)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {data && upwind.length > 0 && (
        <p className="mt-4 font-mono text-xs text-[var(--ink-faint)]">
          {`Wind is arriving from the ${compass(data.homeWindDir)} — ${upwind.map((a) => a.icaoId).join(", ")} ${
            upwind.length === 1 ? "sits upwind, so its" : "sit upwind, so their"
          } current conditions are a rough preview of what's next here.`}
        </p>
      )}
    </div>
  );
}
