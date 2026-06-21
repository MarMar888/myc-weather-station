import { NextRequest, NextResponse } from "next/server";
import { fetchReading } from "@/lib/weatherlink";
import { insertReading, pruneOlderThan } from "@/lib/db";
import { evaluatePipelineHealth } from "@/lib/alerts";
import { runRegimeLog } from "@/lib/regime-log";

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
    const reading = await fetchReading();
    const inserted = await insertReading(reading);
    const pruned = await pruneOlderThan(RETENTION_DAYS);
    // Pipeline-health check runs every poll but never blocks or fails the extract.
    const health = await evaluatePipelineHealth().catch(() => null);
    // Macro regime detection + logging; guarded so it never fails the extract.
    const regimes = await runRegimeLog().catch(() => null);
    return NextResponse.json({
      ok: true,
      recorded: true,
      inserted, // false when this observation was already stored
      pruned, // rows deleted for being older than RETENTION_DAYS
      health, // { configured, status, sent }
      regimes, // { detected, logged }
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
