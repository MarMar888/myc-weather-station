import { NextResponse } from "next/server";
import { fetchMetars } from "@/lib/metar";
import { HOME, NEARBY_AIRPORT_IDS, bearingDeg, distanceNm, angleDiff } from "@/lib/airports";
import { getLatest, getLatestAirportReadings, type AirportReading } from "@/lib/db";
import { apisEnabled, apisDisabled } from "@/lib/features";

export const dynamic = "force-dynamic";

// Upwind cone half-width: an airport within this many degrees of the home
// station's current wind-from direction is treated as "showing what's next".
const UPWIND_CONE_DEG = 30;

interface StationLike {
  icaoId: string;
  name: string | null;
  lat: number;
  lon: number;
  obsTime: number | null; // epoch seconds
  wdir: number | null;
  wdirVariable: boolean;
  wspd: number | null;
  wgst: number | null;
}

function fromLogged(r: AirportReading): StationLike {
  return {
    icaoId: r.icao_id,
    name: r.name,
    lat: r.lat,
    lon: r.lon,
    obsTime: Math.round(r.observed_at / 1000),
    wdir: r.wdir,
    wdirVariable: r.wdir_variable,
    wspd: r.wspd,
    wgst: r.wgst,
  };
}

export async function GET() {
  if (!apisEnabled()) return apisDisabled();
  try {
    // The cron job logs every nearby airport on the same cadence as the home
    // station, so normally we just read that back — no live third-party
    // call on every dashboard load. Only airports still in the configured
    // list are used (drops stale rows for airports removed from config).
    // Any configured airport not yet logged (e.g. just added, before the
    // next cron tick) is fetched live so the widget doesn't have a gap.
    const [logged, latest] = await Promise.all([getLatestAirportReadings(), getLatest()]);
    const idSet = new Set(NEARBY_AIRPORT_IDS);
    const loggedStations = logged.filter((r) => idSet.has(r.icao_id)).map(fromLogged);
    const loggedIds = new Set(loggedStations.map((s) => s.icaoId));
    const missingIds = NEARBY_AIRPORT_IDS.filter((id) => !loggedIds.has(id));
    const liveStations = missingIds.length > 0 ? await fetchMetars(missingIds).catch(() => []) : [];
    const stations: StationLike[] = [...loggedStations, ...liveStations];

    const homeWindDir = typeof latest?.wind_dir === "number" ? latest.wind_dir : null;

    const airports = stations
      .map((m) => {
        const bearingFromHome = bearingDeg(HOME, m);
        const dist = distanceNm(HOME, m);
        const upwind =
          homeWindDir != null && angleDiff(bearingFromHome, homeWindDir) <= UPWIND_CONE_DEG;
        return { ...m, bearingFromHome, distanceNm: dist, upwind };
      })
      .sort((a, b) => a.distanceNm - b.distanceNm);

    return NextResponse.json(
      { home: HOME, homeWindDir, airports },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
