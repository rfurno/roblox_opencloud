import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  clockSlotsNear,
  inSendWindow,
  isNotifyHour,
} from "./clock.ts";
import {
  apiKeyConfigured,
  jobOf,
  universeNames,
  type AppConfig,
  type UniverseName,
} from "./config.ts";
import { recordTick } from "./logs.ts";
import {
  COLLECTOR_NOTIFY_STORE,
  getDataStoreEntry,
  isRetryable,
  isSuccess,
  listDataStoreEntries,
  readUpdatedUnix,
  type DataStoreEntryRef,
  type GetEntryResult,
  type ListEntriesResult,
} from "./roblox.ts";
import { getLedger, type AudienceCache, type AudienceSource, type Ledger } from "./store.ts";

export type Allowlist = {
  userIds: number[];
};

export const AUDIENCE_RECENCY_SECONDS = 14 * 86400;
export const AUDIENCE_CACHE_TTL_SECONDS = 15 * 60;
export const AUDIENCE_REFRESH_CUTOFF_SECONDS = 90;

export function loadAllowlist(path: string): number[] {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) return [];
  const parsed = JSON.parse(readFileSync(full, "utf8")) as Allowlist;
  const ids = Array.isArray(parsed.userIds) ? parsed.userIds : [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of ids) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

export function parseUserIdKey(key: string): number | null {
  const s = key.trim();
  const m = s.match(/^(?:global\/)?(\d+)$/) || s.match(/\/entries\/(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export type AlumniEntry = {
  key: string;
  updatedUnix: number | null;
};

export function alumniFromEntries(
  entries: AlumniEntry[],
  nowUnix: number,
  recencySeconds = AUDIENCE_RECENCY_SECONDS,
): { userIds: number[]; storeListedN: number; recencyDroppedN: number } {
  const cutoff = nowUnix - recencySeconds;
  const userIds: number[] = [];
  const seen = new Set<number>();
  let recencyDroppedN = 0;
  let storeListedN = 0;
  for (const entry of entries) {
    const userId = parseUserIdKey(entry.key);
    if (userId === null) continue;
    storeListedN += 1;
    if (entry.updatedUnix === null || entry.updatedUnix < cutoff) {
      recencyDroppedN += 1;
      continue;
    }
    if (seen.has(userId)) continue;
    seen.add(userId);
    userIds.push(userId);
  }
  return { userIds, storeListedN, recencyDroppedN };
}

export function shouldRefreshAudience(args: {
  nowUnix: number;
  inSendWindow: boolean;
  nextPushAt: number | null;
  hasDatastoreKey: boolean;
  cacheRefreshedUnix: number | null;
}): boolean {
  if (args.inSendWindow) return false;
  if (!args.hasDatastoreKey) return false;
  if (
    args.nextPushAt !== null &&
    args.nextPushAt - args.nowUnix < AUDIENCE_REFRESH_CUTOFF_SECONDS &&
    args.nextPushAt - args.nowUnix >= 0
  ) {
    return false;
  }
  if (args.cacheRefreshedUnix === null) return true;
  return args.nowUnix - args.cacheRefreshedUnix >= AUDIENCE_CACHE_TTL_SECONDS;
}

export function nextNotifyPushAt(cfg: AppConfig, name: UniverseName, nowUnix: number): number | null {
  const job = jobOf(cfg.schedule, name);
  const slots = clockSlotsNear(nowUnix, {
    timeZone: cfg.schedule.scheduleTimeZone,
    hoursLocal: job.hoursLocal,
    jitterSeconds: cfg.schedule.jitterSeconds,
    pushLeadSeconds: cfg.schedule.pushLeadSeconds,
  });
  let best: number | null = null;
  for (const slot of slots) {
    if (slot.key.startsWith("studio:")) continue;
    if (!isNotifyHour(slot.hourLocal, job.notifyHoursLocal)) continue;
    if (slot.pushAt <= nowUnix) continue;
    if (best === null || slot.pushAt < best) best = slot.pushAt;
  }
  return best;
}

export function universeInSendWindow(cfg: AppConfig, name: UniverseName, nowUnix: number): boolean {
  const job = jobOf(cfg.schedule, name);
  const slots = clockSlotsNear(nowUnix, {
    timeZone: cfg.schedule.scheduleTimeZone,
    hoursLocal: job.hoursLocal,
    jitterSeconds: cfg.schedule.jitterSeconds,
    pushLeadSeconds: cfg.schedule.pushLeadSeconds,
  });
  return slots.some(
    (slot) =>
      !slot.key.startsWith("studio:") &&
      isNotifyHour(slot.hourLocal, job.notifyHoursLocal) &&
      inSendWindow(nowUnix, slot, cfg.schedule.sendWindowSeconds),
  );
}

export function audienceForSend(
  cfg: AppConfig,
  name: UniverseName,
  ledger: Ledger,
): AudienceCache {
  const job = jobOf(cfg.schedule, name);
  const allowlist = loadAllowlist(job.allowlistPath);
  const cache = ledger.getAudienceCache(job.universeId);
  if (cache?.source === "datastore") return cache;
  return {
    universeId: job.universeId,
    refreshedUnix: cache?.refreshedUnix ?? 0,
    source: "allowlist",
    storeListedN: cache?.storeListedN ?? 0,
    recencyDroppedN: cache?.recencyDroppedN ?? 0,
    userIds: allowlist,
  };
}

export type ListPageFn = (args: {
  universeId: string;
  apiKey: string;
  storeId?: string;
  pageToken?: string;
}) => Promise<ListEntriesResult>;

export type GetEntryFn = (args: { apiKey: string; path: string }) => Promise<GetEntryResult>;

export type AudienceTickOptions = {
  nowUnix?: number;
  universes?: UniverseName[];
  ledgers?: Partial<Record<UniverseName, Ledger>>;
  listEntries?: ListPageFn;
  getEntry?: GetEntryFn;
};

export type AudienceRefreshResult = {
  job: UniverseName;
  universeId: string;
  outcome: "refreshed" | "skipped" | "failed";
  source: AudienceSource;
  audienceN: number;
  storeListedN: number;
  recencyDroppedN: number;
  note?: string;
};

async function listAllEntries(
  universeId: string,
  apiKey: string,
  listEntries: ListPageFn,
): Promise<{ status: number; entries: DataStoreEntryRef[]; body: string }> {
  const entries: DataStoreEntryRef[] = [];
  let pageToken: string | undefined;
  let lastStatus = 0;
  let lastBody = "";
  for (let i = 0; i < 64; i++) {
    const page = await listEntries({
      universeId,
      apiKey,
      storeId: COLLECTOR_NOTIFY_STORE,
      pageToken,
    });
    lastStatus = page.status;
    lastBody = page.body;
    if (!isSuccess(page.status)) {
      return { status: page.status, entries, body: page.body };
    }
    entries.push(...page.entries);
    if (!page.nextPageToken) break;
    pageToken = page.nextPageToken;
  }
  return { status: lastStatus || 200, entries, body: lastBody };
}

export async function refreshUniverseAudience(
  cfg: AppConfig,
  name: UniverseName,
  nowUnix: number,
  opts: AudienceTickOptions = {},
): Promise<AudienceRefreshResult> {
  const job = jobOf(cfg.schedule, name);
  const allowlist = loadAllowlist(job.allowlistPath);
  const ledger = getLedger(cfg, name, opts.ledgers?.[name]);
  const cache = ledger.getAudienceCache(job.universeId);
  const inWindow = universeInSendWindow(cfg, name, nowUnix);
  const nextPush = nextNotifyPushAt(cfg, name, nowUnix);
  const hasKey = apiKeyConfigured(cfg.datastoreApiKey[name]);

  const skip = (note: string, source: AudienceSource = cache?.source ?? "allowlist"): AudienceRefreshResult => ({
    job: name,
    universeId: job.universeId,
    outcome: "skipped",
    source,
    audienceN: source === "datastore" ? (cache?.userIds.length ?? 0) : allowlist.length,
    storeListedN: cache?.storeListedN ?? 0,
    recencyDroppedN: cache?.recencyDroppedN ?? 0,
    note,
  });

  if (!shouldRefreshAudience({
    nowUnix,
    inSendWindow: inWindow,
    nextPushAt: nextPush,
    hasDatastoreKey: hasKey,
    cacheRefreshedUnix: cache?.refreshedUnix ?? null,
  })) {
    const until = nextPush === null ? null : nextPush - nowUnix;
    const reason = !hasKey
      ? "no datastore key"
      : inWindow
        ? "send window open"
        : until !== null && until >= 0 && until < AUDIENCE_REFRESH_CUTOFF_SECONDS
          ? "too close to pushAt"
          : "cache fresh";
    return skip(reason);
  }

  if (name === "sandbox" && job.universeId === "6674250544") {
    return skip("refusing Live universe on sandbox job");
  }
  if (name === "live" && job.universeId !== "6674250544") {
    return skip("live job universe mismatch");
  }

  const listEntries = opts.listEntries ?? listDataStoreEntries;
  const getEntry = opts.getEntry ?? getDataStoreEntry;
  const listed = await listAllEntries(job.universeId, cfg.datastoreApiKey[name], listEntries);

  const writeAllowlistFallback = (note: string): AudienceRefreshResult => {
    const row: AudienceCache = {
      universeId: job.universeId,
      refreshedUnix: nowUnix,
      source: "allowlist",
      storeListedN: 0,
      recencyDroppedN: 0,
      userIds: allowlist,
    };
    ledger.putAudienceCache(row);
    return {
      job: name,
      universeId: job.universeId,
      outcome: listed.status === 404 ? "refreshed" : "failed",
      source: "allowlist",
      audienceN: allowlist.length,
      storeListedN: 0,
      recencyDroppedN: 0,
      note,
    };
  };

  if (listed.status === 404) {
    return writeAllowlistFallback("store missing; allowlist fallback");
  }
  if (isRetryable(listed.status)) {
    return {
      job: name,
      universeId: job.universeId,
      outcome: "failed",
      source: cache?.source ?? "allowlist",
      audienceN: cache?.source === "datastore" ? cache.userIds.length : allowlist.length,
      storeListedN: cache?.storeListedN ?? 0,
      recencyDroppedN: cache?.recencyDroppedN ?? 0,
      note: `list HTTP ${listed.status}; kept previous cache`,
    };
  }
  if (!isSuccess(listed.status)) {
    return writeAllowlistFallback(`list HTTP ${listed.status}; allowlist fallback`);
  }

  const values: AlumniEntry[] = [];
  for (const ref of listed.entries) {
    const got = await getEntry({ apiKey: cfg.datastoreApiKey[name], path: ref.path });
    if (isRetryable(got.status)) {
      return {
        job: name,
        universeId: job.universeId,
        outcome: "failed",
        source: cache?.source ?? "allowlist",
        audienceN: cache?.source === "datastore" ? cache.userIds.length : allowlist.length,
        storeListedN: cache?.storeListedN ?? 0,
        recencyDroppedN: cache?.recencyDroppedN ?? 0,
        note: `get HTTP ${got.status}; kept previous cache`,
      };
    }
    if (!isSuccess(got.status)) {
      values.push({ key: ref.id, updatedUnix: null });
      continue;
    }
    values.push({ key: ref.id, updatedUnix: readUpdatedUnix(got.value) });
  }

  const filtered = alumniFromEntries(values, nowUnix);
  const row: AudienceCache = {
    universeId: job.universeId,
    refreshedUnix: nowUnix,
    source: "datastore",
    storeListedN: filtered.storeListedN,
    recencyDroppedN: filtered.recencyDroppedN,
    userIds: filtered.userIds,
  };
  ledger.putAudienceCache(row);
  return {
    job: name,
    universeId: job.universeId,
    outcome: "refreshed",
    source: "datastore",
    audienceN: filtered.userIds.length,
    storeListedN: filtered.storeListedN,
    recencyDroppedN: filtered.recencyDroppedN,
  };
}

export async function tickAudience(
  cfg: AppConfig,
  opts: AudienceTickOptions = {},
): Promise<AudienceRefreshResult[]> {
  const nowUnix = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const names = opts.universes ?? universeNames();
  const results: AudienceRefreshResult[] = [];
  for (const name of names) {
    const result = await refreshUniverseAudience(cfg, name, nowUnix, opts);
    results.push(result);
    if (result.outcome !== "skipped" || result.note?.includes("fallback")) {
      recordTick({
        universeId: result.universeId,
        job: name,
        tickUnix: nowUnix,
        slotKey: null,
        slotUnix: null,
        pushAt: null,
        audienceN: result.audienceN,
        sentN: 0,
        failN: 0,
        skipN: 0,
        dryRun: cfg.dryRun,
        storeListedN: result.storeListedN,
        recencyDroppedN: result.recencyDroppedN,
        source: result.source,
        note: `audience ${result.outcome}${result.note ? `: ${result.note}` : ""}`,
      });
    }
  }
  return results;
}
