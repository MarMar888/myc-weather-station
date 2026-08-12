// Home station location and nearby airport identifiers, plus the geo math
// needed to place airports relative to the station on a bearing/distance map.

export const HOME = { lat: 44.92387, lon: -93.53334 };

// METAR/AWOS-reporting airports around Lake Minnetonka, MN. The METAR API
// returns each airport's actual lat/lon, so only the identifiers live here.
export const NEARBY_AIRPORT_IDS = [
  "KMSP", // Minneapolis-St Paul Intl
  "KFCM", // Flying Cloud (Eden Prairie)
  "KANE", // Anoka County-Blaine
  "KSTP", // St Paul Downtown
  "KLVN", // Airlake (Lakeville)
  "KMIC", // Crystal
  "KGYL", // Glencoe (WSW)
  "KCFE", // Buffalo Muni (NW)
  "KHCD", // Hutchinson/Butler Field (W)
  "KULM", // New Ulm Muni (SW)
];

const EARTH_RADIUS_NM = 3440.065;

export interface LatLon {
  lat: number;
  lon: number;
}

/** Great-circle distance between two points, in nautical miles. */
export function distanceNm(a: LatLon, b: LatLon): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(h));
}

/** True bearing from a to b, in degrees (0-360, 0 = north). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest angular difference between two compass bearings, in degrees (0-180). */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}
