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
