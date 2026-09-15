export type TickLog = {
  universeId: string;
  job: string;
  tickUnix: number;
  slotKey: string | null;
  slotUnix: number | null;
  pushAt: number | null;
  audienceN: number;
  sentN: number;
  failN: number;
  skipN: number;
  dryRun: boolean;
  storeListedN?: number;
  recencyDroppedN?: number;
  source?: "datastore" | "allowlist";
  note?: string;
};

const MAX = 80;
const ticks: TickLog[] = [];

export function recordTick(log: TickLog): void {
  ticks.push(log);
  if (ticks.length > MAX) ticks.shift();
  console.log(JSON.stringify(log));
}

export function recentTicks(): TickLog[] {
  return [...ticks].reverse();
}

export type SnapshotLog = {
  universeId: string;
  job: string;
  utcDate: string;
  tickUnix: number;
  newSnapshotTaken: boolean | null;
  latestSnapshotTime: string | null;
  httpStatus: number | null;
  source: string;
  note?: string;
};

const snapshotLogs: SnapshotLog[] = [];

export function recordSnapshotLog(log: SnapshotLog): void {
  snapshotLogs.push(log);
  if (snapshotLogs.length > MAX) snapshotLogs.shift();
  console.log(JSON.stringify({ event: "snapshot", ...log }));
}

export function recentSnapshotLogs(): SnapshotLog[] {
  return [...snapshotLogs].reverse();
}
