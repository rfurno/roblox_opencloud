# Gachamon OpenCloud Controller — Operations

**Status:** Draft, 2026-09-15. **v1 runbook is local** (`npm start`). Fly section is later. Numbers match [ARCHITECTURE.md](ARCHITECTURE.md). MOMENT lead is **10 min** (`pushLeadSeconds` 600; OC-19). **OC-15 shipped** (list `CollectorNotify`, 14-day recency). TCG alumni store **published** sandbox + live.

```bash
cp .env.example .env    # DRY_RUN=true
npm install
npm test
caffeinate -i npm start # macOS: stay awake
```

Dashboard: `http://127.0.0.1:3848`. Bind is loopback. **One `npm start`.** A second copy exits `listen EADDRINUSE 127.0.0.1:3848` — `lsof -nP -iTCP:3848 -sTCP:LISTEN` then kill that PID (and its `npm start` parent). Tabs: **Collector** | **Snapshots**. Collector cards: **Will notify N · CollectorNotify / EverOwnedLot M · older than 14 days K**. **Tick now** is MOMENT dry-run only. **Take snapshot now** POSTs Open Cloud (one per UTC day).

**If this process is not running at `pushAt`, that is a missed MOMENT.** If it is down for a whole UTC day, that is a missed Live snapshot. Do not close the lid through a send window. First `source=datastore` Live send: next **16:00 UTC** notify (`pushAt` ~15:50). Sandbox later hours the same UTC day are silent if 04:00 already spent the 1/day cap.

---

## Environments

| Job | Universe | Place | Visit hours UTC | Notify hours (send) | Notify key | Snapshot key | Message id env | Allowlist | Sqlite |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sandbox | `7034342160` | `117194948580255` | 4, 10, 16, 22 | same, or subset for a test day | `ROBLOX_API_KEY_SANDBOX` | `ROBLOX_API_KEY_SANDBOX_SNAPSHOT` (optional) | `MESSAGE_ID_SANDBOX` | `config/allowlist.sandbox.json` | `./data/sandbox.sqlite` |
| live | `6674250544` | `98219898516303` | 16, 4 | **16 only** | `ROBLOX_API_KEY_LIVE` | `ROBLOX_API_KEY_LIVE_SNAPSHOT` | `MESSAGE_ID_LIVE` | `config/allowlist.live.json` | `./data/live.sqlite` |

Never paste a Live key into a Sandbox curl, or the reverse. Never put the snapshot key in `ROBLOX_API_KEY_LIVE` (wrong scope).

`LIVE_SENDS_ENABLED` defaults **false**. Live `notifyHoursLocal: [16]` so the 1/day cap is not spent on 04:00 UTC (01:00 Brazil). TCG still spawns at 04.

Sandbox 1/day cap: arm `DRY_RUN=false` only for a user who has **not** received a MOMENT this UTC day, **shortly before the target hour**. If the machine was live at 04:00, 10/16/22 are silent that UTC day.

Live and Sandbox **share the 16:00 UTC send window** (same `slotKey` → same jitter). v1 runs sandbox then live sequentially.

---

## Env vars

| Name | Required | Notes |
| --- | --- | --- |
| `ROBLOX_API_KEY_SANDBOX` | for Sandbox HTTP | Universe-scoped user-notifications key |
| `ROBLOX_API_KEY_LIVE` | for Live HTTP | Separate notifications key |
| `ROBLOX_API_KEY_LIVE_SNAPSHOT` | for daily Live DataStore snapshot | `universe-datastores.control:snapshot` on Live `6674250544` only. **Not** the notifications key |
| `ROBLOX_API_KEY_SANDBOX_SNAPSHOT` | no | Optional same scope on Sandbox `7034342160` |
| `ROBLOX_API_KEY_LIVE_DATASTORE` | OC-15 | `universe-datastores.objects:list` + `:read` on Live `CollectorNotify`. **Not** the notify or snapshot key |
| `ROBLOX_API_KEY_SANDBOX_DATASTORE` | no | Optional same on Sandbox |
| `MESSAGE_ID_SANDBOX` | for Sandbox HTTP | Creator Dashboard notification string asset id |
| `MESSAGE_ID_LIVE` | for Live HTTP | Separate string |
| `LIVE_SENDS_ENABLED` | no | `false` unless explicitly enabling Live |
| `DRY_RUN` | no | `true` locally. MOMENT log-only: **no** `sends` / `moment_days` writes. Does **not** skip DataStore snapshots |
| `PORT` | no | dashboard port, default `3848` |
| `OPEN_BROWSER` | no | `true` to `open` the dashboard |
| `DATA_DIR` | no | default `/data` on Fly, `./data` locally |
| `LOG_USER_RESULTS` | no | `1` to log per-user `httpStatus` (still no keys) |
| `TZ` | yes on host | **must be `UTC`** |

`.env.example` (intended, placeholders only):

```
TZ=UTC
DRY_RUN=true
LIVE_SENDS_ENABLED=false
DATA_DIR=./data
ROBLOX_API_KEY_SANDBOX=rbx_placeholder_sandbox
ROBLOX_API_KEY_LIVE=rbx_placeholder_live
ROBLOX_API_KEY_LIVE_SNAPSHOT=rbx_placeholder_live_snapshot
ROBLOX_API_KEY_SANDBOX_SNAPSHOT=
ROBLOX_API_KEY_LIVE_DATASTORE=
ROBLOX_API_KEY_SANDBOX_DATASTORE=
MESSAGE_ID_SANDBOX=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
MESSAGE_ID_LIVE=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

---

## DataStore snapshots (Live)

Roblox keeps **hourly** versions of keys, but successive writes in the same UTC hour overwrite that hour’s backup. A **snapshot** pins every key in the universe so the next write creates a versioned backup regardless of the hour. Data current at snapshot time is kept ~**30 days**. This is a versioning pin, not a downloadable dump.

**Create (daily) needs only** `universe-datastores.control:snapshot` on Live. That is enough. Do **not** put this key in `ROBLOX_API_KEY_LIVE` (that env is notifications).

Not required for the daily create:

| Item | Why |
| --- | --- |
| `universe-datastores.objects:read` / `versions:list` | Restore / inspect a key as of `latestSnapshotTime`. Add later if you want a rollback tool |
| Sandbox snapshot key | Optional. Live is the player-data universe |
| `DRY_RUN=false` / `LIVE_SENDS_ENABLED` | Snapshots are independent of MOMENT sends |
| IP allowlist on the key | Same rule as notifications — do not lock to a laptop IP |

**Routine:** `npm start` with `ROBLOX_API_KEY_LIVE_SNAPSHOT` set. After each 30s Collector tick (`npm run tick --once` does the same after its MOMENT pass), if this UTC day has no Live row in `./data/live.sqlite` (`snapshots` table), POST

```
POST https://apis.roblox.com/cloud/v2/universes/6674250544/data-stores:snapshot
Header: x-api-key: $ROBLOX_API_KEY_LIVE_SNAPSHOT
Body: {}
```

Expect `{ "newSnapshotTaken": true, "latestSnapshotTime": "…Z" }`. A second call the same UTC day is a no-op (`newSnapshotTaken: false`) and we skip HTTP once the ledger has the day. 429/5xx: leave unrecorded, next tick retries. Scheduled POST waits if a Collector notify window is open (do not steal the 60s MOMENT window).

Also take a snapshot **manually** from the dashboard **Snapshots** tab (or the same POST) before publishing a TCG update that changes data-store schema.

Dashboard: `http://127.0.0.1:3848` → **Snapshots**. History is this machine’s ledger; Roblox has no list-snapshots API.

Restore (later, different key): `GetVersionAtTime` / Open Cloud `entries/{key}@latest:{latestSnapshotTime}`. Not implemented here.

Do not commit real keys or real message ids. **Do not put `ROBLOX_API_KEY_*` in GitHub Actions secrets.** Dry-run does not need keys. Local curl and Fly secrets only.

**IP allowlist:** do **not** restrict the Roblox API key to a laptop IP. Fly shared egress IPs are not stable; the key will 403 from the Machine. Only IP-restrict if a Fly **dedicated** egress IPv4 is documented and pinned.

---

## Creator Dashboard (once per universe)

1. Open the experience (Sandbox first):  
   Sandbox universe `7034342160` · Live `6674250544`.
2. Enable experience notifications.
3. Create a **notification string** (no Open Cloud API for this):
   - Title: `The Collector`
   - Body: `The Collector is on the way to your shop. Be there in about 10 minutes.`
4. Copy the string **asset id** into `MESSAGE_ID_SANDBOX` or `MESSAGE_ID_LIVE`.
5. Create an API key with permission to send user notifications **for that universe only**. Store in local `.env` as `ROBLOX_API_KEY_SANDBOX` / `ROBLOX_API_KEY_LIVE`. Do not IP-allowlist unless this machine has a stable egress IP.
5b. **Live snapshot (OC-18):** separate API key, Live universe `6674250544` only, operation **`universe-datastores.control:snapshot`**. Store as `ROBLOX_API_KEY_LIVE_SNAPSHOT`. Optional Sandbox twin. Do not IP-allowlist.
5c. **Lot-alumni list (OC-15):** separate API key, `universe-datastores.objects:list` + `:read` on that universe’s `CollectorNotify` store only. Store as `ROBLOX_API_KEY_LIVE_DATASTORE` (optional `ROBLOX_API_KEY_SANDBOX_DATASTORE`). Never reuse the notifications or snapshot key. Restart `npm start`. The controller lists `CollectorNotify` on a 15 min cache (not during the 60s window) and the dashboard shows who will be notified. Missing store → allowlist. Empty 14-day alumni set → no HTTP.
6. **Visit count (OC-13 blocker):** Creator Hub → the experience → Analytics / the public experience page. Confirm **≥100 visits**. If Sandbox is under 100, OC-13 is **blocked** — MOMENT sends will fail eligibility. Play-test Sandbox until the counter clears 100; do not assume the worker is broken.
7. Recipients must be 13+ and have the experience **Notify** bell on. What's New `PromptOptIn` expires **2026-10-10**; durable prompt is after FTUE (TCG-OC-03b, **published**). Operators can still opt in from the experience page.

**Dashboard:** Collector tab → Sandbox **Send notification now**. Bypasses `DRY_RUN` and the send-lead window. Live has no such button. Snapshots tab → **Take snapshot now** (real HTTP; 1/UTC day). Restart `npm start` after `.env` changes. MOMENT writes `moment_days` (Roblox 1/day cap), so a later scheduled send that UTC day is skipped.

Manual curl (off-clock Stage-2 probe; burns that user’s UTC-day cap):

```bash
curl -sS -X POST "https://apis.roblox.com/cloud/v2/users/${USER_ID}/notifications" \
  -H "x-api-key: ${ROBLOX_API_KEY_SANDBOX}" \
  -H "Content-Type: application/json" \
  -d '{
    "source": { "universe": "universes/7034342160" },
    "payload": { "message_id": "'"${MESSAGE_ID_SANDBOX}"'", "type": "MOMENT" },
    "join_experience": { "launch_data": "collector:manual-test" },
    "analytics_data": { "category": "collector_incoming" }
  }'
```

Expect 2xx `{ "path": "users/.../notifications/...", "id": "..." }`. 403 = opted out / ineligible / under-13 / experience under 100 visits.

---

## Fly bootstrap (later; not v1)

Skip until we do not want a laptop up at `pushAt`. Always-on worker. **No HTTP service.** Volume exclusive-mount (second replica fails closed).

```bash
# 1. App + volume (iad = fly.toml primary_region)
fly apps create gachamon-opencloud
fly volumes create opencloud_data --region iad --size 1 --app gachamon-opencloud

# 2. Secrets (no GitHub). Keep DRY_RUN=true until OC-13 gates pass.
fly secrets set TZ=UTC DRY_RUN=true LIVE_SENDS_ENABLED=false --app gachamon-opencloud
fly secrets set ROBLOX_API_KEY_SANDBOX=... MESSAGE_ID_SANDBOX=... --app gachamon-opencloud
# Live notify + snapshot keys when those jobs are armed
# fly secrets set ROBLOX_API_KEY_LIVE_SNAPSHOT=... --app gachamon-opencloud

# 3. Deploy image (Dockerfile CMD = node dist/index.js)
fly deploy --app gachamon-opencloud

# 4. Always-on invariant
fly status --app gachamon-opencloud
# Must show started. Stopped/suspended = P0 miss.
```

`fly.toml` must **not** contain `[http_service]` or `[[services]]`. Do not invent a `[machine]` table (`auto_stop_machines` exists only under `[http_service]`). `fly launch` adds HTTP+autostop by default — delete them. `[[restart]] policy = "always"`. No `[processes]` worker group (image CMD is the default process).

Dockerfile must compile `better-sqlite3`:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends sqlite3 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production TZ=UTC
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/config ./config
COPY --from=build /app/migrations ./migrations
CMD ["node", "dist/index.js"]
```

A slim image **without** `python3/make/g++` in the **build** stage will fail on `better-sqlite3`. Runtime **must** install the `sqlite3` CLI (Debian slim does not ship it) so the `fly ssh` queries below work.

### Deploy freeze

Volume attach is exclusive: `fly deploy` = downtime. **Do not deploy in the 15 minutes around `pushAt`.** Next Live notify window is ~15:50 UTC (`16:00` minus 10 min ± jitter). Next Sandbox windows: each notify hour minus ~10 min.

Rollback: `fly secrets set DRY_RUN=true` or `fly machine stop`. Does **not** change TCG spawn. Missed window ⇒ skip; no catch-up.

### sqlite on the volume

```bash
fly ssh console --app gachamon-opencloud -C "sqlite3 /data/sandbox.sqlite \"SELECT slot_key, user_id, status, http_status, datetime(sent_unix, 'unixepoch') FROM sends ORDER BY created_unix DESC LIMIT 20;\""

fly ssh console --app gachamon-opencloud -C "sqlite3 /data/sandbox.sqlite \"SELECT * FROM moment_days;\""

fly ssh console --app gachamon-opencloud -C "sqlite3 /data/live.sqlite \"SELECT utc_date, new_snapshot_taken, latest_snapshot_time, source, datetime(taken_unix, 'unixepoch') FROM snapshots ORDER BY utc_date DESC LIMIT 20;\""
```

Backup: Fly volume snapshot before migrations. Optional `sqlite3 /data/sandbox.sqlite '.backup /data/sandbox.bak'`.

---

## Cron / host (not production)

- GitHub Actions `on.schedule`: UTC is real; **shortest interval is 5 minutes** (`* * * * *` is coerced). Jobs delay under load. A 60s send window is unhittable. Use Actions for `npm test` only. **No production API keys** in that workflow. `workflow_dispatch` must not be able to set `DRY_RUN=false`.
- Vercel Cron: no process clock.

Local (after PR-1):

```bash
npm test
npm run tick -- --universe sandbox --dry-run
```

---

## Slot math (operator cheat)

Send at `slotUnix − pushLead` only if the **`hoursLocal` hour that built the slot** is in `notifyHoursLocal` (same IANA zone; subset of `hoursLocal`). `pushLead` = **600**. Under `Etc/UTC` that hour equals the UTC hour in `slotKey`. Under `America/Sao_Paulo` Live is `hoursLocal: [13, 1]`, **`notifyHoursLocal: [13]`** (not `[16]`). Window **60s**.

Worked example **`2026-09-10T16`** (Luau-verified copy of `hash32` with `span = 600`):

| Field | Value |
| --- | --- |
| key | `2026-09-10T16` |
| hash32 | `1396388120` |
| jitter | **+433 s** |
| nominal | `1789056000` = 16:00:00Z |
| slotUnix | `1789056433` = **16:07:13Z** |
| pushAt | `1789055833` = **15:57:13Z** |
| window | 15:57:13Z–15:58:13Z |
| toast (game) | 16:05:13Z |
| catch end (game) | 16:17:13Z |

If the controller prints jitter **237** for this key, it used uint32 FNV (`Math.imul` / the TCG spec’s “mod 2^32” sentence). **That is a P0 bug.** Stop sends.

---

## Verify a slot against TCG logs

Controller and game must agree before any Live send.

### 1. Print jitter from TCG (Sandbox Studio **Edit** is enough)

`hash32` / `jitterFor` are **`local`** in `SpecialNpcDirector.server.lua`. In Studio **Play**, `jitterSeconds()` returns `StudioJitterSeconds` (**20**), not 600. **Do not invoke in-game `jitterFor` in Studio Play**; you will not get 433.

Paste this snippet with **`span = 600`** into Studio command bar / MCP `execute_luau` (Edit), or read logs on a **published** Sandbox server:

```lua
local function hash32(s)
	local h = 2166136261
	for i = 1, #s do
		h = bit32.bxor(h, string.byte(s, i))
		h = (h * 16777619) % 4294967296
	end
	return h
end
local key = "2026-09-10T16"
local span = 600  -- published Live/Sandbox; NOT Studio Play's 20
local h = hash32(key)
local jitter = (h % (2 * span + 1)) - span
return { key = key, hash32 = h, jitter = jitter }
```

Expect `hash32 = 1396388120`, `jitter = 433`.

Studio Play uses `studio:<index>` keys — **ignore those**; this service never sends them.

### 2. Print the same key from the controller (after PR-1)

```bash
npm test -- tests/clock.test.ts
npm run tick -- --universe sandbox --dry-run
```

Log line must contain `slotKey` (or the next upcoming **notify** key), `slotUnix` matching TCG, `pushAt = slotUnix - 600`. Dry-run writes **no** ledger rows.

### 3. End-to-end Sandbox (OC-13)

**Do not start this until every gate is true:**

| Gate | How to check |
| --- | --- |
| Sandbox notification string + API key | Creator Dashboard; `fly secrets` has `MESSAGE_ID_SANDBOX` and `ROBLOX_API_KEY_SANDBOX` |
| Sandbox **≥100 visits** | Creator Hub Analytics / experience page. If under 100, **stop** — OC-13 blocked |
| Allowlisted user 13+ and Notify-bell on | Experience page bell; userId in `config/allowlist.sandbox.json` |
| Clock golden still 433 | `npm test` (after PR-1) or Studio snippet above |
| No MOMENT yet this UTC day for that user | `moment_days` empty / first send of the day |
| Target hour chosen | Set `notifyHoursLocal` to **that one hour**, or arm sends only in the ~15 min before its `pushAt` |
| `DRY_RUN=false` armed only for that window | `fly secrets set DRY_RUN=false` shortly before `pushAt`; set `true` after |
| Worker after PR-4 | `fly status` is **started** |

Then:

1. Wait for that hour’s send window (hour UTC minus ~10 min, ±10 min jitter). Do **not** “wait for the next Sandbox hour” if an earlier hour already sent today.
2. Notification Center should show “The Collector…” ~10 minutes before TCG spawn.
3. Join before `slotUnix` with a claimed lot → Collector still spawns from the **game**.
4. Ignore a later slot and join after `slotUnix + 600` → **no** spawn (game).
5. Re-run / second replica → unique key, no second MOMENT (`pending` retry does not double 2xx).
6. Confirm logs `source.universe` is `universes/7034342160` only.

PR-5 only **commits** team userIds. Flipping `DRY_RUN=false` is this ops step, not a git flag.

---

## Incident playbook

| Symptom | Likely cause | Action |
| --- | --- | --- |
| No notification, logs skip / no slot in window | Normal most of the day | Confirm `pushAt` in the next tick logs |
| No notification, allowlist non-empty, during window | Machine down, `DRY_RUN`, `http_service` autostop, wrong TZ | `fly status` — stopped = **P0**. Confirm `TZ=UTC`. Do **not** send late |
| 400s | Bad `message_id` / payload | Stop. Fix env. `failed` is not retried |
| 403s | Opted out, under-13, ineligible, **<100 visits** | Check visit count and Notify bell. Remove id if permanent |
| 404s | Bad userId | Fix allowlist |
| 429s | Rate limit | Leave `pending`; **no in-tick backoff**. Next `await tick()` (30s) POSTs again if still in window |
| Duplicate MOMENT | Ledger not unique / two DBs | Inspect sqlite via `fly ssh`. Stop second replica (volume should fail closed) |
| Notify at wrong time vs TCG | `Math.imul` / spec “mod 2^32” or host TZ | Golden `2026-09-10T16` must be **433**. Revert deploy |
| 04:00 UTC ping / 16:00 silent on Live | `notifyHoursLocal` includes 4 (or Brazil `[1]`) | Live `Etc/UTC` notify `[16]` only; Sao Paulo notify `[13]` |
| Zero Live MOMENTs after switching zone to Sao Paulo | `notifyHoursLocal` still `[16]` while `hoursLocal` is `[13, 1]` | Set `notifyHoursLocal: [13]` (same zone as `hoursLocal`) |
| Sandbox 10/16/22 silent | 04:00 already spent 1/day cap | Expected. Arm `DRY_RUN=false` only before the target hour |
| Sandbox users get Live universe | Job mixup | Stop immediately. Rotate **both** keys |
| Live blast scare | `LIVE_SENDS_ENABLED` + non-empty list | `LIVE_SENDS_ENABLED=false` / `DRY_RUN=true`. Roblox 1/day limits damage |
| Key 403 from Fly, works on laptop | Roblox key IP-allowlisted | Remove IP allowlist or pin dedicated egress |
| Snapshots tab: Live snapshot key missing | `ROBLOX_API_KEY_LIVE_SNAPSHOT` unset / placeholder | Put the `universe-datastores.control:snapshot` key in `.env`, restart |
| Snapshot 403 | Notifications key used, or wrong universe | Separate snapshot env var; Live universe `6674250544` only |
| No snapshot row for yesterday UTC | Process down all day, or 429 never recovered | Laptop must be up some time that UTC day; 429 retries next tick |
| Snapshot during 16:00 notify window | Scheduled job waits on purpose | Expected; next tick after the 60s window POSTs |
| `listen EADDRINUSE … 3848` | Second `npm start` / leftover `tsx src/index.ts` | One process. `lsof -nP -iTCP:3848 -sTCP:LISTEN` and kill it, then start once |
| Dashboard “Will notify 0” with rows in Creator Hub | List `id` not parsed / recency drop | Open Cloud id is `global/<userId>`. Confirm tick `source=datastore` `storeListedN` / `recencyDroppedN` |
| `audienceN: 0` + `no slot in send window` | Normal most of the day | Not a failed list. Watch `audience refreshed` logs and the Collector card count |

Missed window ⇒ **skip**. There is no catch-up send. Next chance is the next **notify** slot (and only if that user has not already used the UTC-day cap).

---

## Contacts / repos

| Thing | Where |
| --- | --- |
| This service | https://github.com/rfurno/roblox_opencloud.git |
| TCG | https://github.com/rfurno/roblox_gacha (private) |
| Live game | https://www.roblox.com/games/98219898516303/Gachamon-TCG |
| Open Cloud notify docs | https://create.roblox.com/docs/cloud/guides/experience-notifications |
| Open Cloud snapshot | https://create.roblox.com/docs/cloud/reference/DataStore#Cloud_SnapshotDataStores |
