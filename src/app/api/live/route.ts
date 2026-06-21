import { NextResponse } from "next/server";
import { fetchReading } from "@/lib/weatherlink";

export const dynamic = "force-dynamic";

// Live current conditions pulled straight from WeatherLink (no DB write).
export async function GET() {
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
