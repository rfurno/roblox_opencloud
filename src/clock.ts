import { DateTime } from "luxon";

/** Match Luau SpecialNpcDirector.hash32. Do not use Math.imul / BigInt. */
export function hash32(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h = (h ^ key.charCodeAt(i)) >>> 0;
    h = ((h * 16777619) % 4294967296) >>> 0;
  }
  return h;
}

/** Textbook uint32 FNV — wrong clock (jitter 237 for 2026-09-10T16). Tests must not use this. */
export function hash32Imul(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  }
  return h;
}

export function jitterFor(key: string, span = 600): number {
  const s = Math.floor(span);
  if (s <= 0) return 0;
  return (hash32(key) % (2 * s + 1)) - s;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatSlotKey(year: number, month: number, day: number, hour: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}`;
}

export function utcDateFromUnix(unix: number): string {
  const dt = DateTime.fromSeconds(unix, { zone: "utc" });
  return `${dt.year}-${pad2(dt.month)}-${pad2(dt.day)}`;
}

export function formatUtc(unix: number): string {
  return DateTime.fromSeconds(unix, { zone: "utc" }).toFormat("yyyy-LL-dd HH:mm:ss") + "Z";
}

export type Slot = {
  key: string;
  unix: number;
  nominalUnix: number;
  hourLocal: number;
  jitter: number;
  pushAt: number;
  toastAt: number;
  catchEnd: number;
};

export type ClockOptions = {
  timeZone: string;
  hoursLocal: number[];
  jitterSeconds: number;
  pushLeadSeconds: number;
  toastLeadSeconds?: number;
  catchWindowSeconds?: number;
};

export function clockSlotsNear(nowUnix: number, opts: ClockOptions): Slot[] {
  const zone = opts.timeZone || "Etc/UTC";
  const span = opts.jitterSeconds;
  const pushLead = opts.pushLeadSeconds;
  const toastLead = opts.toastLeadSeconds ?? 120;
  const catchWindow = opts.catchWindowSeconds ?? 600;
  const slots: Slot[] = [];

  for (const dayOffset of [-1, 0, 1]) {
    const local = DateTime.fromSeconds(nowUnix, { zone }).plus({ days: dayOffset });
    for (const rawHour of opts.hoursLocal) {
      const hourLocal = Math.min(23, Math.max(0, Math.floor(Number(rawHour) || 0)));
      const localNoonish = DateTime.fromObject(
        {
          year: local.year,
          month: local.month,
          day: local.day,
          hour: hourLocal,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { zone },
      );
      if (!localNoonish.isValid) continue;
      const nominalUnix = localNoonish.toUnixInteger();
      const utc = DateTime.fromSeconds(nominalUnix, { zone: "utc" });
      const key = formatSlotKey(utc.year, utc.month, utc.day, utc.hour);
      if (key.startsWith("studio:")) continue;
      const jitter = jitterFor(key, span);
      const unix = nominalUnix + jitter;
      slots.push({
        key,
        unix,
        nominalUnix,
        hourLocal,
        jitter,
        pushAt: unix - pushLead,
        toastAt: unix - toastLead,
        catchEnd: unix + catchWindow,
      });
    }
  }

  slots.sort((a, b) => a.unix - b.unix || a.key.localeCompare(b.key));
  return slots;
}

export function inSendWindow(nowUnix: number, slot: Slot, sendWindowSeconds: number): boolean {
  return nowUnix >= slot.pushAt && nowUnix < slot.pushAt + sendWindowSeconds;
}

export function isNotifyHour(hourLocal: number, notifyHoursLocal: number[]): boolean {
  return notifyHoursLocal.includes(hourLocal);
}

export function nextUpcoming(nowUnix: number, slots: Slot[]): Slot | null {
  let best: Slot | null = null;
  for (const slot of slots) {
    if (slot.unix > nowUnix && (!best || slot.unix < best.unix)) best = slot;
  }
  return best;
}

export function msUntilNextBoundary(nowMs: number, intervalSeconds: number): number {
  const intervalMs = intervalSeconds * 1000;
  const next = Math.floor(nowMs / intervalMs) * intervalMs + intervalMs;
  return Math.max(1, next - nowMs);
}
