import { NextRequest, NextResponse } from "next/server";
import { fetchReading } from "@/lib/weatherlink";
import { fetchLatestMendota } from "@/lib/mendota";
import { getStation } from "@/lib/stations";

export const dynamic = "force-dynamic";

// Live current conditions pulled straight from the source (no DB write).
// MYC → WeatherLink; Mendota → the freshest buoy reading (null off-season).
export async function GET(req: NextRequest) {
  const source = getStation(req.nextUrl.searchParams.get("source")).id;
  try {
    const reading =
      source === "mendota" ? await fetchLatestMendota() : await fetchReading();
    return NextResponse.json(reading, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
