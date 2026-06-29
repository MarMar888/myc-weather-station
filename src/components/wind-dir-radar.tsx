"use client";

import { useMemo } from "react";

export function WindDirRadar({ series }: { series: { dir: number | null }[] }) {
  const R = 80;
  const CX = 100;
  const CY = 100;
  const LABELS: [string, number][] = [
    ["N", 0], ["NE", 2], ["E", 4], ["SE", 6],
    ["S", 8], ["SW", 10], ["W", 12], ["NW", 14],
  ];

  const weights = useMemo(() => {
    const counts = new Array(16).fill(0);
    let total = 0;
    for (const s of series) {
      if (s.dir == null) continue;
      const idx = Math.round(s.dir / 22.5) % 16;
      counts[idx]++;
      total++;
    }
    return total > 0 ? counts.map((c) => c / total) : counts;
  }, [series]);

  const maxW = Math.max(...weights, 0.001);

  return (
    <svg viewBox="0 0 200 200" className="size-full">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <circle key={f} cx={CX} cy={CY} r={R * f} fill="none" stroke="var(--grid)" strokeWidth={0.75} />
      ))}
      {weights.map((w, i) => {
        const angleDeg = i * 22.5 - 90;
        const rad = (angleDeg * Math.PI) / 180;
        const len = Math.max(3, (w / maxW) * R);
        return (
          <line
            key={i}
            x1={CX}
            y1={CY}
            x2={CX + Math.cos(rad) * len}
            y2={CY + Math.sin(rad) * len}
            stroke="var(--accent)"
            strokeWidth={7}
            strokeLinecap="round"
            opacity={0.55 + (w / maxW) * 0.45}
          />
        );
      })}
      {LABELS.map(([label, idx]) => {
        const angleDeg = idx * 22.5 - 90;
        const rad = (angleDeg * Math.PI) / 180;
        return (
          <text
            key={label}
            x={CX + Math.cos(rad) * (R + 13)}
            y={CY + Math.sin(rad) * (R + 13) + 4}
            textAnchor="middle"
            fontSize="10"
            fill="var(--ink-faint)"
            fontFamily="var(--font-geist-mono)"
          >
            {label}
          </text>
        );
      })}
      <circle cx={CX} cy={CY} r={2.5} fill="var(--ink-faint)" />
    </svg>
  );
}
