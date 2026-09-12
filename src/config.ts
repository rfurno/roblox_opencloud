import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type UniverseName = "sandbox" | "live";

export type UniverseSchedule = {
  universeId: string;
  placeId: string;
  hoursLocal: number[];
  notifyHoursLocal: number[];
  allowlistPath: string;
};

export type ScheduleFile = {
  scheduleTimeZone: string;
  jitterSeconds: number;
  pushLeadSeconds: number;
  sendWindowSeconds: number;
  tickIntervalSeconds: number;
  sandbox: UniverseSchedule;
  live: UniverseSchedule;
};

export type AppConfig = {
  schedule: ScheduleFile;
  dryRun: boolean;
  liveSendsEnabled: boolean;
  dataDir: string;
  port: number;
  openBrowser: boolean;
  logUserResults: boolean;
  apiKey: Record<UniverseName, string>;
  snapshotApiKey: Record<UniverseName, string>;
  messageId: Record<UniverseName, string>;
};

const ROOT = process.cwd();

export function loadDotenv(path = resolve(ROOT, ".env")): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return defaultValue;
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
}

export function loadSchedule(path = resolve(ROOT, "config/schedule.json")): ScheduleFile {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ScheduleFile;
  if (!parsed.sandbox?.universeId || !parsed.live?.universeId) {
    throw new Error("schedule.json missing sandbox/live universeId");
  }
  for (const job of [parsed.sandbox, parsed.live]) {
    for (const hour of job.notifyHoursLocal) {
      if (!job.hoursLocal.includes(hour)) {
        throw new Error(
          `notifyHoursLocal ${hour} is not a subset of hoursLocal [${job.hoursLocal.join(", ")}]`,
        );
      }
    }
  }
  return parsed;
}

export function loadConfig(): AppConfig {
  loadDotenv();
  const schedule = loadSchedule();
  return {
    schedule,
    dryRun: envFlag("DRY_RUN", true),
    liveSendsEnabled: envFlag("LIVE_SENDS_ENABLED", false),
    dataDir: process.env.DATA_DIR || "./data",
    port: Number(process.env.PORT || 3848),
    openBrowser: envFlag("OPEN_BROWSER", true),
    logUserResults: process.env.LOG_USER_RESULTS === "1",
    apiKey: {
      sandbox: process.env.ROBLOX_API_KEY_SANDBOX || "",
      live: process.env.ROBLOX_API_KEY_LIVE || "",
    },
    snapshotApiKey: {
      sandbox: process.env.ROBLOX_API_KEY_SANDBOX_SNAPSHOT || "",
      live: process.env.ROBLOX_API_KEY_LIVE_SNAPSHOT || "",
    },
    messageId: {
      sandbox: process.env.MESSAGE_ID_SANDBOX || "",
      live: process.env.MESSAGE_ID_LIVE || "",
    },
  };
}

export function universeNames(): UniverseName[] {
  return ["sandbox", "live"];
}

export function jobOf(schedule: ScheduleFile, name: UniverseName): UniverseSchedule {
  return name === "sandbox" ? schedule.sandbox : schedule.live;
}

export function apiKeyConfigured(value: string): boolean {
  return Boolean(value) && !value.includes("placeholder");
}

export function messageIdConfigured(value: string): boolean {
  return Boolean(value) && !value.includes("xxxxxxxx");
}
