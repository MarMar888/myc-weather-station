import { NextResponse } from "next/server";

// Kill switches. Everything here is OFF unless explicitly enabled via env, so
// a missing variable can never turn on external calls, DB writes, or emails.

/** Master switch for every /api route (live fetches, DB reads, cron ingest/backfill). */
export function apisEnabled(): boolean {
  return process.env.ENABLE_APIS === "1";
}

/** Switch for outbound pipeline-health emails (also requires apisEnabled()). */
export function alertsEnabled(): boolean {
  return apisEnabled() && process.env.ENABLE_ALERTS === "1";
}

/** Response returned by every API route while apisEnabled() is false. */
export function apisDisabled() {
  return NextResponse.json(
    { ok: false, error: "APIs are disabled (set ENABLE_APIS=1 to enable)" },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
