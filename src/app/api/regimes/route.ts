import { NextRequest, NextResponse } from "next/server";
import { getRegimes } from "@/lib/db";
import { getStation } from "@/lib/stations";

export const dynamic = "force-dynamic";

// GET /api/regimes?limit=200&minSig=0&source=myc  → logged regimes, newest first.
export async function GET(req: NextRequest) {
  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 200, 1), 1000);
  const minSig = Math.min(Math.max(Number(req.nextUrl.searchParams.get("minSig")) || 0, 0), 1);
  const source = getStation(req.nextUrl.searchParams.get("source")).id;
  try {
    const rows = await getRegimes(limit, minSig, source);
    return NextResponse.json({ rows }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
