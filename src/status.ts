import { loadAllowlist } from "./audience.ts";
import { getLedger } from "./store.ts";
import {
  clockSlotsNear,
  formatUtc,
  inSendWindow,
  isNotifyHour,
  nextUpcoming,
  type Slot,
} from "./clock.ts";
import type { AppConfig, UniverseName } from "./config.ts";
import { apiKeyConfigured, jobOf, messageIdConfigured, universeNames } from "./config.ts";
import { recentTicks } from "./logs.ts";
import { snapshotStatus } from "./snapshot.ts";

export type PublicSlot = {
  key: string;
  hourLocal: number;
  notify: boolean;
  unix: number;
  pushAt: number;
  toastAt: number;
  catchEnd: number;
  jitter: number;
  spawnUtc: string;
  pushUtc: string;
  inSendWindow: boolean;
  secondsToPush: number;
  secondsToSpawn: number;
};

function publicSlot(slot: Slot, nowUnix: number, sendWindow: number, notifyHours: number[]): PublicSlot {
  return {
    key: slot.key,
    hourLocal: slot.hourLocal,
    notify: isNotifyHour(slot.hourLocal, notifyHours),
    unix: slot.unix,
    pushAt: slot.pushAt,
    toastAt: slot.toastAt,
    catchEnd: slot.catchEnd,
    jitter: slot.jitter,
    spawnUtc: formatUtc(slot.unix),
    pushUtc: formatUtc(slot.pushAt),
    inSendWindow: inSendWindow(nowUnix, slot, sendWindow),
    secondsToPush: slot.pushAt - nowUnix,
    secondsToSpawn: slot.unix - nowUnix,
  };
}

export function buildStatus(cfg: AppConfig, nowUnix = Math.floor(Date.now() / 1000)) {
  const jobs: Record<string, unknown> = {};
  for (const name of universeNames()) {
    const job = jobOf(cfg.schedule, name);
    const slots = clockSlotsNear(nowUnix, {
      timeZone: cfg.schedule.scheduleTimeZone,
      hoursLocal: job.hoursLocal,
      jitterSeconds: cfg.schedule.jitterSeconds,
      pushLeadSeconds: cfg.schedule.pushLeadSeconds,
    });
    const publicSlots = slots.map((s) =>
      publicSlot(s, nowUnix, cfg.schedule.sendWindowSeconds, job.notifyHoursLocal),
    );
    const windowSlot = publicSlots.find((s) => s.notify && s.inSendWindow) ?? null;
    const nextNotify =
      nextUpcoming(
        nowUnix,
        slots.filter((s) => isNotifyHour(s.hourLocal, job.notifyHoursLocal)),
      ) ?? nextUpcoming(nowUnix, slots);
    const cache = getLedger(cfg, name).getAudienceCache(job.universeId);
    jobs[name] = {
      universeId: job.universeId,
      placeId: job.placeId,
      hoursLocal: job.hoursLocal,
      notifyHoursLocal: job.notifyHoursLocal,
      allowlistN: loadAllowlist(job.allowlistPath).length,
      audience: cache
        ? {
            source: cache.source,
            notifyN: cache.userIds.length,
            everOwnedN: cache.storeListedN,
            staleN: cache.recencyDroppedN,
            n: cache.userIds.length,
            storeListedN: cache.storeListedN,
            recencyDroppedN: cache.recencyDroppedN,
            refreshedUnix: cache.refreshedUnix,
            refreshedUtc: formatUtc(cache.refreshedUnix),
          }
        : null,
      windowSlot,
      nextNotify: nextNotify
        ? publicSlot(nextNotify, nowUnix, cfg.schedule.sendWindowSeconds, job.notifyHoursLocal)
        : null,
      slots: publicSlots,
    };
  }

  return {
    nowUnix,
    nowUtc: formatUtc(nowUnix),
    dryRun: cfg.dryRun,
    liveSendsEnabled: cfg.liveSendsEnabled,
    port: cfg.port,
    timeZone: cfg.schedule.scheduleTimeZone,
    tickIntervalSeconds: cfg.schedule.tickIntervalSeconds,
    keysConfigured: {
      sandbox: apiKeyConfigured(cfg.apiKey.sandbox),
      live: apiKeyConfigured(cfg.apiKey.live),
    },
    snapshotKeysConfigured: {
      sandbox: apiKeyConfigured(cfg.snapshotApiKey.sandbox),
      live: apiKeyConfigured(cfg.snapshotApiKey.live),
    },
    datastoreKeysConfigured: {
      sandbox: apiKeyConfigured(cfg.datastoreApiKey.sandbox),
      live: apiKeyConfigured(cfg.datastoreApiKey.live),
    },
    messageConfigured: {
      sandbox: messageIdConfigured(cfg.messageId.sandbox),
      live: messageIdConfigured(cfg.messageId.live),
    },
    jobs,
    snapshots: snapshotStatus(cfg, nowUnix),
    ticks: recentTicks(),
  };
}
