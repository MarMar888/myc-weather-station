import { notFound, redirect } from "next/navigation";
import { DEFAULT_TAB, isStationId, stationPath } from "@/lib/stations";

// Bare station path (e.g. /mendota) → default tab.
export default async function StationIndex({
  params,
}: {
  params: Promise<{ station: string }>;
}) {
  const { station } = await params;
  if (!isStationId(station)) notFound();
  redirect(stationPath(station, DEFAULT_TAB));
}
