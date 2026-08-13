// Fetches and normalizes current METAR observations from the NWS/FAA
// aviationweather.gov Data API (public, no key required).

const METAR_URL = "https://aviationweather.gov/api/data/metar";

export interface MetarStation {
  icaoId: string;
  name: string | null;
  lat: number;
  lon: number;
  obsTime: number | null; // epoch seconds
  wdir: number | null; // true degrees; null if calm/variable/unreported
  wdirVariable: boolean;
  wspd: number | null; // knots
  wgst: number | null; // knots
  rawOb: string | null;
}

interface RawMetar {
  icaoId?: string;
  name?: string;
  lat?: number;
  lon?: number;
  obsTime?: number;
  wdir?: number | string | null;
  wspd?: number | null;
  wgst?: number | null;
  rawOb?: string;
}

/** Fetch current METAR conditions for a set of ICAO identifiers. */
export async function fetchMetars(icaoIds: string[]): Promise<MetarStation[]> {
  if (icaoIds.length === 0) return [];
  const url = `${METAR_URL}?ids=${icaoIds.join(",")}&format=json`;
  const res = await fetch(url, {
    headers: { "User-Agent": "myc-weather-station/1.0" },
    next: { revalidate: 600 },
  });
  if (!res.ok) {
    throw new Error(`METAR fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as RawMetar[];
  return data
    .filter(
      (d): d is RawMetar & { icaoId: string; lat: number; lon: number } =>
        typeof d.icaoId === "string" &&
        typeof d.lat === "number" &&
        typeof d.lon === "number",
    )
    .map((d) => ({
      icaoId: d.icaoId,
      name: d.name ?? null,
      lat: d.lat,
      lon: d.lon,
      obsTime: typeof d.obsTime === "number" ? d.obsTime : null,
      wdir: typeof d.wdir === "number" ? d.wdir : null,
      wdirVariable: d.wdir === "VRB",
      wspd: typeof d.wspd === "number" ? d.wspd : null,
      wgst: typeof d.wgst === "number" ? d.wgst : null,
      rawOb: d.rawOb ?? null,
    }));
}
