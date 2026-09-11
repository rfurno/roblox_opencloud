import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Allowlist = {
  userIds: number[];
};

export function loadAllowlist(path: string): number[] {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) return [];
  const parsed = JSON.parse(readFileSync(full, "utf8")) as Allowlist;
  const ids = Array.isArray(parsed.userIds) ? parsed.userIds : [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of ids) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
