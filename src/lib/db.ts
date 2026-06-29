import { createClient, type Client } from "@libsql/client";
import { NUMERIC_COLUMNS, type Reading } from "./weatherlink";

let _client: Client | null = null;

export function db(): Client {
  if (_client) return _client;
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL is not set");
  _client = createClient({ url, authToken });
  return _client;
}

let _schemaReady: Promise<void> | null = null;

/** Create the readings table on first use (idempotent). */
export function ensureSchema(): Promise<void> {
  if (_schemaReady) return _schemaReady;
  const numericCols = NUMERIC_COLUMNS.map((c) => `  ${c} REAL`).join(",\n");
  const sql = `
    CREATE TABLE IF NOT EXISTS readings (
      observed_at INTEGER PRIMARY KEY,
      fetched_at INTEGER NOT NULL,
      owner_name TEXT,
${numericCols},
      raw_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_readings_observed_at ON readings (observed_at);
    CREATE TABLE IF NOT EXISTS alerts_state (
      key TEXT PRIMARY KEY,
      active INTEGER NOT NULL DEFAULT 0,
      last_sent INTEGER NOT NULL DEFAULT 0
    );
    -- Regimes are now computed on read from raw readings (see lib/regime-log.ts),
    -- so the old accumulating table is retired. Drop it to clear the overlapping
    -- near-duplicate rows it built up; nothing reads it any more.
    DROP TABLE IF EXISTS regimes;
  `;
  // executeMultiple runs the statements sequentially.
  _schemaReady = db()
    .executeMultiple(sql)
    .then(() => undefined);
  return _schemaReady;
}

const ALL_COLUMNS = [
  "observed_at",
  "fetched_at",
  "owner_name",
  ...NUMERIC_COLUMNS,
  "raw_json",
];

/**
 * Insert a reading. observed_at is the primary key, so re-polling between
 * station updates (same observed_at) is a no-op. Returns true if a new row
 * was written.
 */
export async function insertReading(reading: Reading): Promise<boolean> {
  await ensureSchema();
  const placeholders = ALL_COLUMNS.map(() => "?").join(", ");
  const values = ALL_COLUMNS.map((c) => reading[c] ?? null);
  const res = await db().execute({
    sql: `INSERT OR IGNORE INTO readings (${ALL_COLUMNS.join(
      ", ",
    )}) VALUES (${placeholders})`,
    args: values as (number | string | null)[],
  });
  return res.rowsAffected > 0;
}

/** Delete readings older than `days` days. Returns rows removed. */
export async function pruneOlderThan(days: number): Promise<number> {
  await ensureSchema();
  const cutoff = Date.now() - days * 86_400_000;
  const res = await db().execute({
    sql: "DELETE FROM readings WHERE observed_at < ?",
    args: [cutoff],
  });
  return res.rowsAffected;
}

export interface HistoryRow {
  observed_at: number;
  [column: string]: number | string | null;
}

/** Return readings from the last `hours` hours, oldest first. */
export async function getHistory(hours: number): Promise<HistoryRow[]> {
  await ensureSchema();
  const since = Date.now() - hours * 3600_000;
  // Skip the bulky raw_json blob for chart queries.
  const cols = ["observed_at", "fetched_at", "owner_name", ...NUMERIC_COLUMNS];
  const res = await db().execute({
    sql: `SELECT ${cols.join(
      ", ",
    )} FROM readings WHERE observed_at >= ? ORDER BY observed_at ASC`,
    args: [since],
  });
  return res.rows as unknown as HistoryRow[];
}

/** Return the single most recent reading. */
export async function getLatest(): Promise<HistoryRow | null> {
  await ensureSchema();
  const cols = ["observed_at", "fetched_at", "owner_name", ...NUMERIC_COLUMNS];
  const res = await db().execute(
    `SELECT ${cols.join(
      ", ",
    )} FROM readings ORDER BY observed_at DESC LIMIT 1`,
  );
  return (res.rows[0] as unknown as HistoryRow) ?? null;
}

// ---- alert cooldown state -------------------------------------------------

export interface AlertState {
  active: number; // 1 while the condition is currently "armed/firing"
  last_sent: number; // epoch ms of the last email for this key
}

/** Read the cooldown/edge state for one alert key (defaults to inactive). */
export async function getAlertState(key: string): Promise<AlertState> {
  await ensureSchema();
  const res = await db().execute({
    sql: "SELECT active, last_sent FROM alerts_state WHERE key = ?",
    args: [key],
  });
  const r = res.rows[0] as unknown as AlertState | undefined;
  return r ? { active: Number(r.active), last_sent: Number(r.last_sent) } : { active: 0, last_sent: 0 };
}

/** Upsert the cooldown/edge state for one alert key. */
export async function setAlertState(key: string, state: AlertState): Promise<void> {
  await ensureSchema();
  await db().execute({
    sql: `INSERT INTO alerts_state (key, active, last_sent) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET active = excluded.active, last_sent = excluded.last_sent`,
    args: [key, state.active, state.last_sent],
  });
}

// ---- logged regimes -------------------------------------------------------

export interface RegimeRow {
  start_t: number;
  end_t: number;
  closed: number;
  type: string | null;
  type_label: string | null;
  confidence: string | null;
  significance: number | null;
  duration_min: number | null;
  count: number | null;
  mean_dir: number | null;
  amplitude: number | null;
  net_shift: number | null;
  shift_rate: number | null;
  trend_t: number | null;
  trend_p: number | null;
  half_life_min: number | null;
  period_min: number | null;
  hurst: number | null;
  speed_mean: number | null;
  speed_min: number | null;
  speed_max: number | null;
  gust_factor: number | null;
  speed_rate: number | null;
  gloss: string | null;
  updated_at: number;
}

export async function getStats(): Promise<{
  count: number;
  first: number | null;
  last: number | null;
}> {
  await ensureSchema();
  const res = await db().execute(
    "SELECT COUNT(*) AS count, MIN(observed_at) AS first, MAX(observed_at) AS last FROM readings",
  );
  const r = res.rows[0] as unknown as {
    count: number;
    first: number | null;
    last: number | null;
  };
  return { count: r.count, first: r.first, last: r.last };
}
