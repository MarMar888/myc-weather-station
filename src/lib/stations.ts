// Station ("tenant") registry — the single source of truth for the two readers
// this dashboard serves. A station's `id` is also the value stored in the
// `source` column of the readings/regimes tables, so the same string flows
// from the DB through the API down to the URL (/[station]/[tab]).

export type StationId = "myc" | "mendota";

export interface Station {
  id: StationId;
  /** Header title. */
  name: string;
  /** Compact label for the station dropdown. */
  short: string;
  /** Sub-headline under the title. */
  subtitle: string;
  /**
   * Whether this station reports air temperature / humidity / barometer / rain.
   * The buoy is wind-only, so its atmosphere panels are hidden.
   */
  hasAtmosphere: boolean;
  /** Footer cadence/retention blurb. */
  cadenceLabel: string;
  /** Footer "Source" link. */
  sourceLabel: string;
  sourceUrl: string;
}

export const STATIONS: Record<StationId, Station> = {
  myc: {
    id: "myc",
    name: "Minnetonka Yacht Club",
    short: "Minnetonka YC",
    subtitle: "Wind & weather telemetry",
    hasAtmosphere: true,
    cadenceLabel: "new data every 3 minutes · 5-year retention",
    sourceLabel: "WeatherLink",
    sourceUrl:
      "https://www.weatherlink.com/embeddablePage/show/25aa5d18618f41a8894a5ba0b092df3d/summary",
  },
  mendota: {
    id: "mendota",
    name: "Lake Mendota Buoy",
    short: "Lake Mendota",
    subtitle: "Wind telemetry · UW–Madison / SSEC buoy",
    hasAtmosphere: false,
    cadenceLabel: "new data every 5 minutes · seasonal buoy · 5-year retention",
    sourceLabel: "SSEC MetObs",
    sourceUrl: "https://metobs-test.ssec.wisc.edu/api/data",
  },
};

export const STATION_IDS = Object.keys(STATIONS) as StationId[];
export const STATION_LIST: Station[] = STATION_IDS.map((id) => STATIONS[id]);
export const DEFAULT_STATION: StationId = "myc";

export function isStationId(v: string | undefined | null): v is StationId {
  return v != null && Object.prototype.hasOwnProperty.call(STATIONS, v);
}

/** Resolve a (possibly untrusted) id to a Station, falling back to the default. */
export function getStation(id: string | undefined | null): Station {
  return isStationId(id) ? STATIONS[id] : STATIONS[DEFAULT_STATION];
}

// ---- tabs -----------------------------------------------------------------

export type TabSlug = "live" | "oscillation" | "patterns" | "log";

export interface TabDef {
  slug: TabSlug;
  label: string;
}

export const TABS: TabDef[] = [
  { slug: "live", label: "Live" },
  { slug: "oscillation", label: "Oscillation" },
  { slug: "patterns", label: "Patterns" },
  { slug: "log", label: "Log" },
];

export const DEFAULT_TAB: TabSlug = "live";

export function isTabSlug(v: string | undefined | null): v is TabSlug {
  return TABS.some((t) => t.slug === v);
}

/** Canonical dashboard path for a station + tab. */
export function stationPath(station: StationId, tab: TabSlug): string {
  return `/${station}/${tab}`;
}
