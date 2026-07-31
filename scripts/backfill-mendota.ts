// One-time historical backfill for the Lake Mendota buoy.
//
// Pages through the past N days (default 1825 ≈ 5 years) one UTC day at a time
// at 1-minute resolution, inserting each day in a single batch. INSERT OR
// IGNORE makes it idempotent, so it's safe to re-run or resume. A short sleep
// between calls keeps it gentle on the SSEC API. The buoy is seasonal, so
// winter days come back empty and are skipped quietly.
//
// Run (needs tsx + Node 20.6+ for --env-file):
//   pnpm backfill:mendota            # 5 years
//   pnpm backfill:mendota 90         # last 90 days
//   BACKFILL_INTERVAL=5m pnpm backfill:mendota
//
// Requires TURSO_DATABASE_URL / TURSO_AUTH_TOKEN in the environment (the pnpm
// script loads .env.local for you).

import { fetchMendotaReadings } from "../src/lib/mendota";
import { ensureSchema, insertReadings } from "../src/lib/db";

const DAY_MS = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// "2025-07-15T00:00:00" — the API wants UTC without milliseconds/Z.
const apiTs = (ms: number) => new Date(ms).toISOString().slice(0, 19);

async function main() {
  const days = Number(process.argv[2] ?? process.env.BACKFILL_DAYS ?? 1825);
  const interval = process.env.BACKFILL_INTERVAL ?? "1m";
  const sleepMs = Number(process.env.BACKFILL_SLEEP_MS ?? 400);

  if (!process.env.TURSO_DATABASE_URL) {
    console.error("TURSO_DATABASE_URL is not set — did you load .env.local?");
    process.exit(1);
  }

  await ensureSchema();
  const now = Date.now();
  const start = now - days * DAY_MS;

  console.log(
    `Backfilling Lake Mendota buoy: ${days} days @ ${interval}, ${Math.round(
      sleepMs,
    )}ms between calls.\n`,
  );

  let fetched = 0;
  let inserted = 0;
  let daysWithData = 0;
  let errors = 0;
  let empties = 0;

  for (let t = start; t < now; t += DAY_MS) {
    const begin = apiTs(t);
    const end = apiTs(Math.min(t + DAY_MS, now));
    const label = begin.slice(0, 10);
    try {
      const rows = await fetchMendotaReadings({ begin, end, interval });
      if (rows.length) {
        const ins = await insertReadings(rows);
        fetched += rows.length;
        inserted += ins;
        daysWithData++;
        console.log(
          `${label}  fetched ${String(rows.length).padStart(4)}  new ${String(ins).padStart(4)}  ·  cum new ${inserted}`,
        );
      } else {
        empties++;
      }
    } catch (err) {
      errors++;
      console.warn(`${label}  ERROR  ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(sleepMs);
  }

  console.log(
    `\nDone. ${daysWithData} days with data · ${empties} empty days · ${fetched} rows fetched · ${inserted} new rows inserted · ${errors} errors.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
