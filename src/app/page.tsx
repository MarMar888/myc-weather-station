import { redirect } from "next/navigation";
import { DEFAULT_STATION, DEFAULT_TAB, stationPath } from "@/lib/stations";

// The dashboard lives at /[station]/[tab]; send the bare root to the default.
export default function Home() {
  redirect(stationPath(DEFAULT_STATION, DEFAULT_TAB));
}
