import { notFound } from "next/navigation";
import { Dashboard } from "@/components/dashboard";
import { isStationId, isTabSlug } from "@/lib/stations";

// /[station]/[tab] — e.g. /myc/live, /mendota/patterns. Station + tab both live
// in the URL so any view is shareable/bookmarkable.
export default async function Page({
  params,
}: {
  params: Promise<{ station: string; tab: string }>;
}) {
  const { station, tab } = await params;
  if (!isStationId(station)) notFound();
  if (!isTabSlug(tab)) notFound();
  return <Dashboard station={station} tab={tab} />;
}
