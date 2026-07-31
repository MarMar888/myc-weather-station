import { NextRequest, NextResponse } from "next/server";
import { fetchReading } from "@/lib/weatherlink";
import { fetchMendotaReadings } from "@/lib/mendota";
import { insertReading, insertReadings, pruneOlderThan } from "@/lib/db";
import { evaluatePipelineHealth } from "@/lib/alerts";
import { runRegimeLog } from "@/lib/regime-log";
import { getPostHogClient } from "@/lib/posthog-server";

// Drop readings older than this on every run, so the table self-trims.
// 5 years — deep enough to train regime models on the Mendota buoy's history.
const RETENTION_DAYS = 1825;

// Never cache — this writes to the database on every invocation.
export const dynamic = "force-dynamic";

// Pull a short overlapping window of buoy data each run so we capture 1-minute
// resolution even though the cron fires every few minutes. INSERT OR IGNORE
// dedups the overlap.
async function extractMendota(): Promise<{
  inserted: number;
  regimes: unknown;
  error: string | null;
}> {
  try {
    const rows = await fetchMendotaReadings({ begin: "-00:10:00", interval: "1m" });
    const inserted = await insertReadings(rows);
    const regimes = await runRegimeLog("mendota").catch(() => null);
    return { inserted, regimes, error: null };
  } catch (err) {
    // The buoy is seasonal / on a test endpoint — never let it break the MYC extract.
    return { inserted: 0, regimes: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handle(req: NextRequest) {
  // The cloud scheduler (Upstash QStash) sends the secret as a Bearer token.
  // Require it in production; allow ?force=1 for manual/local triggering.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization");
  const force = req.nextUrl.searchParams.get("force") === "1";
  if (secret && auth !== `Bearer ${secret}` && !force) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    // --- MYC (WeatherLink) — the primary, alerting source ---
    const reading = await fetchReading();
    const inserted = await insertReading(reading);

    // --- Lake Mendota buoy — isolated so its failures don't affect MYC ---
    const mendota = await extractMendota();

    const pruned = await pruneOlderThan(RETENTION_DAYS);
    // Pipeline-health check runs every poll but never blocks the extract. It is
    // MYC-only by design — the buoy is seasonal and would false-alarm all winter.
    const health = await evaluatePipelineHealth().catch(() => null);
    // Macro regime detection + logging for MYC; guarded so it never fails the extract.
    const regimes = await runRegimeLog("myc").catch(() => null);

    if (inserted || mendota.inserted) {
      const posthog = getPostHogClient();
      posthog.capture({
        distinctId: "cron",
        event: "weather_reading_recorded",
        properties: {
          observed_at: reading.observed_at,
          wind_speed: reading.wind_speed,
          wind_gust_2min: reading.wind_gust_2min,
          wind_dir: reading.wind_dir,
          mendota_inserted: mendota.inserted,
          pruned,
        },
      });
    }

    return NextResponse.json({
      ok: true,
      recorded: true,
      inserted, // MYC: false when this observation was already stored
      mendota, // { inserted, regimes, error }
      pruned, // rows deleted for being older than RETENTION_DAYS
      health, // { configured, status, sent }
      regimes, // { detected, logged } for MYC
      observed_at: reading.observed_at,
      wind_speed: reading.wind_speed,
      wind_gust_2min: reading.wind_gust_2min,
      wind_dir: reading.wind_dir,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

// QStash defaults to GET here, but POST works too for manual triggers.
export async function POST(req: NextRequest) {
  return handle(req);
}
