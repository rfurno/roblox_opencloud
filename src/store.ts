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
