// Fetches and normalizes data from a WeatherLink embeddable summary page.
//
// The embeddable page at
//   https://www.weatherlink.com/embeddablePage/show/<id>/summary
// is backed by a clean JSON endpoint:
//   https://www.weatherlink.com/embeddablePage/summaryData/<id>
// which returns the current conditions as an array of sensor readings.

const STATION_ID =
  process.env.WEATHERLINK_STATION_ID ?? "25aa5d18618f41a8894a5ba0b092df3d";

// Map of WeatherLink sensorDataTypeId -> our column name.
// Wind is the priority, but we capture everything the station reports.
export const SENSOR_MAP: Record<number, string> = {
  72: "wind_speed", // instantaneous wind speed (mph)
  73: "wind_dir", // wind direction (deg)
  74: "wind_avg_1min", // 1 min avg wind speed
  75: "wind_dir_1min", // 1 min scalar avg wind direction
  77: "wind_avg_2min", // 2 min avg wind speed
  80: "wind_gust_2min", // 2 min high wind speed (gust)
  82: "wind_avg_10min", // 10 min avg wind speed
  85: "wind_gust_10min", // 10 min high wind speed
  58: "temp", // temperature (F)
  59: "humidity", // relative humidity (%)
  60: "dew_point",
  61: "wet_bulb",
  62: "heat_index",
  89: "wind_chill",
  90: "thw_index",
  50: "barometer", // sea-level pressure (in Hg)
  51: "bar_trend", // barometric trend
  52: "abs_pressure", // station pressure (in Hg)
  63: "rain_rate", // in/h
  67: "rain_60min", // 60 min rain total (in)
  69: "rain_storm", // rain this storm (in)
};

// The numeric columns produced by SENSOR_MAP, in a stable order. Used by the
// DB layer to build the schema and insert statements.
export const NUMERIC_COLUMNS = Array.from(
  new Set(Object.values(SENSOR_MAP)),
);

export interface Reading {
  // Epoch ms when the station last reported. Unique key for dedup.
  observed_at: number;
  // Epoch ms when we fetched it.
  fetched_at: number;
  owner_name: string | null;
  raw_json: string;
  // Plus one optional number per NUMERIC_COLUMNS entry.
  [column: string]: number | string | null;
}

interface SummaryCondition {
  sensorDataTypeId: number;
  sensorDataName: string;
  value: number | string | null;
  unitLabel: string;
}

interface SummaryResponse {
  ownerName?: string;
  lastReceived?: number;
  currConditionValues?: SummaryCondition[];
}

export function summaryDataUrl(stationId: string = STATION_ID): string {
  return `https://www.weatherlink.com/embeddablePage/summaryData/${stationId}`;
}

/** Fetch current conditions and normalize into a flat Reading. */
export async function fetchReading(
  stationId: string = STATION_ID,
): Promise<Reading> {
  const res = await fetch(summaryDataUrl(stationId), {
    headers: { "User-Agent": "myc-weather-station/1.0" },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`WeatherLink fetch failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as SummaryResponse;

  const fetchedAt = Date.now();
  const reading: Reading = {
    observed_at: data.lastReceived ?? fetchedAt,
    fetched_at: fetchedAt,
    owner_name: data.ownerName ?? null,
    raw_json: JSON.stringify(data),
  };
  for (const col of NUMERIC_COLUMNS) reading[col] = null;

  for (const c of data.currConditionValues ?? []) {
    const col = SENSOR_MAP[c.sensorDataTypeId];
    if (!col) continue;
    const n =
      typeof c.value === "number" ? c.value : Number.parseFloat(String(c.value));
    reading[col] = Number.isFinite(n) ? n : null;
  }

  return reading;
}
