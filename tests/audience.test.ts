import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  alumniFromEntries,
  audienceForSend,
  parseUserIdKey,
  shouldRefreshAudience,
  tickAudience,
} from "../src/audience.ts";
import type { AppConfig } from "../src/config.ts";
import {
  listDataStoreEntriesUrl,
  parseListedEntries,
  readUpdatedUnix,
} from "../src/roblox.ts";
import { Ledger } from "../src/store.ts";
import { tick } from "../src/worker.ts";

const PUSH_AT = 1_789_055_833;
const BEFORE_LEAD = PUSH_AT - 15 * 60;

function writeAllowlist(dir: string, ids: number[]): string {
  const path = join(dir, "allowlist.json");
  writeFileSync(path, JSON.stringify({ userIds: ids }));
  writeFileSync(join(dir, "empty.json"), JSON.stringify({ userIds: [] }));
  return path;
}

function cfgFor(dir: string, allowlistPath: string): AppConfig {
  return {
    schedule: {
      scheduleTimeZone: "Etc/UTC",
      jitterSeconds: 600,
      pushLeadSeconds: 600,
      sendWindowSeconds: 60,
      tickIntervalSeconds: 30,
      sandbox: {
        universeId: "7034342160",
        placeId: "117194948580255",
        hoursLocal: [16, 4, 10, 22],
        notifyHoursLocal: [16, 4, 10, 22],
        allowlistPath,
      },
      live: {
        universeId: "6674250544",
        placeId: "98219898516303",
        hoursLocal: [16, 4],
        notifyHoursLocal: [16],
        allowlistPath: join(dir, "empty.json"),
      },
    },
    dryRun: false,
    liveSendsEnabled: true,
    dataDir: dir,
    port: 0,
    openBrowser: false,
    logUserResults: false,
    apiKey: { sandbox: "sandbox-key", live: "live-key" },
    snapshotApiKey: { sandbox: "", live: "" },
    datastoreApiKey: { sandbox: "sandbox-ds-key", live: "live-ds-key" },
    messageId: { sandbox: "sandbox-msg", live: "live-msg" },
  };
}

describe("alumni filter", () => {
  it("parses userId keys only", () => {
    expect(parseUserIdKey("3757284903")).toBe(3757284903);
    expect(parseUserIdKey("global/3757284903")).toBe(3757284903);
    expect(
      parseUserIdKey("universes/7034342160/data-stores/CollectorNotify/scopes/global/entries/3757284903"),
    ).toBe(3757284903);
    expect(parseUserIdKey("lot-1")).toBeNull();
    expect(parseUserIdKey("0")).toBeNull();
  });

  it("keeps updatedUnix on the 14-day boundary and drops older / missing", () => {
    const now = 1_800_000_000;
    const keep = now - 14 * 86400;
    const drop = keep - 1;
    const out = alumniFromEntries(
      [
        { key: "11", updatedUnix: keep },
        { key: "22", updatedUnix: drop },
        { key: "33", updatedUnix: null },
        { key: "lot-1", updatedUnix: now },
        { key: "11", updatedUnix: now },
      ],
      now,
    );
    expect(out.userIds).toEqual([11]);
    expect(out.storeListedN).toBe(4);
    expect(out.recencyDroppedN).toBe(2);
  });
});

describe("readUpdatedUnix", () => {
  it("reads a JSON object or stringified table", () => {
    expect(readUpdatedUnix({ updatedUnix: 10, lotId: "1" })).toBe(10);
    expect(readUpdatedUnix('{"updatedUnix":11}')).toBe(11);
    expect(readUpdatedUnix({})).toBeNull();
  });
});

describe("list URL isolation", () => {
  it("sandbox list URL never contains the Live universe", () => {
    const url = listDataStoreEntriesUrl("7034342160");
    expect(url).toContain("/universes/7034342160/data-stores/CollectorNotify/entries");
    expect(url).not.toContain("6674250544");
  });

  it("parses listed ids", () => {
    expect(
      parseListedEntries(
        JSON.stringify({
          dataStoreEntries: [{ id: "1", path: "universes/1/data-stores/CollectorNotify/entries/1" }],
          nextPageToken: "n",
        }),
      ),
    ).toEqual({
      entries: [{ id: "1", path: "universes/1/data-stores/CollectorNotify/entries/1" }],
      nextPageToken: "n",
    });
  });
});

describe("shouldRefreshAudience", () => {
  const base = {
    nowUnix: BEFORE_LEAD,
    inSendWindow: false,
    nextPushAt: PUSH_AT,
    hasDatastoreKey: true,
    cacheRefreshedUnix: null as number | null,
  };

  it("refreshes when cache is missing or stale, not during the window", () => {
    expect(shouldRefreshAudience(base)).toBe(true);
    expect(shouldRefreshAudience({ ...base, nowUnix: PUSH_AT - 30 * 60 })).toBe(true);
    expect(shouldRefreshAudience({ ...base, inSendWindow: true })).toBe(false);
    expect(shouldRefreshAudience({ ...base, nowUnix: PUSH_AT - 30 })).toBe(false);
    expect(shouldRefreshAudience({ ...base, hasDatastoreKey: false })).toBe(false);
    expect(shouldRefreshAudience({ ...base, cacheRefreshedUnix: BEFORE_LEAD - 10 })).toBe(false);
    expect(shouldRefreshAudience({ ...base, cacheRefreshedUnix: BEFORE_LEAD - 15 * 60 })).toBe(true);
  });
});

describe("tickAudience + send", () => {
  it("404 store falls back to allowlist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-aud-"));
    const allowlistPath = writeAllowlist(dir, [111]);
    const cfg = cfgFor(dir, allowlistPath);
    const ledger = new Ledger(":memory:");
    const universes: string[] = [];
    const result = await tickAudience(cfg, {
      nowUnix: BEFORE_LEAD,
      universes: ["sandbox"],
      ledgers: { sandbox: ledger },
      listEntries: async (req) => {
        universes.push(req.universeId);
        return { status: 404, body: "missing", entries: [], nextPageToken: null };
      },
      getEntry: async () => {
        throw new Error("get should not run on 404");
      },
    });
    expect(universes).toEqual(["7034342160"]);
    expect(result[0]?.source).toBe("allowlist");
    expect(result[0]?.note).toMatch(/store missing/);
    expect(audienceForSend(cfg, "sandbox", ledger).userIds).toEqual([111]);
  });

  it("does not list during the send window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-aud-"));
    const allowlistPath = writeAllowlist(dir, [111]);
    const cfg = cfgFor(dir, allowlistPath);
    let lists = 0;
    await tickAudience(cfg, {
      nowUnix: PUSH_AT,
      universes: ["sandbox"],
      ledgers: { sandbox: new Ledger(":memory:") },
      listEntries: async () => {
        lists += 1;
        return { status: 200, body: "{}", entries: [], nextPageToken: null };
      },
    });
    expect(lists).toBe(0);
  });

  it("empty datastore audience sends no HTTP (does not fall back)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-aud-"));
    const allowlistPath = writeAllowlist(dir, [111]);
    const cfg = cfgFor(dir, allowlistPath);
    const ledger = new Ledger(":memory:");
    ledger.putAudienceCache({
      universeId: "7034342160",
      refreshedUnix: BEFORE_LEAD,
      source: "datastore",
      storeListedN: 2,
      recencyDroppedN: 2,
      userIds: [],
    });
    const calls: number[] = [];
    await tick(cfg, {
      nowUnix: PUSH_AT,
      dryRun: false,
      universes: ["sandbox"],
      ledgers: { sandbox: ledger },
      send: async (req) => {
        calls.push(req.userId);
        return { status: 200, body: "{}" };
      },
    });
    expect(calls).toEqual([]);
  });

  it("send uses cached datastore ids, not the allowlist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-aud-"));
    const allowlistPath = writeAllowlist(dir, [111]);
    const cfg = cfgFor(dir, allowlistPath);
    const ledger = new Ledger(":memory:");
    ledger.putAudienceCache({
      universeId: "7034342160",
      refreshedUnix: BEFORE_LEAD,
      source: "datastore",
      storeListedN: 1,
      recencyDroppedN: 0,
      userIds: [999],
    });
    const calls: number[] = [];
    await tick(cfg, {
      nowUnix: PUSH_AT,
      dryRun: false,
      universes: ["sandbox"],
      ledgers: { sandbox: ledger },
      send: async (req) => {
        calls.push(req.userId);
        expect(req.universeId).toBe("7034342160");
        return { status: 200, body: "{}" };
      },
    });
    expect(calls).toEqual([999]);
  });

  it("lists then filters recency and caches userIds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-aud-"));
    const allowlistPath = writeAllowlist(dir, [111]);
    const cfg = cfgFor(dir, allowlistPath);
    const ledger = new Ledger(":memory:");
    const now = BEFORE_LEAD;
    const keep = now - 3 * 86400;
    const drop = now - 15 * 86400;
    const result = await tickAudience(cfg, {
      nowUnix: now,
      universes: ["sandbox"],
      ledgers: { sandbox: ledger },
      listEntries: async () => ({
        status: 200,
        body: "{}",
        entries: [
          { id: "21", path: "universes/7034342160/data-stores/CollectorNotify/entries/21" },
          { id: "22", path: "universes/7034342160/data-stores/CollectorNotify/entries/22" },
        ],
        nextPageToken: null,
      }),
      getEntry: async (req) => {
        const id = req.path.split("/").pop();
        return {
          status: 200,
          body: "{}",
          value: { updatedUnix: id === "21" ? keep : drop, lotId: "1" },
        };
      },
    });
    expect(result[0]?.source).toBe("datastore");
    expect(result[0]?.audienceN).toBe(1);
    expect(result[0]?.storeListedN).toBe(2);
    expect(result[0]?.recencyDroppedN).toBe(1);
    expect(audienceForSend(cfg, "sandbox", ledger).userIds).toEqual([21]);
  });
});
