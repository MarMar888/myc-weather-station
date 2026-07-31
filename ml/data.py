"""Pull Lake Mendota buoy 1-minute wind history from the SSEC MetObs API.

Decoupled from the app: hits the public endpoint directly (no auth), so this
runs anywhere — your laptop, GitHub Actions, Colab. Wind is returned in m/s;
we convert to knots to match how the app logs regimes.

  https://metobs-test.ssec.wisc.edu/api/data.json
    ?symbols=mendota.buoy.<sym>:...&begin=<t>&interval=1m&order=column

GOTCHA (learned the hard way): with fully-qualified symbols you must NOT also
pass site/inst — that 400s. The buoy is seasonal, so winter days come back
empty (num_results 0).
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

CACHE_PATH = os.path.join(os.path.dirname(__file__), "data", "cache.db")

BASE = "https://metobs-test.ssec.wisc.edu/api/data.json"
WIND_SYMBOLS = [
    "mendota.buoy.wind_speed",      # m/s
    "mendota.buoy.wind_direction",  # deg
    "mendota.buoy.gust",            # m/s, 2-min max
    "mendota.buoy.run_wind_speed",  # m/s, 2-min avg
]
# Lake-breeze index inputs: LAND air temp (AOSS tower, on the UW shore) vs LAKE
# surface temp (buoy 0 m). Both °C. The contrast drives the afternoon breeze.
BREEZE_SYMBOLS = [
    "aoss.tower.air_temp",          # land air, °C
    "mendota.buoy.water_temp_1",    # lake surface, °C
]
MS_TO_KNOTS = 1.943844
KNOTS_TO_MS = 0.514444


@dataclass
class Sample:
    t: float          # epoch ms (UTC)
    dir: float | None  # degrees
    speed: float | None  # knots
    gust: float | None   # knots
    air_c: float | None = None    # land air temp (AOSS tower), °C
    water_c: float | None = None  # lake surface temp (buoy 0 m), °C


def _api_ts(dt: datetime) -> str:
    # "2025-07-15T00:00:00" — UTC, no millis/Z
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def fetch_window(begin: datetime, end: datetime, interval: str = "1m",
                 with_breeze: bool = True) -> list[Sample]:
    syms = WIND_SYMBOLS + (BREEZE_SYMBOLS if with_breeze else [])
    qs = urllib.parse.urlencode(
        {
            "symbols": ":".join(syms),
            "begin": _api_ts(begin),
            "end": _api_ts(end),
            "interval": interval,
            "order": "column",
        }
    )
    url = f"{BASE}?{qs}"
    req = urllib.request.Request(url, headers={"User-Agent": "myc-weather-station-ml/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode())
    if body.get("status") != "success":
        raise RuntimeError(f"Mendota API error: {body.get('status')} ({body.get('code')})")

    data = (body.get("results") or {}).get("data") or {}
    stamps = (body.get("results") or {}).get("timestamps") or []

    def col(sym: str) -> list:
        return data.get(sym) or [None] * len(stamps)

    ws, wd, gu, rw = (col(s) for s in WIND_SYMBOLS)
    air = col("aoss.tower.air_temp")
    water = col("mendota.buoy.water_temp_1")

    def num(v):
        # The API can return JSON `NaN` (not null) for missing values — esp. on
        # cross-site queries where grids don't perfectly align. NaN passes an
        # `is not None` check and poisons unwrap()/means, so coerce it to None.
        if v is None:
            return None
        try:
            f = float(v)
        except (TypeError, ValueError):
            return None
        return None if f != f else f  # f != f ⇒ NaN

    out: list[Sample] = []
    for i, ts in enumerate(stamps):
        # ISO "...Z" → epoch ms
        t = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000.0
        sp, gv = num(ws[i]), num(gu[i])
        out.append(
            Sample(
                t=t,
                dir=num(wd[i]),
                speed=sp * MS_TO_KNOTS if sp is not None else None,
                gust=gv * MS_TO_KNOTS if gv is not None else None,
                air_c=num(air[i]),
                water_c=num(water[i]),
            )
        )
    return out


def lake_breeze_index(speed_kt: float | None, air_c: float | None,
                      water_c: float | None) -> tuple[float | None, float | None]:
    """Lyons-style lake-breeze index ε ∝ U²/ΔT, ΔT = land air − lake water (°C).

    Returns (ΔT, ε). ε rises with light wind over a warm-land/cool-water
    contrast — the classic breeze setup. ε = 0 when water ≥ land (no forcing).
    The dimensional constant is folded out, so treat ε as a relative covariate
    to be threshold-calibrated on Mendota (literature critical values ~2–6 are
    for the specific dimensional form). Feeds the HSMM (duration covariate) and
    the forecaster (feature).
    """
    if air_c is None or water_c is None:
        return None, None
    dt = air_c - water_c
    if dt <= 0:
        return dt, 0.0
    u = (speed_kt or 0.0) * KNOTS_TO_MS
    return dt, (u * u) / dt


def _cache_conn() -> sqlite3.Connection:
    os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
    conn = sqlite3.connect(CACHE_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS samples ("
        "t INTEGER PRIMARY KEY, dir REAL, speed REAL, gust REAL, air_c REAL, water_c REAL)"
    )
    # A row here marks a completed UTC day (n rows stored), so we never re-fetch
    # it — including empty winter days (n=0).
    conn.execute("CREATE TABLE IF NOT EXISTS days (day TEXT PRIMARY KEY, n INTEGER)")
    return conn


def fetch_history(days: int, *, interval: str = "1m", sleep_s: float = 0.4,
                  log=print, cache: bool = True) -> list[Sample]:
    """Pull `days` of history, one UTC day per request, gentle on the API.

    Completed UTC days are cached to a local SQLite db (ml/data/cache.db) so
    reruns don't re-request from the API — only missing days and the current
    (partial) day are fetched. Empty (winter) days are cached too. cache=False
    bypasses. Only the canonical 1-min interval is cached.
    """
    use_cache = cache and interval == "1m"
    conn = _cache_conn() if use_cache else None
    have = {r[0] for r in conn.execute("SELECT day FROM days")} if conn else set()

    now = datetime.now(timezone.utc).replace(microsecond=0)
    today = now.strftime("%Y-%m-%d")
    start = (now - timedelta(days=days)).replace(hour=0, minute=0, second=0)

    samples: list[Sample] = []
    fetched = hits = 0
    day = start
    while day < now:
        nxt = min(day + timedelta(days=1), now)
        key = day.strftime("%Y-%m-%d")

        if conn is not None and key in have and key != today:
            lo, hi = int(day.timestamp() * 1000), int(nxt.timestamp() * 1000)
            rows = conn.execute(
                "SELECT t,dir,speed,gust,air_c,water_c FROM samples WHERE t>=? AND t<? ORDER BY t",
                (lo, hi),
            ).fetchall()
            samples.extend(Sample(*r) for r in rows)
            hits += 1
            day = nxt
            continue

        try:
            rows = fetch_window(day, nxt, interval)
            if conn is not None:
                conn.executemany(
                    "INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?,?)",
                    [(int(s.t), s.dir, s.speed, s.gust, s.air_c, s.water_c) for s in rows],
                )
                if key != today:  # don't mark the partial current day as complete
                    conn.execute("INSERT OR REPLACE INTO days VALUES (?,?)", (key, len(rows)))
                conn.commit()
            if rows:
                samples.extend(rows)
                fetched += 1
                if log:
                    log(f"{key}  +{len(rows):4d}  (total {len(samples)})")
        except Exception as e:  # noqa: BLE001 — keep going, log it
            if log:
                log(f"{key}  ERROR {e}")
        day = nxt
        time.sleep(sleep_s)

    if conn is not None:
        conn.close()
    if log:
        log(f"\n{len(samples)} samples · {fetched} days fetched · {hits} days from cache.")
    return samples
