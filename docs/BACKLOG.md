# roblox_opencloud — Backlog

**Status (2026-09-10):** Local scheduler + dashboard in tree. HTTP dry-run by default. Spec: `roblox_gacha/docs/COLLECTOR_OPEN_CLOUD_NOTIFICATIONS.md`.

Priority: **P0** clock/safety, **P1** Sandbox send, **P2** Live / audience / polish.

IDs in this repo: `OC-*`. TCG follow-ups (other repo): `TCG-OC-*` with status **blocked-external**.

---

## Now (this repo)

| ID | P | Item | Acceptance |
| --- | --- | --- | --- |
| OC-00 | P0 | Docs | README + PRODUCT + ARCHITECTURE + BACKLOG + OPERATIONS. **Done** for local-first. |
| OC-01 | P0 | Clock module | Implement from Lua `SpecialNpcDirector.hash32` / golden table, **not** the TCG spec “mod 2^32” sentence. Golden: `2026-09-10T16` → hash `1396388120`, jitter **433**, `slotUnix` `1789056433`, `pushAt` `1789055953`. `Math.imul` path must fail. **Done.** |
| OC-02 | P0 | Host-TZ independence | Same `slotUnix` under `TZ=UTC`, `TZ=America/Los_Angeles`, `TZ=Europe/Lisbon`. DST dates `2026-03-08`, `2026-11-01`, `2026-03-29`, `2026-10-25` frozen. |
| OC-03 | P0 | No studio keys | `studio:<index>` never enters the send path. |
| OC-04 | P0 | SQLite ledger | `INSERT OR IGNORE` then `SELECT`. Unique conflict is not “already sent.” Pending + in window → POST again. Pending + window closed → no HTTP. 2xx → `UPDATE … WHERE status='pending'`. 400/403/404 → failed only if still pending (**2xx then 4xx must not overwrite `sent`**). 429/5xx/crash → leave pending; **no in-tick backoff**. **One `await tick()` at a time**; two overlapping ticks → one HTTP. No `tick_log` / no `sending` status. |
| OC-05 | P0 | One MOMENT / UTC day | `moment_days` skip even if a later slot’s window opens. Day is **UTC** (confirmed 2026-09-10). After a 04:00 send, 16:00 skipped. |
| OC-05b | P0 | Notify hours ≠ visit hours | `notifyHoursLocal` ⊆ `hoursLocal` in the **same** IANA zone; filter on the hour used to **build** the slot. Live `Etc/UTC` `[16]`. Brazil: `[13, 1]` + notify `[13]` → send only 16:00Z. 04:00 is computed but not sent. Sandbox: subset or arm one hour per test day. |
| OC-06 | P1 | Config + secrets | `config/schedule.yaml` committed (`hoursLocal` + `notifyHoursLocal`). `.env.example` placeholders. Keys never in git **or GitHub Actions**. `.gitignore` in PR-1. |
| OC-07 | P1 | Allowlist audience | `config/allowlist.sandbox.json`. Live file `[]`. Empty list ⇒ no HTTP. |
| OC-08 | P1 | Live gate | `LIVE_SENDS_ENABLED=false` default. Live job no-ops HTTP unless flag true **and** Live allowlist non-empty. |
| OC-09 | P1 | Open Cloud client | POST MOMENT; `source.universe` matches job; `launch_data=collector:<slotKey>`; `analytics_data.category=collector_incoming`. Sequential. Universe isolation test. Shared 16:00 window: sandbox first. |
| OC-10 | P1 | Dry-run worker | `npm run tick -- --dry-run` logs window + audience. **No HTTP, no `sends` / `moment_days` writes.** Dry-run then live tick still POSTs. No API keys required. Default locally. **Done.** |
| OC-10b | P1 | Local dashboard | `npm start` opens `http://127.0.0.1:3848`, 30s scheduler, Tick-now is dry-run, bind loopback only. Laptop must stay awake. **Done.** |
| OC-11 | P2 | Fly always-on | Later. Not required for Sandbox allowlist sends from this machine. |
| OC-12 | P1 | CI | GitHub Actions `npm test` only (PR-1). 5-minute schedule floor is why this is not the cron. **No** `ROBLOX_API_KEY_*` in GitHub. TZ matrix from OC-02. |
| OC-13 | P1 | First Sandbox allowlist send | **Gates (all required):** (1) TCG-OC-01 Sandbox dashboard string + API key in local `.env`; (2) Sandbox experience **≥100 visits**; (3) allowlisted user is 13+ and Notify-bell opted in; (4) clock golden still **433** for `2026-09-10T16`; (5) `DRY_RUN=false` armed **only** for that UTC day/hour for a user with no MOMENT that UTC day; (6) `npm start` running, laptop awake. Curl remains the Stage-2 off-clock probe. Re-run does not duplicate. |
| OC-14 | P2 | Gated Live allowlist | Tiny list + `LIVE_SENDS_ENABLED` (ops). Notify hour remains 16. Explicit operator approval. Same checks vs TCG Live logs. |
| OC-15 | P2 | DataStore audience | Read TCG store via Open Cloud when it exists. 14-day recency. Fallback to allowlist if missing. Time-budget sandbox or split processes (shared 16:00 window). **Blocked on TCG-OC-02.** |
| OC-16 | P2 | `{localTime}` parameter | Optional dashboard param from per-user IANA zone. Display only. Missing zone → relative sentence. |
| OC-17 | P2 | Tick metrics | Stdout JSON tick logs (no `tick_log` table). Alert on 400, unexpected skip, and stopped Machine. |

---

## Suggested PR order

Independently reviewable. Details also in the design doc PR Plan.

| PR | Title | Unlocks |
| --- | --- | --- |
| PR-0 | Docs | OC-00 |
| PR-1 | Clock + local scheduler + dashboard + tests | OC-01–OC-10b |
| PR-2 | First Sandbox allowlist ids; HTTP enable is **ops** (`DRY_RUN=false` in local `.env`) | OC-13 |
| PR-3 | Gated Live allowlist ids | OC-14 |
| PR-4 | Fly always-on (later) | OC-11 |
| PR-5 | DataStore audience | OC-15 (blocked-external) |

PR-2 commits team userIds + runbook. **`DRY_RUN=false` is an ops step** in local `.env`, not a code flag.

---

## TCG follow-ups (not this repo)

Not required to start Sandbox allowlist testing. Needed before Live blast. Implement in `rfurno/roblox_gacha`.

| ID | P | Item | Notes |
| --- | --- | --- | --- |
| TCG-OC-01 | P1 | Creator Dashboard | Enable experience notifications + create the notification string on **both** universes. Put asset ids in this controller’s **env**, not in TCG git. |
| TCG-OC-02 | P1 | Owner DataStore | Write eligible owners when a lot is claimed / released (`PropertyManager` claim path). Suggested name `CollectorNotify`, keys `userId` strings, value `{ lotId, updatedUnix }`. **Does not exist today.** Exact name TBD. |
| TCG-OC-03 | P1 | `PromptOptIn()` | `ExperienceNotificationService:PromptOptIn()` for 13+ shop owners so MOMENT can deliver. |
| TCG-OC-04 | P2 | `launch_data` analytics | Read `collector:<slotKey>` on join for analytics only. **Do not spawn from it.** |
| TCG-OC-05 | P2 | Next-slot UI | Surface next Collector time in the shop HUD (game clock, not this service). |
| TCG-OC-06 | P2 | Do **not** “fix” `hash32` to uint32 mul | Luau double multiply **is** the live clock (jitter 433 for `2026-09-10T16`). Changing it would move spawn times. If TCG ever changes hash, this controller follows. |
| TCG-OC-07 | P2 | Patch TCG spec §2 | `COLLECTOR_OPEN_CLOUD_NOTIFICATIONS.md` says “Multiplication is mod 2^32.” Replace with “IEEE-754 multiply, then `% 2^32` (not uint32 wrap)” so implementers do not ship jitter 237. |

---

## Explicitly out of scope until product says otherwise

- SMS / email / Discord
- MessagingService as offline notify
- Studio Play notifications
- Blasting all Live CCU
- Widening the 60s send window
- Changing TCG `slotUnix`
- A general-purpose Open Cloud SDK
