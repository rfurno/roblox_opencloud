import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.ts";
import { parseSnapshotBody, snapshotUrl } from "../src/roblox.ts";
import { takeSnapshotNow, tickSnapshots } from "../src/snapshot.ts";
import { Ledger } from "../src/store.ts";

const PUSH_AT = 1_789_055_953;
const WINDOW_CLOSED = PUSH_AT + 60;

function cfgFor(dir: string): AppConfig {
  return {
    schedule: {
      scheduleTimeZone: "Etc/UTC",
      jitterSeconds: 600,
      pushLeadSeconds: 480,
      sendWindowSeconds: 60,
      tickIntervalSeconds: 30,
      sandbox: {
        universeId: "7034342160",
        placeId: "117194948580255",
        hoursLocal: [16, 4, 10, 22],
        notifyHoursLocal: [16, 4, 10, 22],
        allowlistPath: join(dir, "empty.json"),
      },
      live: {
        universeId: "6674250544",
        placeId: "98219898516303",
        hoursLocal: [16, 4],
        notifyHoursLocal: [16],
        allowlistPath: join(dir, "empty.json"),
      },
    },
    dryRun: true,
    liveSendsEnabled: false,
    dataDir: dir,
    port: 0,
    openBrowser: false,
    logUserResults: false,
    apiKey: { sandbox: "", live: "" },
    snapshotApiKey: { sandbox: "", live: "live-snapshot-key" },
    messageId: { sandbox: "", live: "" },
  };
}

describe("snapshot API helpers", () => {
  it("builds the Open Cloud snapshot URL", () => {
    expect(snapshotUrl("6674250544")).toBe(
      "https://apis.roblox.com/cloud/v2/universes/6674250544/data-stores:snapshot",
    );
  });

  it("parses newSnapshotTaken and latestSnapshotTime", () => {
    expect(
      parseSnapshotBody(
        JSON.stringify({
          newSnapshotTaken: true,
          latestSnapshotTime: "2026-09-11T00:05:12Z",
        }),
      ),
    ).toEqual({
      newSnapshotTaken: true,
      latestSnapshotTime: "2026-09-11T00:05:12Z",
    });
    expect(parseSnapshotBody("{")).toEqual({
      newSnapshotTaken: null,
      latestSnapshotTime: null,
    });
  });
});

describe("daily snapshot job", () => {
  it("skips HTTP while a Collector notify window is open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-snap-"));
    const cfg = cfgFor(dir);
    const calls: string[] = [];
    const result = await tickSnapshots(cfg, {
      nowUnix: PUSH_AT,
      snapshot: async ({ universeId }) => {
        calls.push(universeId);
        return {
          status: 200,
          body: "{}",
          newSnapshotTaken: true,
          latestSnapshotTime: "2026-09-10T15:59:13Z",
        };
      },
    });
    expect(result.sendWindowOpen).toBe(true);
    expect(result.results).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("POSTs Live once per UTC day after the send window, even when DRY_RUN", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-snap-"));
    const cfg = cfgFor(dir);
    const live = new Ledger(":memory:");
    const calls: string[] = [];
    const snapshot = async ({ universeId, apiKey }: { universeId: string; apiKey: string }) => {
      calls.push(`${apiKey}:${universeId}`);
      return {
        status: 200,
        body: JSON.stringify({
          newSnapshotTaken: true,
          latestSnapshotTime: "2026-09-10T16:01:00Z",
        }),
        newSnapshotTaken: true,
        latestSnapshotTime: "2026-09-10T16:01:00Z",
      };
    };
    const first = await tickSnapshots(cfg, {
      nowUnix: WINDOW_CLOSED,
      ledgers: { live },
      snapshot,
    });
    const second = await tickSnapshots(cfg, {
      nowUnix: WINDOW_CLOSED + 30,
      ledgers: { live },
      snapshot,
    });
    expect(cfg.dryRun).toBe(true);
    expect(first.sendWindowOpen).toBe(false);
    expect(first.results.map((r) => [r.job, r.outcome, r.universeId])).toEqual([
      ["sandbox", "skipped", "7034342160"],
      ["live", "taken", "6674250544"],
    ]);
    expect(second.results.find((r) => r.job === "live")?.outcome).toBe("already");
    expect(calls).toEqual(["live-snapshot-key:6674250544"]);
    expect(live.hasSnapshotToday("6674250544", "2026-09-10")).toBe(true);
  });

  it("does not use the Live universe id for Sandbox", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-snap-"));
    const cfg = cfgFor(dir);
    cfg.snapshotApiKey.sandbox = "sandbox-snapshot-key";
    const seen: string[] = [];
    await tickSnapshots(cfg, {
      nowUnix: WINDOW_CLOSED,
      universes: ["sandbox"],
      snapshot: async ({ universeId }) => {
        seen.push(universeId);
        return {
          status: 200,
          body: "{}",
          newSnapshotTaken: true,
          latestSnapshotTime: "2026-09-10T16:01:00Z",
        };
      },
    });
    expect(seen).toEqual(["7034342160"]);
    expect(seen).not.toContain("6674250544");
  });

  it("leaves the day unrecorded on 429 so the next tick retries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-snap-"));
    const cfg = cfgFor(dir);
    const live = new Ledger(":memory:");
    const first = await tickSnapshots(cfg, {
      nowUnix: WINDOW_CLOSED,
      ledgers: { live },
      snapshot: async () => ({
        status: 429,
        body: "slow down",
        newSnapshotTaken: null,
        latestSnapshotTime: null,
      }),
    });
    expect(first.results.find((r) => r.job === "live")?.outcome).toBe("retry");
    expect(live.hasSnapshotToday("6674250544", "2026-09-10")).toBe(false);
    const second = await takeSnapshotNow(cfg, "live", {
      nowUnix: WINDOW_CLOSED + 30,
      ledgers: { live },
      snapshot: async () => ({
        status: 200,
        body: "{}",
        newSnapshotTaken: false,
        latestSnapshotTime: "2026-09-10T12:00:00Z",
      }),
    });
    expect(second.outcome).toBe("already");
    expect(second.latestSnapshotTime).toBe("2026-09-10T12:00:00Z");
    expect(live.hasSnapshotToday("6674250544", "2026-09-10")).toBe(true);
  });
});
