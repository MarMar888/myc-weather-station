import { createClient, type Client } from "@libsql/client";
import { NUMERIC_COLUMNS, type Reading } from "./weatherlink";
import { DEFAULT_STATION, type StationId } from "./stations";

let _client: Client | null = null;

export function db(): Client {
  if (_client) return _client;
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw new Error("TURSO_DATABASE_URL is not set");
  _client = createClient({ url, authToken });
  return _client;
}

// ---- schema ---------------------------------------------------------------
//
// Both data tables are multi-tenant: a `source` column tags each row with the
// station it came from ('myc', 'mendota', …), and the primary key is composite
// — (source, observed_at) for readings, (source, start_t) for regimes — so two
// stations can report at the same instant without colliding.

const READINGS_PK = ["source", "observed_at"] as const;

function readingsDdl(table = "readings"): string {
  const numericCols = NUMERIC_COLUMNS.map((c) => `      ${c} REAL`).join(",\n");
  return `CREATE TABLE IF NOT EXISTS ${table} (
      source TEXT NOT NULL DEFAULT 'myc',
      observed_at INTEGER NOT NULL,
      fetched_at INTEGER NOT NULL,
      owner_name TEXT,
${numericCols},
      raw_json TEXT,
      PRIMARY KEY (${READINGS_PK.join(", ")})
    )`;
}

const REGIMES_DDL = `CREATE TABLE IF NOT EXISTS regimes (
      source TEXT NOT NULL DEFAULT 'myc',
      start_t INTEGER NOT NULL,
      end_t INTEGER NOT NULL,
      closed INTEGER NOT NULL DEFAULT 0,
      type TEXT,
      type_label TEXT,
      confidence TEXT,
      significance REAL,
      duration_min REAL,
      count INTEGER,
      mean_dir REAL,
      amplitude REAL,
      net_shift REAL,
      shift_rate REAL,
      trend_t REAL,
      trend_p REAL,
      half_life_min REAL,
      period_min REAL,
      hurst REAL,
      speed_mean REAL,
      speed_min REAL,
      speed_max REAL,
      gust_factor REAL,
      speed_rate REAL,
      gloss TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (source, start_t)
    )`;

// Column lists used both for inserts and for the legacy → multi-tenant copy.
const READING_BODY_COLS = [
  "observed_at",
  "fetched_at",
  "owner_name",
  ...NUMERIC_COLUMNS,
  "raw_json",
];
const ALL_COLUMNS = ["source", ...READING_BODY_COLS];

const REGIME_COLS = [
  "start_t", "end_t", "closed", "type", "type_label", "confidence", "significance",
  "duration_min", "count", "mean_dir", "amplitude", "net_shift", "shift_rate",
  "trend_t", "trend_p", "half_life_min", "period_min", "hurst",
  "speed_mean", "speed_min", "speed_max", "gust_factor", "speed_rate", "gloss", "updated_at",
] as const;

let _schemaReady: Promise<void> | null = null;

async function hasColumn(table: string, column: string): Promise<{ exists: boolean; hasCol: boolean }> {
  const info = await db().execute(`PRAGMA table_info(${table})`);
  const names = (info.rows as unknown as { name: string }[]).map((r) => r.name);
  return { exists: names.length > 0, hasCol: names.includes(column) };
}

/**
 * One-time, idempotent upgrade of pre-existing single-tenant tables to the
 * multi-tenant schema. Detects a table that exists but lacks `source`, rebuilds
 * it with the composite primary key, and copies every old row in tagged as the
 * default station ('myc'). Runs inside a transaction (batch) so a failure rolls
 * back and leaves the original table intact. No-op once migrated, and skipped
 * entirely on a fresh database.
 */
async function migrateToMultiTenant(): Promise<void> {
  const client = db();

  const readings = await hasColumn("readings", "source");
  if (readings.exists && !readings.hasCol) {
    const cols = READING_BODY_COLS.join(", ");
    await client.batch(
      [
        "ALTER TABLE readings RENAME TO readings_legacy",
        readingsDdl("readings"),
        `INSERT INTO readings (source, ${cols}) SELECT '${DEFAULT_STATION}', ${cols} FROM readings_legacy`,
        "DROP TABLE readings_legacy",
      ],
      "write",
    );
  }

  const regimes = await hasColumn("regimes", "source");
  if (regimes.exists && !regimes.hasCol) {
    const cols = REGIME_COLS.join(", ");
    await client.batch(
      [
        "ALTER TABLE regimes RENAME TO regimes_legacy",
        REGIMES_DDL,
        `INSERT INTO regimes (source, ${cols}) SELECT '${DEFAULT_STATION}', ${cols} FROM regimes_legacy`,
        "DROP TABLE regimes_legacy",
      ],
      "write",
    );
  }
}

/** Create / upgrade tables on first use (idempotent). */
export function ensureSchema(): Promise<void> {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    await migrateToMultiTenant();
    // Fresh-create for new databases + (re)create supporting objects. All
    // statements are IF NOT EXISTS, so this is a no-op after a migration.
    const sql = `
      ${readingsDdl("readings")};
      CREATE INDEX IF NOT EXISTS idx_readings_observed_at ON readings (observed_at);
      CREATE TABLE IF NOT EXISTS alerts_state (
        key TEXT PRIMARY KEY,
        active INTEGER NOT NULL DEFAULT 0,
        last_sent INTEGER NOT NULL DEFAULT 0
      );
      ${REGIMES_DDL};
    `;
    await db().executeMultiple(sql);
  })();
  return _schemaReady;
}

// ---- readings -------------------------------------------------------------

/**
 * Insert a reading. (source, observed_at) is the primary key, so re-polling
 * between station updates (same observed_at) is a no-op. Returns true if a new
 * row was written.
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

/** Insert many readings in a single transaction. Returns rows newly written. */
export async function insertReadings(readings: Reading[]): Promise<number> {
  if (!readings.length) return 0;
  await ensureSchema();
  const placeholders = ALL_COLUMNS.map(() => "?").join(", ");
  const sql = `INSERT OR IGNORE INTO readings (${ALL_COLUMNS.join(
    ", ",
  )}) VALUES (${placeholders})`;
  const stmts = readings.map((r) => ({
    sql,
    args: ALL_COLUMNS.map((c) => r[c] ?? null) as (number | string | null)[],
  }));
  const results = await db().batch(stmts, "write");
  return results.reduce((sum, r) => sum + r.rowsAffected, 0);
}

/** Delete readings older than `days` days across all sources. Returns rows removed. */
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

/** Return a source's readings from the last `hours` hours, oldest first. */
export async function getHistory(
  hours: number,
  source: StationId = DEFAULT_STATION,
): Promise<HistoryRow[]> {
  await ensureSchema();
  const since = Date.now() - hours * 3600_000;
  // Skip the bulky raw_json blob for chart queries.
  const cols = ["observed_at", "fetched_at", "owner_name", ...NUMERIC_COLUMNS];
  const res = await db().execute({
    sql: `SELECT ${cols.join(
      ", ",
    )} FROM readings WHERE source = ? AND observed_at >= ? ORDER BY observed_at ASC`,
    args: [source, since],
  });
  return res.rows as unknown as HistoryRow[];
}

/** Return the single most recent reading for a source. */
export async function getLatest(
  source: StationId = DEFAULT_STATION,
): Promise<HistoryRow | null> {
  await ensureSchema();
  const cols = ["observed_at", "fetched_at", "owner_name", ...NUMERIC_COLUMNS];
  const res = await db().execute({
    sql: `SELECT ${cols.join(
      ", ",
    )} FROM readings WHERE source = ? ORDER BY observed_at DESC LIMIT 1`,
    args: [source],
  });
  return (res.rows[0] as unknown as HistoryRow) ?? null;
}

export async function getStats(source: StationId = DEFAULT_STATION): Promise<{
  count: number;
  first: number | null;
  last: number | null;
}> {
  await ensureSchema();
  const res = await db().execute({
    sql: "SELECT COUNT(*) AS count, MIN(observed_at) AS first, MAX(observed_at) AS last FROM readings WHERE source = ?",
    args: [source],
  });
  const r = res.rows[0] as unknown as {
    count: number;
    first: number | null;
    last: number | null;
  };
  return { count: r.count, first: r.first, last: r.last };
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
  source: string;
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

const REGIME_INSERT_COLS = ["source", ...REGIME_COLS] as const;

/** Insert or update one logged regime, keyed on (source, start_t). */
export async function upsertRegime(row: RegimeRow): Promise<void> {
  await ensureSchema();
  const placeholders = REGIME_INSERT_COLS.map(() => "?").join(", ");
  const updates = REGIME_INSERT_COLS.filter((c) => c !== "source" && c !== "start_t")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  await db().execute({
    sql: `INSERT INTO regimes (${REGIME_INSERT_COLS.join(", ")}) VALUES (${placeholders})
          ON CONFLICT(source, start_t) DO UPDATE SET ${updates}`,
    args: REGIME_INSERT_COLS.map(
      (c) => (row as unknown as Record<string, number | string | null>)[c] ?? null,
    ),
  });
}

/** Most recent logged regimes for a source (newest first), above a significance floor. */
export async function getRegimes(
  limit = 200,
  minSignificance = 0,
  source: StationId = DEFAULT_STATION,
): Promise<RegimeRow[]> {
  await ensureSchema();
  const res = await db().execute({
    sql: `SELECT source, ${REGIME_COLS.join(", ")} FROM regimes
          WHERE source = ? AND significance >= ? ORDER BY start_t DESC LIMIT ?`,
    args: [source, minSignificance, limit],
  });
  return res.rows as unknown as RegimeRow[];
}
