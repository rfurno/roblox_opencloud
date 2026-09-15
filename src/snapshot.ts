import {
  clockSlotsNear,
  inSendWindow,
  isNotifyHour,
  utcDateFromUnix,
} from "./clock.ts";
import {
  apiKeyConfigured,
  jobOf,
  universeNames,
  type AppConfig,
  type UniverseName,
} from "./config.ts";
import { recordSnapshotLog } from "./logs.ts";
import {
  isRetryable,
  isSuccess,
  snapshotDataStores,
  type SnapshotApiResult,
} from "./roblox.ts";
import type { Ledger, SnapshotRow, SnapshotSource } from "./store.ts";
import { getLedger } from "./store.ts";

export type SnapshotFn = (args: {
  universeId: string;
  apiKey: string;
}) => Promise<SnapshotApiResult>;

export type SnapshotTickOptions = {
  nowUnix?: number;
  universes?: UniverseName[];
  snapshot?: SnapshotFn;
  ledgers?: Partial<Record<UniverseName, Ledger>>;
  skipSendWindow?: boolean;
};

export type SnapshotAttempt = {
  job: UniverseName;
  universeId: string;
  utcDate: string;
  outcome: "taken" | "already" | "skipped" | "failed" | "retry";
  newSnapshotTaken: boolean | null;
  latestSnapshotTime: string | null;
  httpStatus: number | null;
  error?: string;
  row: SnapshotRow | null;
};

export type SnapshotBatchResult = {
  utcDate: string;
  sendWindowOpen: boolean;
  results: SnapshotAttempt[];
};

export function collectorSendWindowOpen(cfg: AppConfig, nowUnix: number): boolean {
  for (const name of universeNames()) {
    const job = jobOf(cfg.schedule, name);
    const slots = clockSlotsNear(nowUnix, {
      timeZone: cfg.schedule.scheduleTimeZone,
      hoursLocal: job.hoursLocal,
      jitterSeconds: cfg.schedule.jitterSeconds,
      pushLeadSeconds: cfg.schedule.pushLeadSeconds,
    });
    if (
      slots.some(
        (slot) =>
          isNotifyHour(slot.hourLocal, job.notifyHoursLocal) &&
          inSendWindow(nowUnix, slot, cfg.schedule.sendWindowSeconds),
      )
    ) {
      return true;
    }
  }
  return false;
}

export function publicSnapshot(row: SnapshotRow) {
  return {
    universeId: row.universe_id,
    utcDate: row.utc_date,
    takenUnix: row.taken_unix,
    newSnapshotTaken: row.new_snapshot_taken === 1,
    latestSnapshotTime: row.latest_snapshot_time,
    httpStatus: row.http_status,
    error: row.error,
    source: row.source,
  };
}

export function snapshotHistory(cfg: AppConfig, limit = 30) {
  const seen = new Set<string>();
  const rows: ReturnType<typeof publicSnapshot>[] = [];
  for (const name of universeNames()) {
    const ledger = getLedger(cfg, name);
    for (const row of ledger.recentSnapshots(limit)) {
      const key = `${row.universe_id}:${row.utc_date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(publicSnapshot(row));
    }
  }
  rows.sort((a, b) => b.utcDate.localeCompare(a.utcDate) || b.takenUnix - a.takenUnix);
  return rows.slice(0, limit);
}

export function snapshotStatus(cfg: AppConfig, nowUnix = Math.floor(Date.now() / 1000)) {
  const utcDate = utcDateFromUnix(nowUnix);
  const jobs: Record<string, unknown> = {};
  for (const name of universeNames()) {
    const job = jobOf(cfg.schedule, name);
    const ledger = getLedger(cfg, name);
    const today = ledger.getSnapshot(job.universeId, utcDate);
    jobs[name] = {
      universeId: job.universeId,
      keyConfigured: apiKeyConfigured(cfg.snapshotApiKey[name]),
      today: today ? publicSnapshot(today) : null,
    };
  }
  return {
    utcDate,
    sendWindowOpen: collectorSendWindowOpen(cfg, nowUnix),
    jobs,
    recent: snapshotHistory(cfg),
  };
}

async function snapshotUniverse(
  cfg: AppConfig,
  name: UniverseName,
  nowUnix: number,
  source: SnapshotSource,
  opts: SnapshotTickOptions,
): Promise<SnapshotAttempt> {
  const job = jobOf(cfg.schedule, name);
  const utcDate = utcDateFromUnix(nowUnix);
  const empty = (outcome: SnapshotAttempt["outcome"], error?: string): SnapshotAttempt => ({
    job: name,
    universeId: job.universeId,
    utcDate,
    outcome,
    newSnapshotTaken: null,
    latestSnapshotTime: null,
    httpStatus: null,
    error,
    row: null,
  });

  if (name === "sandbox" && job.universeId === "6674250544") {
    return empty("failed", "refusing Live universe");
  }

  if (!apiKeyConfigured(cfg.snapshotApiKey[name])) {
    return empty("skipped", "snapshot key missing");
  }

  const ledger = getLedger(cfg, name, opts.ledgers?.[name]);
  const existing = ledger.getSnapshot(job.universeId, utcDate);
  if (existing) {
    recordSnapshotLog({
      universeId: job.universeId,
      job: name,
      utcDate,
      tickUnix: nowUnix,
      newSnapshotTaken: existing.new_snapshot_taken === 1,
      latestSnapshotTime: existing.latest_snapshot_time,
      httpStatus: existing.http_status,
      source,
      note: "already recorded this UTC day",
    });
    return {
      job: name,
      universeId: job.universeId,
      utcDate,
      outcome: "already",
      newSnapshotTaken: existing.new_snapshot_taken === 1,
      latestSnapshotTime: existing.latest_snapshot_time,
      httpStatus: existing.http_status,
      error: "already recorded this UTC day",
      row: existing,
    };
  }

  const snapshot = opts.snapshot ?? snapshotDataStores;
  const result = await snapshot({
    universeId: job.universeId,
    apiKey: cfg.snapshotApiKey[name],
  });

  if (isSuccess(result.status)) {
    const recorded = ledger.recordSnapshot({
      universe_id: job.universeId,
      utc_date: utcDate,
      taken_unix: nowUnix,
      new_snapshot_taken: result.newSnapshotTaken === true ? 1 : 0,
      latest_snapshot_time: result.latestSnapshotTime,
      http_status: result.status,
      error: null,
      source,
    });
    const outcome: SnapshotAttempt["outcome"] = recorded.inserted
      ? result.newSnapshotTaken === false
        ? "already"
        : "taken"
      : "already";
    recordSnapshotLog({
      universeId: job.universeId,
      job: name,
      utcDate,
      tickUnix: nowUnix,
      newSnapshotTaken: result.newSnapshotTaken,
      latestSnapshotTime: result.latestSnapshotTime,
      httpStatus: result.status,
      source,
      note: recorded.inserted ? undefined : "ledger already had this UTC day",
    });
    return {
      job: name,
      universeId: job.universeId,
      utcDate,
      outcome,
      newSnapshotTaken: result.newSnapshotTaken,
      latestSnapshotTime: result.latestSnapshotTime,
      httpStatus: result.status,
      row: recorded.row,
    };
  }

  if (isRetryable(result.status)) {
    recordSnapshotLog({
      universeId: job.universeId,
      job: name,
      utcDate,
      tickUnix: nowUnix,
      newSnapshotTaken: null,
      latestSnapshotTime: null,
      httpStatus: result.status,
      source,
      note: "retryable; left unrecorded",
    });
    return {
      ...empty("retry", result.body.slice(0, 300) || "retryable"),
      httpStatus: result.status,
    };
  }

  recordSnapshotLog({
    universeId: job.universeId,
    job: name,
    utcDate,
    tickUnix: nowUnix,
    newSnapshotTaken: null,
    latestSnapshotTime: null,
    httpStatus: result.status,
    source,
    note: result.body.slice(0, 300),
  });
  return {
    ...empty("failed", result.body.slice(0, 300) || "non-retryable"),
    httpStatus: result.status,
  };
}

export async function tickSnapshots(
  cfg: AppConfig,
  opts: SnapshotTickOptions = {},
): Promise<SnapshotBatchResult> {
  const nowUnix = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const utcDate = utcDateFromUnix(nowUnix);
  const sendWindowOpen = collectorSendWindowOpen(cfg, nowUnix);
  if (opts.skipSendWindow !== false && sendWindowOpen) {
    return { utcDate, sendWindowOpen: true, results: [] };
  }

  const names = opts.universes ?? universeNames();
  const results: SnapshotAttempt[] = [];
  for (const name of names) {
    results.push(await snapshotUniverse(cfg, name, nowUnix, "scheduled", opts));
  }
  return { utcDate, sendWindowOpen, results };
}

export async function takeSnapshotNow(
  cfg: AppConfig,
  name: UniverseName,
  opts: SnapshotTickOptions = {},
): Promise<SnapshotAttempt> {
  const nowUnix = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  return snapshotUniverse(cfg, name, nowUnix, "manual", opts);
}
