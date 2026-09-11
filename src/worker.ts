import { loadAllowlist } from "./audience.ts";
import {
  clockSlotsNear,
  inSendWindow,
  isNotifyHour,
  utcDateFromUnix,
  type Slot,
} from "./clock.ts";
import { apiKeyConfigured, jobOf, messageIdConfigured, type AppConfig, type UniverseName } from "./config.ts";
import { recordTick } from "./logs.ts";
import {
  isNonRetryable,
  isRetryable,
  isSuccess,
  sendMoment,
  type MomentResult,
} from "./roblox.ts";
import { Ledger, ledgerPath } from "./store.ts";

export type SendFn = (args: {
  userId: number;
  universeId: string;
  apiKey: string;
  messageId: string;
  slotKey: string;
}) => Promise<MomentResult>;

export type TickOptions = {
  nowUnix?: number;
  dryRun?: boolean;
  universes?: UniverseName[];
  send?: SendFn;
  ledgers?: Partial<Record<UniverseName, Ledger>>;
};

const defaultLedgers = new Map<string, Ledger>();
let tickChain: Promise<void> = Promise.resolve();

export function getLedger(cfg: AppConfig, name: UniverseName, injected?: Ledger): Ledger {
  if (injected) return injected;
  const path = ledgerPath(cfg.dataDir, name);
  let existing = defaultLedgers.get(path);
  if (!existing) {
    existing = new Ledger(path);
    defaultLedgers.set(path, existing);
  }
  return existing;
}

export async function tick(cfg: AppConfig, opts: TickOptions = {}): Promise<void> {
  const run = () => tickInner(cfg, opts);
  const next = tickChain.then(run, run);
  tickChain = next;
  return next;
}

async function tickInner(cfg: AppConfig, opts: TickOptions): Promise<void> {
  const nowUnix = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const names = opts.universes ?? (["sandbox", "live"] as UniverseName[]);
  for (const name of names) {
    await tickUniverse(cfg, name, nowUnix, opts);
  }
}

async function tickUniverse(
  cfg: AppConfig,
  name: UniverseName,
  nowUnix: number,
  opts: TickOptions,
): Promise<void> {
  const job = jobOf(cfg.schedule, name);
  const dryRun = opts.dryRun ?? cfg.dryRun;
  const slots = clockSlotsNear(nowUnix, {
    timeZone: cfg.schedule.scheduleTimeZone,
    hoursLocal: job.hoursLocal,
    jitterSeconds: cfg.schedule.jitterSeconds,
    pushLeadSeconds: cfg.schedule.pushLeadSeconds,
  });

  const windowSlots = slots.filter(
    (slot) =>
      !slot.key.startsWith("studio:") &&
      isNotifyHour(slot.hourLocal, job.notifyHoursLocal) &&
      inSendWindow(nowUnix, slot, cfg.schedule.sendWindowSeconds),
  );

  if (windowSlots.length === 0) {
    recordTick({
      universeId: job.universeId,
      job: name,
      tickUnix: nowUnix,
      slotKey: null,
      slotUnix: null,
      pushAt: null,
      audienceN: 0,
      sentN: 0,
      failN: 0,
      skipN: 0,
      dryRun,
      note: "no slot in send window",
    });
    return;
  }

  for (const slot of windowSlots) {
    await sendSlot(cfg, name, slot, nowUnix, dryRun, opts);
  }
}

async function sendSlot(
  cfg: AppConfig,
  name: UniverseName,
  slot: Slot,
  nowUnix: number,
  dryRun: boolean,
  opts: TickOptions,
): Promise<void> {
  const job = jobOf(cfg.schedule, name);
  const allowlist = loadAllowlist(job.allowlistPath);

  if (dryRun) {
    recordTick({
      universeId: job.universeId,
      job: name,
      tickUnix: nowUnix,
      slotKey: slot.key,
      slotUnix: slot.unix,
      pushAt: slot.pushAt,
      audienceN: allowlist.length,
      sentN: 0,
      failN: 0,
      skipN: allowlist.length,
      dryRun: true,
      note: "dry-run: no HTTP, no ledger writes",
    });
    return;
  }

  if (name === "live" && !cfg.liveSendsEnabled) {
    recordTick({
      universeId: job.universeId,
      job: name,
      tickUnix: nowUnix,
      slotKey: slot.key,
      slotUnix: slot.unix,
      pushAt: slot.pushAt,
      audienceN: allowlist.length,
      sentN: 0,
      failN: 0,
      skipN: allowlist.length,
      dryRun: false,
      note: "LIVE_SENDS_ENABLED=false",
    });
    return;
  }

  if (allowlist.length === 0) {
    recordTick({
      universeId: job.universeId,
      job: name,
      tickUnix: nowUnix,
      slotKey: slot.key,
      slotUnix: slot.unix,
      pushAt: slot.pushAt,
      audienceN: 0,
      sentN: 0,
      failN: 0,
      skipN: 0,
      dryRun: false,
      note: "empty allowlist",
    });
    return;
  }

  const ledger = getLedger(cfg, name, opts.ledgers?.[name]);
  const send = opts.send ?? sendMoment;
  const utcDate = utcDateFromUnix(nowUnix);
  let sentN = 0;
  let failN = 0;
  let skipN = 0;

  for (const userId of allowlist) {
    if (!inSendWindow(nowUnix, slot, cfg.schedule.sendWindowSeconds)) {
      skipN += 1;
      continue;
    }
    if (ledger.hasMomentToday(job.universeId, userId, utcDate)) {
      skipN += 1;
      continue;
    }

    const reserved = ledger.reserve({
      universe_id: job.universeId,
      slot_key: slot.key,
      user_id: userId,
      slot_unix: slot.unix,
      push_at: slot.pushAt,
      created_unix: nowUnix,
    });

    if (reserved.status === "sent" || reserved.status === "failed") {
      skipN += 1;
      continue;
    }

    const wallNow = opts.nowUnix !== undefined ? nowUnix : Math.floor(Date.now() / 1000);
    const stillOpen = inSendWindow(wallNow, slot, cfg.schedule.sendWindowSeconds);
    if (reserved.status === "pending" && !stillOpen) {
      skipN += 1;
      continue;
    }

    const result = await send({
      userId,
      universeId: job.universeId,
      apiKey: cfg.apiKey[name],
      messageId: cfg.messageId[name],
      slotKey: slot.key,
    });

    if (cfg.logUserResults) {
      console.log(
        JSON.stringify({
          userId,
          httpStatus: result.status,
          slotKey: slot.key,
          job: name,
        }),
      );
    }

    if (isSuccess(result.status)) {
      const marked = ledger.markSent({
        universeId: job.universeId,
        slotKey: slot.key,
        userId,
        httpStatus: result.status,
        sentUnix: Math.floor(Date.now() / 1000),
        utcDate,
      });
      if (marked) sentN += 1;
      else skipN += 1;
    } else if (isNonRetryable(result.status)) {
      const marked = ledger.markFailed({
        universeId: job.universeId,
        slotKey: slot.key,
        userId,
        httpStatus: result.status,
        error: result.body.slice(0, 300),
      });
      if (marked) failN += 1;
      else skipN += 1;
    } else if (isRetryable(result.status)) {
      skipN += 1;
    } else {
      skipN += 1;
    }
  }

  recordTick({
    universeId: job.universeId,
    job: name,
    tickUnix: nowUnix,
    slotKey: slot.key,
    slotUnix: slot.unix,
    pushAt: slot.pushAt,
    audienceN: allowlist.length,
    sentN,
    failN,
    skipN,
    dryRun: false,
  });
}

export type ManualSendRow = {
  userId: number;
  httpStatus: number | null;
  outcome: "sent" | "failed" | "skipped" | "retry";
  error?: string;
};

export type ManualSendResult = {
  ok: boolean;
  error?: string;
  utcDate: string;
  slotKey: string;
  universeId: string;
  audienceN: number;
  results: ManualSendRow[];
};

function manualSlotKey(utcDate: string): string {
  return `manual:${utcDate}`;
}

export async function sendSandboxNow(
  cfg: AppConfig,
  opts: TickOptions = {},
): Promise<ManualSendResult> {
  const run = () => sendSandboxNowInner(cfg, opts);
  const next = tickChain.then(run, run);
  tickChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function sendSandboxNowInner(
  cfg: AppConfig,
  opts: TickOptions,
): Promise<ManualSendResult> {
  const name: UniverseName = "sandbox";
  const job = jobOf(cfg.schedule, name);
  const nowUnix = opts.nowUnix ?? Math.floor(Date.now() / 1000);
  const utcDate = utcDateFromUnix(nowUnix);
  const slotKey = manualSlotKey(utcDate);
  const empty: ManualSendResult = {
    ok: false,
    utcDate,
    slotKey,
    universeId: job.universeId,
    audienceN: 0,
    results: [],
  };

  if (job.universeId === "6674250544") {
    return { ...empty, error: "refusing Live universe" };
  }
  if (!apiKeyConfigured(cfg.apiKey.sandbox)) {
    return { ...empty, error: "ROBLOX_API_KEY_SANDBOX is missing" };
  }
  if (!messageIdConfigured(cfg.messageId.sandbox)) {
    return { ...empty, error: "MESSAGE_ID_SANDBOX is missing" };
  }

  const allowlist = loadAllowlist(job.allowlistPath);
  empty.audienceN = allowlist.length;
  if (allowlist.length === 0) {
    return { ...empty, error: "sandbox allowlist is empty" };
  }

  const ledger = getLedger(cfg, name, opts.ledgers?.[name]);
  const send = opts.send ?? sendMoment;
  const results: ManualSendRow[] = [];
  let sentN = 0;
  let failN = 0;
  let skipN = 0;

  for (const userId of allowlist) {
    if (ledger.hasMomentToday(job.universeId, userId, utcDate)) {
      skipN += 1;
      results.push({
        userId,
        httpStatus: null,
        outcome: "skipped",
        error: "already sent this UTC day",
      });
      continue;
    }

    const reserved = ledger.reserve({
      universe_id: job.universeId,
      slot_key: slotKey,
      user_id: userId,
      slot_unix: nowUnix,
      push_at: nowUnix,
      created_unix: nowUnix,
    });

    if (reserved.status === "sent" || reserved.status === "failed") {
      skipN += 1;
      results.push({
        userId,
        httpStatus: reserved.http_status,
        outcome: "skipped",
        error: `ledger ${reserved.status}`,
      });
      continue;
    }

    const result = await send({
      userId,
      universeId: job.universeId,
      apiKey: cfg.apiKey.sandbox,
      messageId: cfg.messageId.sandbox,
      slotKey,
    });

    if (isSuccess(result.status)) {
      ledger.markSent({
        universeId: job.universeId,
        slotKey,
        userId,
        httpStatus: result.status,
        sentUnix: Math.floor(Date.now() / 1000),
        utcDate,
      });
      sentN += 1;
      results.push({ userId, httpStatus: result.status, outcome: "sent" });
    } else if (isNonRetryable(result.status)) {
      ledger.markFailed({
        universeId: job.universeId,
        slotKey,
        userId,
        httpStatus: result.status,
        error: result.body.slice(0, 300),
      });
      failN += 1;
      results.push({
        userId,
        httpStatus: result.status,
        outcome: "failed",
        error: result.body.slice(0, 300),
      });
    } else {
      skipN += 1;
      results.push({
        userId,
        httpStatus: result.status,
        outcome: "retry",
        error: result.body.slice(0, 300) || "retryable; try again",
      });
    }
  }

  recordTick({
    universeId: job.universeId,
    job: name,
    tickUnix: nowUnix,
    slotKey,
    slotUnix: nowUnix,
    pushAt: nowUnix,
    audienceN: allowlist.length,
    sentN,
    failN,
    skipN,
    dryRun: false,
    note: "manual sandbox send (bypass window)",
  });

  return {
    ok: sentN > 0 && failN === 0,
    utcDate,
    slotKey,
    universeId: job.universeId,
    audienceN: allowlist.length,
    results,
  };
}
