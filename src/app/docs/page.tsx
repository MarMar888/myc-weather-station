import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Station Docs — MYC Weather",
  description: "Location context and notes for the Minnetonka Yacht Club weather station.",
};

const LABEL = "text-[10px] font-mono font-medium uppercase tracking-[0.2em] text-[var(--ink-faint)]";

export default function DocsPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-16 font-mono">
      <div className="mb-10">
        <p className={LABEL}>MYC Weather Station</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--ink)]">
          Station Documentation
        </h1>
      </div>

      <section className="mb-10 space-y-4 border-l-2 border-[var(--hairline)] pl-5">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-[var(--ink-faint)]">Location</h2>
        <p className="text-sm leading-7 text-[var(--ink-soft)]">
          The weather station is mounted at the{" "}
          <span className="text-[var(--ink)]">Minnetonka Yacht Club</span> on Lake
          Minnetonka. Its precise position on the lake significantly shapes every reading
          it produces — wind in particular is strongly influenced by the surrounding
          geography.
        </p>
      </section>

      <section className="mb-10 space-y-4">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-[var(--ink-faint)]">Surrounding Geography</h2>
        <div className="overflow-hidden rounded border border-[var(--hairline)]">
          {[
            {
              bearing: "N / NNE",
              landmark: "Northome",
              note:
                "Land to the north-northeast. Northerly and NNE winds travel over open lake before reaching the station, typically arriving with less obstruction.",
            },
            {
              bearing: "E",
              landmark: "Deephaven",
              note:
                "Shoreline and residential land to the east. Easterly winds will be modified by the terrain and tree cover in Deephaven before hitting the sensor.",
            },
            {
              bearing: "S",
              landmark: "Cottagewood + Carson's Bay",
              note:
                "Cottagewood and Carson's Bay sit to the south. Southerly flow crosses open water in the bay, which can accelerate lake-effect gusts.",
            },
          ].map((row, i) => (
            <div
              key={row.bearing}
              className={`grid grid-cols-[80px_1fr] gap-4 p-4 text-sm ${
                i !== 0 ? "border-t border-[var(--hairline)]" : ""
              } bg-[var(--panel)]`}
            >
              <div>
                <div className="text-[10px] uppercase tracking-[0.15em] text-[var(--ink-faint)]">
                  {row.bearing}
                </div>
                <div className="mt-1 text-[var(--ink)]">{row.landmark}</div>
              </div>
              <p className="text-[var(--ink-soft)] leading-6">{row.note}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mb-10 space-y-4">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-[var(--ink-faint)]">Reading Guidance</h2>
        <ul className="space-y-3 text-sm text-[var(--ink-soft)] leading-7">
          <li className="flex gap-3">
            <span className="mt-0.5 text-[var(--accent)]">—</span>
            <span>
              <span className="text-[var(--ink)]">Wind from the north</span> has the
              longest unobstructed fetch across the lake, so reported speeds tend to be
              representative.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="mt-0.5 text-[var(--accent)]">—</span>
            <span>
              <span className="text-[var(--ink)]">Wind from the east</span> passes through
              land cover in Deephaven before reaching the station; readings may understate
              open-lake conditions.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="mt-0.5 text-[var(--accent)]">—</span>
            <span>
              <span className="text-[var(--ink)]">Southerly gusts</span> can be amplified
              by the open-water corridor across Carson's Bay.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="mt-0.5 text-[var(--accent)]">—</span>
            <span>
              Data updates every 3 minutes. The 2-minute gust is the most useful
              short-term indicator for on-water decisions.
            </span>
          </li>
        </ul>
      </section>

      <section className="space-y-2 border-t border-[var(--hairline)] pt-6">
        <h2 className="text-[10px] uppercase tracking-[0.2em] text-[var(--ink-faint)]">Hardware</h2>
        <p className="text-sm text-[var(--ink-soft)] leading-7">
          Davis Instruments Vantage Vue with WeatherLink Console. Data is collected via the
          WeatherLink cloud API and stored in a 360-day rolling database.
        </p>
      </section>

      <div className="mt-12">
        <a
          href="/"
          className="text-[10px] uppercase tracking-[0.2em] text-[var(--ink-faint)] transition-colors hover:text-[var(--accent)]"
        >
          ← Back to Dashboard
        </a>
      </div>
    </main>
  );
}
