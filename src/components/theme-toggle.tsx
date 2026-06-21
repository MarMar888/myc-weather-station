"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      aria-label="Toggle dark / light mode"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="inline-flex size-9 items-center justify-center rounded-md border border-[var(--hairline)] text-[var(--ink-soft)] transition-colors hover:text-[var(--ink)]"
    >
      {!mounted ? (
        <span className="size-4" />
      ) : isDark ? (
        // sun
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-4" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((d) => {
            const a = (d * Math.PI) / 180;
            return (
              <line
                key={d}
                x1={12 + Math.cos(a) * 7}
                y1={12 + Math.sin(a) * 7}
                x2={12 + Math.cos(a) * 9.5}
                y2={12 + Math.sin(a) * 9.5}
              />
            );
          })}
        </svg>
      ) : (
        // moon
        <svg viewBox="0 0 24 24" fill="currentColor" className="size-4">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}
