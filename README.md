# Gachamon OpenCloud Controller

External Open Cloud controller for [Gachamon TCG](https://www.roblox.com/games/98219898516303/Gachamon-TCG). It sends Roblox **experience notifications** (`MOMENT`) so shop owners who are **offline** still hear that The Collector is coming, and it takes a **daily Live DataStore snapshot** so player data has a 30-day versioning pin.

**v1 host:** this laptop. `npm start` runs a 30s scheduler and opens a local dashboard at `http://127.0.0.1:3848`. Fly is later.

The TCG game only toasts players already in a running server (T−2 min). Arrival is a predetermined UTC slot with deterministic jitter; missed slots do not catch up. This process must stay running (laptop awake) through the 60s send window.

- Game repo (private): [rfurno/roblox_gacha](https://github.com/rfurno/roblox_gacha)
- Spec: `roblox_gacha/docs/COLLECTOR_OPEN_CLOUD_NOTIFICATIONS.md`

**Status (2026-09-13):** Local scheduler + dashboard (Collector + Snapshots tabs). MOMENT dry-run by default. Do not send Live notifications. Daily Live snapshot is independent of `DRY_RUN` (needs `ROBLOX_API_KEY_LIVE_SNAPSHOT`). Planned: 10 min lead (OC-19) and 14-day lot-alumni DataStore audience (OC-15; blocked on TCG).

## Run locally

```bash
cp .env.example .env   # keep DRY_RUN=true
npm install
npm test
npm start              # scheduler + http://127.0.0.1:3848
```

Keep the machine awake (`caffeinate -i npm start` on macOS). The dashboard binds **127.0.0.1** only. Tabs: **Collector** | **Snapshots**. **Tick now** is always dry-run (no MOMENT HTTP, no send ledger). Snapshots still run on the 30s tick when the snapshot key is set.

One-shot (no browser):

```bash
npm run tick -- --universe sandbox --dry-run
```

Secrets stay in `.env` (gitignored). MOMENT dry-run does not need notification keys. Daily snapshots need `ROBLOX_API_KEY_LIVE_SNAPSHOT` (not the notifications key).

## What this is / is not

| This service does | This service does not |
| --- | --- |
| Recompute TCG Collector `slotKey` / `slotUnix` | Spawn NPCs or write TCG ProfileStore |
| POST Open Cloud MOMENT at `slotUnix − 480s` (OC-19: −600s) for **notify hours** | Send in-game `COLLECTOR_INCOMING` toasts |
| Allowlist (Sandbox first); later 14-day lot alumni (OC-15); Live notify hour **16** only | Blast all Live CCU / Notify-bell; spend the 1/day cap on 04:00 UTC |
| Persist an idempotent send ledger under `./data` | Use MessagingService as offline notify |
| POST one Live DataStore snapshot per UTC day | Download a dump, list Roblox snapshots, or restore keys |
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
| Open Cloud MOMENT | `slotUnix − 480s` (8 min, v1), window 60s, notify hours only. **OC-19:** −600s (10 min) |
| Live DataStore snapshot | First 30s tick of the UTC day with a snapshot key set; skips Collector send windows; 1/UTC day |
| In-game toast | `slotUnix − 120s` — **game only** |
| Collector spawn | `slotUnix` — **game only** |

Worked example `2026-09-10T16`: jitter **+433s**, spawn **16:07:13Z**, send **15:59:13Z** (v1). OC-19 send **15:57:13Z**.

## Docs

| Doc | File |
| --- | --- |
| Product | [docs/PRODUCT.md](docs/PRODUCT.md) |
| Architecture | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Backlog | [docs/BACKLOG.md](docs/BACKLOG.md) |
| Runbook | [docs/OPERATIONS.md](docs/OPERATIONS.md) |
