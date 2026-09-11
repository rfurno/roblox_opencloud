import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  clockSlotsNear,
  formatSlotKey,
  hash32,
  hash32Imul,
  inSendWindow,
  isNotifyHour,
  jitterFor,
} from "../src/clock.ts";

const GOLDEN = {
  key: "2026-09-10T16",
  hash: 1396388120,
  jitter: 433,
  nominalUnix: 1789056000,
  slotUnix: 1789056433,
  pushAt: 1789055953,
};

describe("Luau hash32", () => {
  it("matches Studio golden 2026-09-10T16", () => {
    expect(hash32(GOLDEN.key)).toBe(GOLDEN.hash);
    expect(jitterFor(GOLDEN.key, 600)).toBe(GOLDEN.jitter);
  });

  it("does not match Math.imul / textbook FNV (237)", () => {
    expect(hash32Imul(GOLDEN.key)).toBe(1898790244);
    expect((hash32Imul(GOLDEN.key) % 1201) - 600).toBe(237);
    expect(jitterFor(GOLDEN.key, 600)).not.toBe(237);
  });

  it("matches the rest of the Luau table", () => {
    const rows: [string, number, number][] = [
      ["2026-09-10T16", 1396388120, 433],
      ["2026-09-10T04", 1379463408, 213],
      ["2026-09-10T10", 1429943360, -267],
      ["2026-09-10T22", 1480423312, 454],
      ["2026-09-11T04", 680209728, -41],
    ];
    for (const [key, hash, jitter] of rows) {
      expect(hash32(key)).toBe(hash);
      expect(jitterFor(key, 600)).toBe(jitter);
    }
  });
});

describe("clockSlotsNear Etc/UTC", () => {
  const opts = {
    timeZone: "Etc/UTC",
    hoursLocal: [16, 4],
    jitterSeconds: 600,
    pushLeadSeconds: 480,
  };

  it("builds 2026-09-10T16 with slotUnix 1789056433", () => {
    const slots = clockSlotsNear(GOLDEN.nominalUnix, opts);
    const slot = slots.find((s) => s.key === GOLDEN.key);
    expect(slot).toBeTruthy();
    expect(slot!.nominalUnix).toBe(GOLDEN.nominalUnix);
    expect(slot!.unix).toBe(GOLDEN.slotUnix);
    expect(slot!.pushAt).toBe(GOLDEN.pushAt);
    expect(slot!.hourLocal).toBe(16);
  });

  it("never emits studio: keys", () => {
    const slots = clockSlotsNear(GOLDEN.nominalUnix, opts);
    expect(slots.some((s) => s.key.startsWith("studio:"))).toBe(false);
  });

  it("is independent of process TZ (same unix)", () => {
    const slots = clockSlotsNear(1_789_056_000, opts);
    const slot = slots.find((s) => s.key === GOLDEN.key)!;
    expect(slot.unix).toBe(GOLDEN.slotUnix);
    expect(formatSlotKey(2026, 9, 10, 16)).toBe(GOLDEN.key);
  });
});

describe("notifyHoursLocal is the generating civil hour", () => {
  it("Live Etc/UTC [16] computes 04:00 but does not notify it", () => {
    const slots = clockSlotsNear(GOLDEN.nominalUnix, {
      timeZone: "Etc/UTC",
      hoursLocal: [16, 4],
      jitterSeconds: 600,
      pushLeadSeconds: 480,
    });
    const four = slots.find((s) => s.key === "2026-09-10T04")!;
    const sixteen = slots.find((s) => s.key === GOLDEN.key)!;
    expect(four).toBeTruthy();
    expect(isNotifyHour(four.hourLocal, [16])).toBe(false);
    expect(isNotifyHour(sixteen.hourLocal, [16])).toBe(true);
  });

  it("Sao Paulo [13, 1] + notify [13] sends only 16:00Z", () => {
    const slots = clockSlotsNear(GOLDEN.nominalUnix, {
      timeZone: "America/Sao_Paulo",
      hoursLocal: [13, 1],
      jitterSeconds: 600,
      pushLeadSeconds: 480,
    });
    const sixteen = slots.find((s) => s.key === GOLDEN.key)!;
    expect(sixteen.hourLocal).toBe(13);
    expect(sixteen.unix).toBe(GOLDEN.slotUnix);
    expect(isNotifyHour(sixteen.hourLocal, [13])).toBe(true);
    const four = slots.find((s) => s.key.endsWith("T04"));
    if (four) expect(isNotifyHour(four.hourLocal, [13])).toBe(false);
  });
});

describe("send window", () => {
  it("opens at pushAt and is exclusive of pushAt+60", () => {
    const slot = clockSlotsNear(GOLDEN.nominalUnix, {
      timeZone: "Etc/UTC",
      hoursLocal: [16],
      jitterSeconds: 600,
      pushLeadSeconds: 480,
    }).find((s) => s.key === GOLDEN.key)!;
    expect(inSendWindow(slot.pushAt, slot, 60)).toBe(true);
    expect(inSendWindow(slot.pushAt + 59, slot, 60)).toBe(true);
    expect(inSendWindow(slot.pushAt + 60, slot, 60)).toBe(false);
    expect(inSendWindow(slot.unix, slot, 60)).toBe(false);
  });
});

describe("DST freeze (do not silently switch TCG hours)", () => {
  it("NY civil 16:00 is not UTC hour 16", () => {
    const spring = DateTime.fromObject(
      { year: 2026, month: 3, day: 8, hour: 16 },
      { zone: "America/New_York" },
    ).toUnixInteger();
    const fall = DateTime.fromObject(
      { year: 2026, month: 11, day: 1, hour: 16 },
      { zone: "America/New_York" },
    ).toUnixInteger();
    const springUtc = DateTime.fromSeconds(spring, { zone: "utc" });
    const fallUtc = DateTime.fromSeconds(fall, { zone: "utc" });
    expect(springUtc.hour).toBe(20);
    expect(fallUtc.hour).toBe(21);
  });
});
