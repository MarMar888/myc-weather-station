import { NextRequest, NextResponse } from "next/server";
import { getHistory, getLatest, getStats } from "@/lib/db";
import { apisEnabled, apisDisabled } from "@/lib/features";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!apisEnabled()) return apisDisabled();
  const hoursParam = req.nextUrl.searchParams.get("hours");
  const hours = Math.min(Math.max(Number(hoursParam) || 24, 1), 24 * 90);
  try {
    const [rows, latest, stats] = await Promise.all([
      getHistory(hours),
      getLatest(),
      getStats(),
    ]);
    return NextResponse.json(
      { hours, rows, latest, stats },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
