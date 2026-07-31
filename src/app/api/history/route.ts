import { NextRequest, NextResponse } from "next/server";
import { getHistory, getLatest, getStats } from "@/lib/db";
import { getStation } from "@/lib/stations";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const hoursParam = req.nextUrl.searchParams.get("hours");
  const hours = Math.min(Math.max(Number(hoursParam) || 24, 1), 24 * 90);
  const source = getStation(req.nextUrl.searchParams.get("source")).id;
  try {
    const [rows, latest, stats] = await Promise.all([
      getHistory(hours, source),
      getLatest(source),
      getStats(source),
    ]);
    return NextResponse.json(
      { hours, source, rows, latest, stats },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
