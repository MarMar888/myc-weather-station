// Fetches and normalizes wind data from the SSEC MetObs API for the Lake
// Mendota buoy. The API returns column-major JSON keyed by fully-qualified
// symbol (e.g. "mendota.buoy.wind_speed") alongside an ISO-8601 timestamp
// array:
//
//   https://metobs-test.ssec.wisc.edu/api/data.json
//     ?site=mendota&inst=buoy&symbols=<a:b:c>&begin=<t>&interval=1m&order=column
//
// Wind is reported in m/s; we convert to mph on ingest so the buoy shares the
// exact same columns and unit handling as the WeatherLink (MYC) source — every
// chart, the kts/mph toggle, and the oscillation analytics work unchanged.
// The buoy is seasonal (pulled from the lake over winter), so empty results
// are normal and yield an empty array rather than an error.

import { NUMERIC_COLUMNS, type Reading } from "./weatherlink";

const SITE = "mendota";
const INST = "buoy";
const OWNER = "Lake Mendota Buoy";
const BASE = "https://metobs-test.ssec.wisc.edu/api/data.json";

// 1 m/s = 2.236936 mph.
const M_S_TO_MPH = 2.2369362921;

// Buoy symbol -> our column. Direction shares units (deg, no conversion);
// speeds convert m/s -> mph. gust = 2-min max, run_wind_speed = 2-min average,
// which line up with WeatherLink's wind_gust_2min / wind_avg_2min.
const SYMBOL_MAP: Record<string, { col: string; convert: boolean }> = {
  wind_speed: { col: "wind_speed", convert: true },
  wind_direction: { col: "wind_dir", convert: false },
  gust: { col: "wind_gust_2min", convert: true },
  run_wind_speed: { col: "wind_avg_2min", convert: true },
};

export const MENDOTA_SYMBOLS = Object.keys(SYMBOL_MAP);

function qualified(sym: string): string {
  return `${SITE}.${INST}.${sym}`;
}

interface ColumnResponse {
  code: number;
  status: string;
  num_results: number | string;
  results?: {
    data?: Record<string, (number | null)[]>;
    timestamps?: string[];
  };
}

export interface MendotaQuery {
  /** Relative ("-00:10:00") or absolute ("2025-07-15T00:00:00") UTC start. */
  begin: string;
  /** Optional UTC end (absolute or relative). Defaults to "now". */
  end?: string;
  /** "1m" | "5m" | "1h" (default "1m"). */
  interval?: string;
}

export function mendotaUrl(q: MendotaQuery): string {
  // Symbols are fully qualified ("mendota.buoy.<symbol>"), which already encodes
  // the site + instrument — passing `site`/`inst` as well is rejected (400).
  const params = new URLSearchParams({
    symbols: MENDOTA_SYMBOLS.map(qualified).join(":"),
    begin: q.begin,
    interval: q.interval ?? "1m",
    order: "column",
  });
  if (q.end) params.set("end", q.end);
  return `${BASE}?${params.toString()}`;
}

/**
 * Fetch a window of buoy readings and normalize into Reading rows (one per
 * timestamp), wind converted to mph and tagged source="mendota". Returns [] if
 * the buoy reported nothing for the window (e.g. winter). Throws on
 * network/HTTP failure so the caller can decide whether to swallow it.
 */
export async function fetchMendotaReadings(q: MendotaQuery): Promise<Reading[]> {
  const res = await fetch(mendotaUrl(q), {
    headers: { "User-Agent": "myc-weather-station/1.0" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Mendota fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as ColumnResponse;
  if (body.status !== "success") {
    throw new Error(`Mendota API error: ${body.status} (${body.code})`);
  }

  const data = body.results?.data ?? {};
  const timestamps = body.results?.timestamps ?? [];
  if (!timestamps.length) return [];

  const fetchedAt = Date.now();
  const readings: Reading[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const observedAt = Date.parse(timestamps[i]);
    if (!Number.isFinite(observedAt)) continue;

    const reading: Reading = {
      source: "mendota",
      observed_at: observedAt,
      fetched_at: fetchedAt,
      owner_name: OWNER,
      raw_json: "",
    };
    for (const col of NUMERIC_COLUMNS) reading[col] = null;

    const raw: Record<string, number | null> = {};
    let any = false;
    for (const sym of MENDOTA_SYMBOLS) {
      const series = data[qualified(sym)];
      const v = series ? series[i] : null;
      raw[sym] = v ?? null;
      if (v == null || !Number.isFinite(v)) continue;
      const { col, convert } = SYMBOL_MAP[sym];
      reading[col] = convert ? v * M_S_TO_MPH : v;
      any = true;
    }
    // Skip all-null rows so we never store hollow observations.
    if (!any) continue;
    reading.raw_json = JSON.stringify({ t: timestamps[i], v: raw, units: "m/s" });
    readings.push(reading);
  }
  return readings;
}

/** The single freshest buoy reading (for /api/live). null if none recently. */
export async function fetchLatestMendota(): Promise<Reading | null> {
  const rows = await fetchMendotaReadings({ begin: "-00:15:00", interval: "1m" });
  return rows.length ? rows[rows.length - 1] : null;
}
