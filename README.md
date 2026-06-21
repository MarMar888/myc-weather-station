# MYC Weather Station

Live + historical wind dashboard for **Minnetonka Yacht Club**, pulled from a WeatherLink
embeddable page into **Turso** (libSQL), with a quant oscillation analyzer for sailors.

**Live:** https://myc-weather-station.vercel.app

## What it does
- **Live tab** — wind-first instrument panel: current speed/gust/direction compass, plus temp,
  humidity, barometer, dew point, rain. Historical charts (6h/24h/7d/30d). kts/mph toggle,
  dark/light mode. On wide screens, telemetry rails sit in the page margins.
- **Oscillation tab** — the data picks the time periods, not you. Change-point detection splits
  the last 3h into **regimes**; each is classified (oscillating / veering / backing / steady / calm)
  with quant time-series stats on the unwrapped direction: AR(1)/Ornstein-Uhlenbeck half-life,
  trend significance (t-stat/p), circular volatility, swing period, Hurst (Day lens), gust factor.
  Everything is gated on sample size and has a plain-English gloss + "show the math".

## How it works
| Piece | File | Notes |
| --- | --- | --- |
| Fetch + normalize | `src/lib/weatherlink.ts` | Reads WeatherLink `summaryData/<id>` JSON; maps sensors to columns. |
| Storage | `src/lib/db.ts` | Turso `readings` table keyed on `observed_at` (dedupes); prunes >360 days. |
| Extractor | `src/app/api/cron/route.ts` | Fetches one reading, inserts, prunes. Bearer `CRON_SECRET`; `?force=1` for manual. |
| APIs | `src/app/api/{history,live}/route.ts` | History (`?hours=N`) for charts; live = current conditions. |
| Stats | `src/lib/oscillation.ts` | Circular statistics + change-point detection + AR(1)/OU/Hurst. |
| UI | `src/app/page.tsx`, `src/components/` | Next.js 16, Tailwind v4, shadcn + Aceternity, recharts. |

## Scheduling
Vercel Hobby caps cron at once/day, so the extractor runs on **Upstash QStash** every **3 minutes**
(free tier, 480/day) hitting `/api/cron`. The WeatherLink source only updates ~once/minute, so 1-min
is the true ceiling; burst to 1-min via the QStash API during active study, then revert.

## Environment
```
TURSO_DATABASE_URL=libsql://...
TURSO_AUTH_TOKEN=...
WEATHERLINK_STATION_ID=25aa5d18618f41a8894a5ba0b092df3d
CRON_SECRET=...
```

## Local dev
```bash
pnpm install
pnpm dev                                          # http://localhost:3000
curl 'http://localhost:3000/api/cron?force=1'     # seed one reading
```

Contact: marley@squeakycleanboats.com
