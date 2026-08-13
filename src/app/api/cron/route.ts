import { NextRequest, NextResponse } from "next/server";
import { fetchReading } from "@/lib/weatherlink";
import { fetchMetars } from "@/lib/metar";
import { NEARBY_AIRPORT_IDS } from "@/lib/airports";
import { insertReading, insertAirportReadings, pruneOlderThan } from "@/lib/db";
import { evaluatePipelineHealth } from "@/lib/alerts";
import { getPostHogClient } from "@/lib/posthog-server";

// Drop readings older than this on every run, so the table self-trims.
const RETENTION_DAYS = 360;

// Never cache — this writes to the database on every invocation.
export const dynamic = "force-dynamic";

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
    const fetchedAt = Date.now();
    const [reading, metars] = await Promise.all([
      fetchReading(),
      fetchMetars(NEARBY_AIRPORT_IDS).catch(() => []),
    ]);
    const inserted = await insertReading(reading);
    const airportsLogged = await insertAirportReadings(
      metars
        .filter((m) => m.obsTime != null)
        .map((m) => ({
          icao_id: m.icaoId,
          observed_at: (m.obsTime as number) * 1000,
          fetched_at: fetchedAt,
          name: m.name,
          lat: m.lat,
          lon: m.lon,
          wdir: m.wdir,
          wdir_variable: m.wdirVariable,
          wspd: m.wspd,
          wgst: m.wgst,
          raw_ob: m.rawOb,
        })),
    );
    const pruned = await pruneOlderThan(RETENTION_DAYS);
    // Pipeline-health check runs every poll but never blocks or fails the extract.
    const health = await evaluatePipelineHealth().catch(() => null);

    if (inserted) {
      const posthog = getPostHogClient();
      posthog.capture({
        distinctId: "cron",
        event: "weather_reading_recorded",
        properties: {
          observed_at: reading.observed_at,
          wind_speed: reading.wind_speed,
          wind_gust_2min: reading.wind_gust_2min,
          wind_dir: reading.wind_dir,
          pruned,
        },
      });
    }

    return NextResponse.json({
      ok: true,
      recorded: true,
      inserted, // false when this observation was already stored
      airportsLogged, // new airport_readings rows written this run
      pruned, // rows deleted for being older than RETENTION_DAYS
      health, // { configured, status, sent }
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
