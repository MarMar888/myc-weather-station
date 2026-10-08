import { NextResponse } from "next/server";
import { fetchReading } from "@/lib/weatherlink";
import { apisEnabled, apisDisabled } from "@/lib/features";

export const dynamic = "force-dynamic";

// Live current conditions pulled straight from WeatherLink (no DB write).
export async function GET() {
  if (!apisEnabled()) return apisDisabled();
  try {
    const reading = await fetchReading();
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
