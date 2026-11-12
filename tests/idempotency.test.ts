import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clockSlotsNear } from "../src/clock.ts";
import type { AppConfig } from "../src/config.ts";
import { Ledger } from "../src/store.ts";
import { sendSandboxNow, tick } from "../src/worker.ts";

const PUSH_AT = 1_789_055_833;
const SLOT_UNIX = 1_789_056_433;

function writeAllowlist(dir: string, ids: number[]): string {
  const path = join(dir, "allowlist.json");
  writeFileSync(path, JSON.stringify({ userIds: ids }));
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
    liveSendsEnabled: false,
    dataDir: dir,
    port: 0,
    openBrowser: false,
    logUserResults: false,
    apiKey: { sandbox: "sandbox-key", live: "live-key" },
    snapshotApiKey: { sandbox: "", live: "" },
    datastoreApiKey: { sandbox: "", live: "" },
    messageId: { sandbox: "sandbox-msg", live: "live-msg" },
  };
}

describe("ledger", () => {
  it("unique conflict is not already sent; 2xx then 4xx cannot overwrite sent", () => {
    const ledger = new Ledger(":memory:");
    const row = {
      universe_id: "7034342160",
      slot_key: "2026-09-10T16",
      user_id: 1,
      slot_unix: SLOT_UNIX,
      push_at: PUSH_AT,
      created_unix: PUSH_AT,
    };
    const a = ledger.reserve(row);
    const b = ledger.reserve(row);
    expect(a.status).toBe("pending");
    expect(b.status).toBe("pending");
    expect(
      ledger.markSent({
        universeId: row.universe_id,
        slotKey: row.slot_key,
        userId: row.user_id,
        httpStatus: 200,
        sentUnix: PUSH_AT,
        utcDate: "2026-09-10",
      }),
    ).toBe(true);
    expect(
      ledger.markFailed({
        universeId: row.universe_id,
        slotKey: row.slot_key,
        userId: row.user_id,
        httpStatus: 400,
        error: "late 4xx",
      }),
    ).toBe(false);
    expect(ledger.get(row.universe_id, row.slot_key, row.user_id)?.status).toBe("sent");
    expect(ledger.hasMomentBetween(row.universe_id, row.user_id, "2026-09-07", "2026-09-13")).toBe(
      true,
    );
    expect(ledger.hasMomentBetween(row.universe_id, row.user_id, "2026-09-14", "2026-09-20")).toBe(
      false,
    );
    ledger.close();
  });
});

function pushAtFor(key: string, nearUnix: number): number {
  const slot = clockSlotsNear(nearUnix, {
    timeZone: "Etc/UTC",
    hoursLocal: [4, 10, 16, 22],
    jitterSeconds: 600,
    pushLeadSeconds: 600,
  }).find((candidate) => candidate.key === key);
  if (!slot) throw new Error(`missing slot ${key}`);
  return slot.pushAt;
}

describe("worker tick", () => {
  it("dry-run writes nothing, then a live tick still POSTs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-"));
    writeFileSync(join(dir, "empty.json"), JSON.stringify({ userIds: [] }));
    const allowlistPath = writeAllowlist(dir, [111]);
    const cfg = cfgFor(dir, allowlistPath);
    const ledger = new Ledger(":memory:");
    const calls: number[] = [];

    await tick(cfg, {
      nowUnix: PUSH_AT,
      dryRun: true,
      universes: ["sandbox"],
      ledgers: { sandbox: ledger },
      send: async () => {
        calls.push(1);
        return { status: 200, body: "{}" };
      },
    });
    expect(calls).toEqual([]);
    expect(ledger.get("7034342160", "2026-09-10T16", 111)).toBeNull();

    await tick(cfg, {
      nowUnix: PUSH_AT,
      dryRun: false,
      universes: ["sandbox"],
      ledgers: { sandbox: ledger },
      send: async () => {
        calls.push(1);
        return { status: 200, body: "{}" };
      },
    });
    expect(calls).toEqual([1]);
    expect(ledger.get("7034342160", "2026-09-10T16", 111)?.status).toBe("sent");
    ledger.close();
  });

  it("two overlapping ticks produce one HTTP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-"));
    writeFileSync(join(dir, "empty.json"), JSON.stringify({ userIds: [] }));
    const allowlistPath = writeAllowlist(dir, [222]);
    const cfg = cfgFor(dir, allowlistPath);
    const ledger = new Ledger(":memory:");
    let inFlight = 0;
    let maxFlight = 0;
    const calls: number[] = [];

    const send = async () => {
      inFlight += 1;
      maxFlight = Math.max(maxFlight, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight -= 1;
      calls.push(1);
      return { status: 200, body: "{}" };
    };

    await Promise.all([
      tick(cfg, {
        nowUnix: PUSH_AT,
        dryRun: false,
        universes: ["sandbox"],
        ledgers: { sandbox: ledger },
        send,
      }),
      tick(cfg, {
        nowUnix: PUSH_AT,
        dryRun: false,
        universes: ["sandbox"],
        ledgers: { sandbox: ledger },
        send,
      }),
    ]);
    expect(maxFlight).toBe(1);
    expect(calls.length).toBe(1);
    ledger.close();
  });

  it("retryable network (status 0) leaves pending for the next tick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-"));
    writeFileSync(join(dir, "empty.json"), JSON.stringify({ userIds: [] }));
    const allowlistPath = writeAllowlist(dir, [555]);
    const cfg = cfgFor(dir, allowlistPath);
    const ledger = new Ledger(":memory:");
    const calls: number[] = [];
    await tick(cfg, {
      nowUnix: PUSH_AT,
      dryRun: false,
      universes: ["sandbox"],
      ledgers: { sandbox: ledger },
      send: async () => {
        calls.push(1);
        return { status: 0, body: "fetch failed: read ECONNRESET (ECONNRESET)" };
      },
    });
    expect(calls).toEqual([1]);
    expect(ledger.get("7034342160", "2026-09-10T16", 555)?.status).toBe("pending");
    await tick(cfg, {
      nowUnix: PUSH_AT,
      dryRun: false,
      universes: ["sandbox"],
      ledgers: { sandbox: ledger },
      send: async () => {
        calls.push(1);
        return { status: 200, body: "{}" };
      },
    });
    expect(calls).toEqual([1, 1]);
    expect(ledger.get("7034342160", "2026-09-10T16", 555)?.status).toBe("sent");
    ledger.close();
  });

  it("pending + closed window does not POST", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-"));
    writeFileSync(join(dir, "empty.json"), JSON.stringify({ userIds: [] }));
    const allowlistPath = writeAllowlist(dir, [333]);
    const cfg = cfgFor(dir, allowlistPath);
    const ledger = new Ledger(":memory:");
    ledger.reserve({
      universe_id: "7034342160",
      slot_key: "2026-09-10T16",
      user_id: 333,
      slot_unix: SLOT_UNIX,
      push_at: PUSH_AT,
      created_unix: PUSH_AT,
    });
    const calls: number[] = [];
    await tick(cfg, {
      nowUnix: PUSH_AT + 120,
      dryRun: false,
      universes: ["sandbox"],
      ledgers: { sandbox: ledger },
      send: async () => {
        calls.push(1);
        return { status: 200, body: "{}" };
      },
    });
    expect(calls).toEqual([]);
    expect(ledger.get("7034342160", "2026-09-10T16", 333)?.status).toBe("pending");
    ledger.close();
  });

  it("sandbox send never uses the Live universe id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-"));
    writeFileSync(join(dir, "empty.json"), JSON.stringify({ userIds: [] }));
    const allowlistPath = writeAllowlist(dir, [444]);
    const cfg = cfgFor(dir, allowlistPath);
    const ledger = new Ledger(":memory:");
    const universes: string[] = [];
    await tick(cfg, {
      nowUnix: PUSH_AT,
      dryRun: false,
      universes: ["sandbox"],
      ledgers: { sandbox: ledger },
      send: async (req) => {
        universes.push(req.universeId);
        return { status: 200, body: "{}" };
      },
    });
    expect(universes).toEqual(["7034342160"]);
    expect(universes).not.toContain("6674250544");
    ledger.close();
  });

  it("sends one MOMENT per UTC ISO week, then again the next week", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-"));
    writeFileSync(join(dir, "empty.json"), JSON.stringify({ userIds: [] }));
    const allowlistPath = writeAllowlist(dir, [777]);
    const cfg = cfgFor(dir, allowlistPath);
    const ledger = new Ledger(":memory:");
    const calls: string[] = [];
    const send = async (req: { slotKey: string }) => {
      calls.push(req.slotKey);
      return { status: 200, body: "{}" };
    };
    const opts = {
      dryRun: false as const,
      universes: ["sandbox"] as const,
      ledgers: { sandbox: ledger },
      send,
    };

    await tick(cfg, { ...opts, nowUnix: PUSH_AT });
    expect(calls).toEqual(["2026-09-10T16"]);

    const fridayPush = pushAtFor("2026-09-11T16", PUSH_AT + 86_400);
    await tick(cfg, { ...opts, nowUnix: fridayPush });
    expect(calls).toEqual(["2026-09-10T16"]);
    expect(ledger.hasMomentToday("7034342160", 777, "2026-09-11")).toBe(false);

    const nextWeekPush = pushAtFor("2026-09-17T16", PUSH_AT + 7 * 86_400);
    await tick(cfg, { ...opts, nowUnix: nextWeekPush });
    expect(calls).toEqual(["2026-09-10T16", "2026-09-17T16"]);
    expect(ledger.hasMomentBetween("7034342160", 777, "2026-09-14", "2026-09-20")).toBe(true);
    ledger.close();
  });
});

describe("manual sandbox send", () => {
  it("POSTs outside the send window and records the UTC-week cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-"));
    writeFileSync(join(dir, "empty.json"), JSON.stringify({ userIds: [] }));
    const allowlistPath = writeAllowlist(dir, [3757284903]);
    const cfg = cfgFor(dir, allowlistPath);
    cfg.dryRun = true;
    const ledger = new Ledger(":memory:");
    const calls: { universeId: string; slotKey: string }[] = [];
    const outsideWindow = PUSH_AT + 10_000;
    const result = await sendSandboxNow(cfg, {
      nowUnix: outsideWindow,
      ledgers: { sandbox: ledger },
      send: async (req) => {
        calls.push({ universeId: req.universeId, slotKey: req.slotKey });
        return { status: 200, body: "{}" };
      },
    });
    expect(result.error).toBeUndefined();
    expect(calls).toEqual([{ universeId: "7034342160", slotKey: result.slotKey }]);
    expect(calls[0].universeId).not.toBe("6674250544");
    expect(result.slotKey.startsWith("manual:")).toBe(true);
    expect(result.results[0]).toMatchObject({ userId: 3757284903, outcome: "sent" });
    expect(ledger.hasMomentToday("7034342160", 3757284903, result.utcDate)).toBe(true);

    const second = await sendSandboxNow(cfg, {
      nowUnix: outsideWindow,
      ledgers: { sandbox: ledger },
      send: async () => {
        calls.push({ universeId: "nope", slotKey: "nope" });
        return { status: 200, body: "{}" };
      },
    });
    expect(calls).toHaveLength(1);
    expect(second.results[0].outcome).toBe("skipped");

    cfg.dryRun = false;
    await tick(cfg, {
      nowUnix: PUSH_AT,
      dryRun: false,
      universes: ["sandbox"],
      ledgers: { sandbox: ledger },
      send: async (req) => {
        calls.push({ universeId: req.universeId, slotKey: req.slotKey });
        return { status: 200, body: "{}" };
      },
    });
    expect(calls).toHaveLength(1);
    ledger.close();
  });

  it("does not send when the allowlist is empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-"));
    writeFileSync(join(dir, "empty.json"), JSON.stringify({ userIds: [] }));
    const cfg = cfgFor(dir, join(dir, "empty.json"));
    const calls: number[] = [];
    const result = await sendSandboxNow(cfg, {
      nowUnix: PUSH_AT,
      send: async () => {
        calls.push(1);
        return { status: 200, body: "{}" };
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/allowlist/i);
    expect(calls).toEqual([]);
  });

  it("does not send without a real sandbox API key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-"));
    const allowlistPath = writeAllowlist(dir, [1]);
    writeFileSync(join(dir, "empty.json"), JSON.stringify({ userIds: [] }));
    const cfg = cfgFor(dir, allowlistPath);
    cfg.apiKey.sandbox = "rbx_placeholder_sandbox";
    const calls: number[] = [];
    const result = await sendSandboxNow(cfg, {
      nowUnix: PUSH_AT,
      send: async () => {
        calls.push(1);
        return { status: 200, body: "{}" };
      },
    });
    expect(result.error).toMatch(/API_KEY/);
    expect(calls).toEqual([]);
  });
});
