import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDataStoreEntry,
  isRetryable,
  listDataStoreEntries,
  sendMoment,
  snapshotDataStores,
} from "../src/roblox.ts";

function econnreset(): TypeError {
  const cause = Object.assign(new Error("read ECONNRESET"), {
    code: "ECONNRESET",
    errno: -54,
    syscall: "read",
  });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Open Cloud fetch errors", () => {
  it("maps ECONNRESET to status 0 (retryable) instead of throwing", async () => {
    vi.stubGlobal("fetch", async () => {
      throw econnreset();
    });

    const moment = await sendMoment({
      userId: 1,
      universeId: "7034342160",
      apiKey: "k",
      messageId: "msg",
      slotKey: "2026-09-10T16",
    });
    expect(moment.status).toBe(0);
    expect(moment.body).toMatch(/ECONNRESET/);
    expect(isRetryable(moment.status)).toBe(true);

    const listed = await listDataStoreEntries({
      universeId: "7034342160",
      apiKey: "k",
    });
    expect(listed.status).toBe(0);
    expect(listed.entries).toEqual([]);

    const got = await getDataStoreEntry({
      apiKey: "k",
      path: "universes/7034342160/data-stores/CollectorNotify/entries/1",
    });
    expect(got.status).toBe(0);
    expect(got.value).toBeNull();

    const snap = await snapshotDataStores({ universeId: "6674250544", apiKey: "k" });
    expect(snap.status).toBe(0);
    expect(snap.newSnapshotTaken).toBeNull();
  });
});
