# roblox_opencloud

External **Open Cloud controller** for [Gachamon TCG](https://www.roblox.com/games/98219898516303/Gachamon-TCG). It sends Roblox **experience notifications** (`MOMENT`) so shop owners who are **offline** still hear that The Collector is coming.

**v1 host:** this laptop. `npm start` runs a 30s scheduler and opens a local dashboard at `http://127.0.0.1:3848`. Fly is later.

The TCG game only toasts players already in a running server (T−2 min). Arrival is a predetermined UTC slot with deterministic jitter; missed slots do not catch up. This process must stay running (laptop awake) through the 60s send window.

- Game repo (private): [rfurno/roblox_gacha](https://github.com/rfurno/roblox_gacha)
- Spec: `roblox_gacha/docs/COLLECTOR_OPEN_CLOUD_NOTIFICATIONS.md`

**Status (2026-09-10):** Local scheduler + dashboard. Dry-run by default. Do not send Live notifications.

## Run locally

```bash
cp .env.example .env   # keep DRY_RUN=true
npm install
npm test
npm start              # scheduler + http://127.0.0.1:3848
```

Keep the machine awake (`caffeinate -i npm start` on macOS). The dashboard binds **127.0.0.1** only. The **Tick now** button is always dry-run (no HTTP, no ledger). The **Snapshots** tab shows Live DataStore snapshot history (one per UTC day; needs `ROBLOX_API_KEY_LIVE_SNAPSHOT`).

One-shot (no browser):

```bash
npm run tick -- --universe sandbox --dry-run
```

Secrets stay in `.env` (gitignored). Dry-run does not need API keys.

## What this is / is not

| This service does | This service does not |
| --- | --- |
| Recompute TCG Collector `slotKey` / `slotUnix` | Spawn NPCs or write TCG ProfileStore |
| POST Open Cloud MOMENT at `slotUnix − 480s` for **notify hours** | Send in-game `COLLECTOR_INCOMING` toasts |
| Allowlist (Sandbox first); Live notify hour **16** only | Blast all Live players; spend the 1/day cap on 04:00 UTC |
| Persist an idempotent send ledger under `./data` | Use MessagingService as offline notify |
| Run when CCU is 0, if this process is up | Notify Studio Play `studio:<index>` slots |

## Places

| Environment | Universe ID | Place ID | Visit hours UTC | Notify hours |
| --- | --- | --- | --- | --- |
| Live | `6674250544` | `98219898516303` | 16, 4 | **16 only** |
| Sandbox | `7034342160` | `117194948580255` | 4, 10, 16, 22 | all, or subset for a test day |
| Studio Play | n/a | n/a | Do not send | Do not send |

## Timing

| Event | When |
| --- | --- |
| Open Cloud MOMENT | `slotUnix − 480s` (8 min), window 60s, notify hours only |
| In-game toast | `slotUnix − 120s` — **game only** |
| Collector spawn | `slotUnix` — **game only** |

Worked example `2026-09-10T16`: jitter **+433s**, spawn **16:07:13Z**, send **15:59:13Z**.

## Docs

| Doc | File |
| --- | --- |
| Product | [docs/PRODUCT.md](docs/PRODUCT.md) |
| Architecture | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Backlog | [docs/BACKLOG.md](docs/BACKLOG.md) |
| Runbook | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
