import { loadConfig, type UniverseName } from "./config.ts";
import { startLocal } from "./server.ts";
import { tickSnapshots } from "./snapshot.ts";
import { tick } from "./worker.ts";

function parseArgs(argv: string[]) {
  const once = argv.includes("--once");
  const dryRun = argv.includes("--dry-run") ? true : argv.includes("--send") ? false : undefined;
  const idx = argv.indexOf("--universe");
  let universes: UniverseName[] | undefined;
  if (idx >= 0 && argv[idx + 1]) {
    const v = argv[idx + 1];
    if (v === "sandbox" || v === "live") universes = [v];
    else if (v !== "all") {
      console.error(" --universe must be sandbox | live | all");
      process.exit(2);
    }
  }
  return { once, dryRun, universes };
}

const cfg = loadConfig();
const args = parseArgs(process.argv.slice(2));

if (args.once) {
  await tick(cfg, { dryRun: args.dryRun, universes: args.universes });
  await tickSnapshots(cfg, { universes: args.universes });
} else {
  startLocal(cfg);
}
