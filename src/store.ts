import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SendStatus = "pending" | "sent" | "failed";

export type SendRow = {
  universe_id: string;
  slot_key: string;
  user_id: number;
  slot_unix: number;
  push_at: number;
  status: SendStatus;
  http_status: number | null;
  sent_unix: number | null;
  error: string | null;
  created_unix: number;
};

export type AudienceSource = "datastore" | "allowlist";

export type AudienceCache = {
  universeId: string;
  refreshedUnix: number;
  source: AudienceSource;
  storeListedN: number;
  recencyDroppedN: number;
  userIds: number[];
};

export type SnapshotSource = "scheduled" | "manual";

export type SnapshotRow = {
  universe_id: string;
  utc_date: string;
  taken_unix: number;
  new_snapshot_taken: number;
  latest_snapshot_time: string | null;
  http_status: number | null;
  error: string | null;
  source: SnapshotSource | string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sends (
  universe_id  TEXT NOT NULL,
  slot_key     TEXT NOT NULL,
  user_id      INTEGER NOT NULL,
  slot_unix    INTEGER NOT NULL,
  push_at      INTEGER NOT NULL,
  status       TEXT NOT NULL,
  http_status  INTEGER,
  sent_unix    INTEGER,
  error        TEXT,
  created_unix INTEGER NOT NULL,
  PRIMARY KEY (universe_id, slot_key, user_id)
);

CREATE TABLE IF NOT EXISTS moment_days (
  universe_id  TEXT NOT NULL,
  user_id      INTEGER NOT NULL,
  utc_date     TEXT NOT NULL,
  slot_key     TEXT NOT NULL,
  PRIMARY KEY (universe_id, user_id, utc_date)
);

CREATE TABLE IF NOT EXISTS audience_cache (
  universe_id        TEXT NOT NULL PRIMARY KEY,
  refreshed_unix     INTEGER NOT NULL,
  source             TEXT NOT NULL,
  store_listed_n     INTEGER NOT NULL,
  recency_dropped_n  INTEGER NOT NULL,
  user_ids           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshots (
  universe_id           TEXT NOT NULL,
  utc_date              TEXT NOT NULL,
  taken_unix            INTEGER NOT NULL,
  new_snapshot_taken    INTEGER NOT NULL,
  latest_snapshot_time  TEXT,
  http_status           INTEGER,
  error                 TEXT,
  source                TEXT NOT NULL,
  PRIMARY KEY (universe_id, utc_date)
);
`;

export class Ledger {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.path = path === ":memory:" ? ":memory:" : resolve(path);
    if (this.path !== ":memory:") {
      mkdirSync(dirname(this.path), { recursive: true });
    }
    this.db = new DatabaseSync(this.path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  hasMomentToday(universeId: string, userId: number, utcDate: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 AS ok FROM moment_days WHERE universe_id = ? AND user_id = ? AND utc_date = ?",
      )
      .get(universeId, userId, utcDate) as { ok: number } | undefined;
    return Boolean(row);
  }

  /** INSERT OR IGNORE pending, then SELECT. Unique conflict is not "already sent". */
  reserve(row: Omit<SendRow, "status" | "http_status" | "sent_unix" | "error">): SendRow {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sends
          (universe_id, slot_key, user_id, slot_unix, push_at, status, created_unix)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(row.universe_id, row.slot_key, row.user_id, row.slot_unix, row.push_at, row.created_unix);

    const existing = this.get(row.universe_id, row.slot_key, row.user_id);
    if (!existing) {
      throw new Error("reserve: row missing after INSERT OR IGNORE");
    }
    return existing;
  }

  get(universeId: string, slotKey: string, userId: number): SendRow | null {
    const row = this.db
      .prepare(
        `SELECT universe_id, slot_key, user_id, slot_unix, push_at, status,
                http_status, sent_unix, error, created_unix
           FROM sends
          WHERE universe_id = ? AND slot_key = ? AND user_id = ?`,
      )
      .get(universeId, slotKey, userId) as SendRow | undefined;
    return row ?? null;
  }

  markSent(args: {
    universeId: string;
    slotKey: string;
    userId: number;
    httpStatus: number;
    sentUnix: number;
    utcDate: string;
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE sends
            SET status = 'sent', http_status = ?, sent_unix = ?, error = NULL
          WHERE universe_id = ? AND slot_key = ? AND user_id = ? AND status = 'pending'`,
      )
      .run(args.httpStatus, args.sentUnix, args.universeId, args.slotKey, args.userId);
    if (result.changes !== 1) return false;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO moment_days (universe_id, user_id, utc_date, slot_key)
         VALUES (?, ?, ?, ?)`,
      )
      .run(args.universeId, args.userId, args.utcDate, args.slotKey);
    return true;
  }

  markFailed(args: {
    universeId: string;
    slotKey: string;
    userId: number;
    httpStatus: number;
    error: string;
  }): boolean {
    const result = this.db
      .prepare(
        `UPDATE sends
            SET status = 'failed', http_status = ?, error = ?
          WHERE universe_id = ? AND slot_key = ? AND user_id = ? AND status = 'pending'`,
      )
      .run(args.httpStatus, args.error, args.universeId, args.slotKey, args.userId);
    return result.changes === 1;
  }

  hasSnapshotToday(universeId: string, utcDate: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM snapshots WHERE universe_id = ? AND utc_date = ?")
      .get(universeId, utcDate) as { ok: number } | undefined;
    return Boolean(row);
  }

  getSnapshot(universeId: string, utcDate: string): SnapshotRow | null {
    const row = this.db
      .prepare(
        `SELECT universe_id, utc_date, taken_unix, new_snapshot_taken, latest_snapshot_time,
                http_status, error, source
           FROM snapshots
          WHERE universe_id = ? AND utc_date = ?`,
      )
      .get(universeId, utcDate) as SnapshotRow | undefined;
    return row ?? null;
  }

  /** INSERT OR IGNORE. Unique conflict means this UTC day is already recorded. */
  recordSnapshot(row: SnapshotRow): { inserted: boolean; row: SnapshotRow } {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO snapshots
          (universe_id, utc_date, taken_unix, new_snapshot_taken, latest_snapshot_time,
           http_status, error, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.universe_id,
        row.utc_date,
        row.taken_unix,
        row.new_snapshot_taken,
        row.latest_snapshot_time,
        row.http_status,
        row.error,
        row.source,
      );
    const existing = this.getSnapshot(row.universe_id, row.utc_date);
    if (!existing) {
      throw new Error("recordSnapshot: row missing after INSERT OR IGNORE");
    }
    return { inserted: result.changes === 1, row: existing };
  }

  recentSnapshots(limit = 30): SnapshotRow[] {
    return this.db
      .prepare(
        `SELECT universe_id, utc_date, taken_unix, new_snapshot_taken, latest_snapshot_time,
                http_status, error, source
           FROM snapshots
          ORDER BY utc_date DESC, taken_unix DESC
          LIMIT ?`,
      )
      .all(limit) as SnapshotRow[];
  }

  getAudienceCache(universeId: string): AudienceCache | null {
    const row = this.db
      .prepare(
        `SELECT universe_id, refreshed_unix, source, store_listed_n, recency_dropped_n, user_ids
           FROM audience_cache
          WHERE universe_id = ?`,
      )
      .get(universeId) as
      | {
          universe_id: string;
          refreshed_unix: number;
          source: string;
          store_listed_n: number;
          recency_dropped_n: number;
          user_ids: string;
        }
      | undefined;
    if (!row) return null;
    let userIds: number[] = [];
    try {
      const parsed = JSON.parse(row.user_ids) as unknown;
      if (Array.isArray(parsed)) {
        userIds = parsed.filter((n) => Number.isInteger(n) && n > 0) as number[];
      }
    } catch {
      userIds = [];
    }
    return {
      universeId: row.universe_id,
      refreshedUnix: row.refreshed_unix,
      source: row.source === "datastore" ? "datastore" : "allowlist",
      storeListedN: row.store_listed_n,
      recencyDroppedN: row.recency_dropped_n,
      userIds,
    };
  }

  putAudienceCache(row: AudienceCache): void {
    this.db
      .prepare(
        `INSERT INTO audience_cache
          (universe_id, refreshed_unix, source, store_listed_n, recency_dropped_n, user_ids)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(universe_id) DO UPDATE SET
           refreshed_unix = excluded.refreshed_unix,
           source = excluded.source,
           store_listed_n = excluded.store_listed_n,
           recency_dropped_n = excluded.recency_dropped_n,
           user_ids = excluded.user_ids`,
      )
      .run(
        row.universeId,
        row.refreshedUnix,
        row.source,
        row.storeListedN,
        row.recencyDroppedN,
        JSON.stringify(row.userIds),
      );
  }

  recentSends(limit = 20): SendRow[] {
    return this.db
      .prepare(
        `SELECT universe_id, slot_key, user_id, slot_unix, push_at, status,
                http_status, sent_unix, error, created_unix
           FROM sends
          ORDER BY created_unix DESC
          LIMIT ?`,
      )
      .all(limit) as SendRow[];
  }
}

export function ledgerPath(dataDir: string, universe: string): string {
  return resolve(dataDir, `${universe}.sqlite`);
}

const defaultLedgers = new Map<string, Ledger>();

export function getLedger(
  cfg: { dataDir: string },
  name: string,
  injected?: Ledger,
): Ledger {
  if (injected) return injected;
  const path = ledgerPath(cfg.dataDir, name);
  let existing = defaultLedgers.get(path);
  if (!existing) {
    existing = new Ledger(path);
    defaultLedgers.set(path, existing);
  }
  return existing;
}
