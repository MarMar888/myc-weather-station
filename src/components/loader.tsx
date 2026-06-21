// Cool dot-grid loader. The `.loader` element animates via box-shadow offsets
// that span ~57px, so it's centered inside a padded min-height box.

export function Loader({ label, minH = 220 }: { label?: string; minH?: number }) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-6"
      style={{ minHeight: minH }}
      role="status"
      aria-live="polite"
    >
      <span className="loader" />
      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--ink-faint)]">
        {label ?? "Loading"}
      </span>
    </div>
  );
}
