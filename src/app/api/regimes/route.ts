import { NextRequest, NextResponse } from "next/server";
import { getHistory } from "@/lib/db";
import { detectLoggableRegimes } from "@/lib/regime-log";

export const dynamic = "force-dynamic";

// GET /api/regimes?hours=48&minSig=0  → clean, non-overlapping regimes recomputed
// fresh from the raw readings (newest first). No accumulation, so the same period
// can never appear twice.
export async function GET(req: NextRequest) {
  const hours = Math.min(Math.max(Number(req.nextUrl.searchParams.get("hours")) || 48, 1), 168);
  const minSig = Math.min(Math.max(Number(req.nextUrl.searchParams.get("minSig")) || 0, 0), 1);
  try {
    const rows = await getHistory(hours);
    const regimes = detectLoggableRegimes(rows).filter((r) => (r.significance ?? 0) >= minSig);
    // Data only changes every ~3 min, so a short shared-cache window is plenty.
    return NextResponse.json(
      { rows: regimes },
      { headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=120" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
