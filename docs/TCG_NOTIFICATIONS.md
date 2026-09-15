# What `roblox_gacha` must implement for Collector notifications

**Audience:** TCG (`rfurno/roblox_gacha`). This is the game-side contract the Open Cloud controller (`roblox_opencloud`) needs.

**Status:** 2026-09-15. Controller already computes slots and can POST `MOMENT` to an allowlist. Live alumni blast is **blocked** on TCG-OC-08 + 02 + 03b. v1 send lead is **8 min**; both repos move to **10 min** together (Dashboard copy + controller `pushLeadSeconds` + TCG `PushLeadSeconds`). Reviewed against TCG `src/` — implement with the corrections in each ticket (monotonic `UpdateAsync`, no historical backfill).

**Controller spec (do not re-implement the sender here):** this repo’s [ARCHITECTURE.md](ARCHITECTURE.md) / [PRODUCT.md](PRODUCT.md) / [BACKLOG.md](BACKLOG.md). Game spec: `roblox_gacha/docs/COLLECTOR_OPEN_CLOUD_NOTIFICATIONS.md` (there is no `COLLECTOR_OPEN_CLOUD_NOTIFICATIONS.md` in this repo). Ticket IDs: `TCG-OC-*` (this list) and `OC-*` (controller).

---

## Split of responsibility

The game still owns spawn. The notification is a reminder, not a spawn trigger.

| Layer | Owner | Notes |
| --- | --- | --- |
| UTC slot + jitter + spawn + T−2 toast | TCG `SpecialNpcDirector` | Already shipped. Do **not** change `hash32` / jitter / toast / catch / `VisitHoursUtc`. |
| Offline `MOMENT` HTTP | `roblox_opencloud` | POST `https://apis.roblox.com/cloud/v2/users/{userId}/notifications`. Not SMS / email / Discord / MessagingService. |
| Notification string copy | Creator Dashboard (ops) | No Open Cloud API to create copy. Asset id goes in the controller `.env`, **not** TCG git. |
| Who to ping (v1) | Controller allowlist | Sandbox first. Does not need TCG code. |
| Who to ping (v2, Live alumni) | TCG `CollectorNotify` DataStore | **Does not exist today.** Blocks controller **OC-15**. |
| Opt-in (Notify bell) | TCG client `PromptOptIn` | What's New card expires **2026-10-10**. Need a durable prompt on first claim. |
| `launch_data` | Controller sends `collector:<slotKey>` | TCG currently **ignores** it. Spawn still uses the clock. |

Places:

| Env | Universe | Place | Visit hours UTC | Notify hours (controller) |
| --- | --- | --- | --- | --- |
| Live | `6674250544` | `98219898516303` | 16, 4 | **16 only** |
| Sandbox | `7034342160` | `117194948580255` | 4, 10, 16, 22 | all, or one hour per test day |
| Studio Play | n/a | n/a | Do not write `CollectorNotify`. Do not send MOMENT. | |

---

## Suggested order

Not required to start Sandbox **allowlist** testing (controller + Dashboard string + opted-in 13+ user is enough). Allowlist MOMENT does **not** need TCG-OC-02. Treat 08 + 02 + 03b as one Live-alumni feature.

| # | ID | P | Unblocks |
| --- | --- | --- | --- |
| 1 | [TCG-OC-01](#tcg-oc-01--creator-dashboard) | P1 | First Sandbox MOMENT (controller OC-13) |
| 2 | [TCG-OC-07](#tcg-oc-07--patch-spec-hash32-sentence) | P1 | Stop the next implementer shipping jitter 237 (doc-only) |
| 3 | [TCG-OC-09](#tcg-oc-09--push-lead-8--10-min) | P1 | Pair with controller OC-19 **and** Dashboard body. Do this **before** enabling 10 min HTTP. |
| 4 | [TCG-OC-08](#tcg-oc-08--profilestore-everownedlot) | P1 | Join re-touch after a post-ship claim |
| 5 | [TCG-OC-02](#tcg-oc-02--collectornotify-datastore) | P1 | Controller OC-15 audience |
| 6 | [TCG-OC-03b](#tcg-oc-03b--durable-promptoptin-on-first-claim) | P1 | Live alumni actually receive the MOMENT (else 403) |
| 7 | [TCG-OC-04](#tcg-oc-04--launch_data-analytics-optional) | P2 | Optional analytics |
| 8 | [TCG-OC-05](#tcg-oc-05--next-slot-hud-optional) | P2 | Optional shop HUD |

Already done, do not redo:

| ID | Status |
| --- | --- |
| **TCG-OC-03** What's New `2026-09-10-01` | Shipped live. `PROMPT_NOTIFICATION_OPT_IN` → `ExperienceNotificationService:PromptOptIn()` in `AnnouncementClient.client.lua`. Card **expires 2026-10-10**. Not enough for Live alumni. |
| **TCG-OC-06** Do not “fix” `hash32` | Constraint, not a feature. Luau IEEE-754 multiply **is** the live clock (jitter **433** for `2026-09-10T16`). |

---

## TCG-OC-01 — Creator Dashboard

Manual, once per universe. No Lua.

1. Enable **experience notifications** on Sandbox `7034342160`, then Live `6674250544`.
2. Create a **notification string** (there is no Open Cloud API for copy):

   | Field | Value |
   | --- | --- |
   | Title | `The Collector` |
   | Body (v1, 8 min) | `The Collector is on the way to your shop. Be there in about 8 minutes.` |
   | Body (with TCG-OC-09 / OC-19) | `The Collector is on the way to your shop. Be there in about 10 minutes.` |

   Relative time only. Do **not** put `16:07 UTC` or a server-local clock in the string.

3. Put the string **asset id** in the controller env (`MESSAGE_ID_SANDBOX` / `MESSAGE_ID_LIVE`). Never commit it to TCG git.
4. Sandbox experience must have **≥100 visits** or MOMENT HTTP 403s (eligibility). Play-test until the counter clears 100.
5. Recipients must be **13+** and have the experience **Notify** bell on.

For the 10 min lead: edit the existing string **or** create a new one and swap `message_id` in the controller **before** `pushLeadSeconds` becomes 600. Copy that says “8 minutes” with a 10 min send is a product bug.

---

## TCG-OC-09 — Push lead 8 → 10 min

**File:** `src/server/Config/NPCConfig.lua`

Today:

```lua
PushLeadSeconds = 8 * 60,
```

Change to:

```lua
PushLeadSeconds = 10 * 60,
```

Also update copy in `docs/COLLECTOR_OPEN_CLOUD_NOTIFICATIONS.md` (8 → 10) so the spec matches.

**Do not change** (controller follows TCG; desync = missed spawn or late ping):

| Keep | Value |
| --- | --- |
| `JitterSeconds` | `10 * 60` |
| `ToastLeadSeconds` | `120` |
| `CatchWindowSeconds` | `10 * 60` |
| `VisitHoursUtc` | `{ 16, 4 }` |
| `SandboxVisitHoursUtc` | `{ 4, 10, 16, 22 }` |
| `hash32` / `jitterFor` | as written |

Golden `2026-09-10T16` (must still hold after this change):

| Field | Value |
| --- | --- |
| `hash32` | `1396388120` |
| jitter | **+433** (not 237) |
| `slotUnix` | `1789056433` (16:07:13Z) |
| toast | `1789056313` (16:05:13Z) — game only |
| spawn | `1789056433` |
| catch end | `1789057033` (16:17:13Z) |
| Open Cloud `pushAt` after this + OC-19 | `1789055833` (15:57:13Z) |

`PushLeadSeconds` is **unused by TCG game Lua** today (`SpecialNpcDirector` never reads it). It is documentation for the controller. Changing TCG alone does not move spawn, toast, or catch.

This is a **three-way cutover**. Merge TCG `10 * 60` early if you want, but do **not** enable controller HTTP at 600s while the Dashboard string still says “8 minutes.” Flip together:

1. TCG `NPCConfig.COLLECTOR.PushLeadSeconds = 10 * 60` + spec copy 8 → 10
2. Dashboard body “about 10 minutes” (or new string + swap `message_id`)
3. Controller `pushLeadSeconds = 600` (OC-19)

Copy that says “8 minutes” with a 10 min send is a product bug.

---

## TCG-OC-08 — ProfileStore `EverOwnedLot`

**File:** `src/server/Data/Template.lua`

Add:

```lua
EverOwnedLot = false,
```

**Set `true` on first successful claim** (`PropertyManager.server.lua` `onClaimLot`, after the store actually cloned — not at `claimed = true` before the 5s wait, not on the revert path at line 441).

**Never clear on release.** Alumni who come back after months must still be alumni.

ProfileStore is **not** the audience list. The controller cannot list ProfileStore keys cheaply and must not read full player profiles. This flag only drives the **join** re-touch of `CollectorNotify` (next ticket). Join re-touch belongs in `PlayerDataInit.Initialize` (once per profile session), not `CharacterAdded` / `pushHud`.

Suggested accessor on `PlayerDataManager` (same style as `GetTutorial`):

```lua
function PlayerDataManager.GetEverOwnedLot(player)
	local profile = PlayerDataManager.Profiles[player]
	if not profile then return false end
	return profile.Data.EverOwnedLot == true
end

function PlayerDataManager.SetEverOwnedLot(player)
	local profile = PlayerDataManager.Profiles[player]
	if not profile then return end
	profile.Data.EverOwnedLot = true
end
```

Missing key on old profiles: `Reconcile` fills `false`. Treat as `false` until first successful claim **after this ships**.

**No historical backfill.** There is no cheap scan of ProfileStore. After deploy, a player enters `CollectorNotify` only by claiming (or releasing after that claim). Dormant alumni who last played months ago are **invisible** until they claim once. That is the intended loop: first return is organic; the next 14 days get MOMENT. Do **not** tell OC-15 this is “everyone who ever owned a shop.”

---

## TCG-OC-02 — `CollectorNotify` DataStore

**Does not exist today.** This is the Live audience. Blocks controller OC-15.

### Store contract (exact — controller will list this)

| Decision | Value |
| --- | --- |
| Kind | **Standard** DataStore (not Ordered, not ProfileStore) for v1 |
| Name | **`CollectorNotify`** (same name in both universes; stores are per-universe) |
| Key | `tostring(userId)` — **not** `lotId` |
| Value | Lua table / JSON with **`updatedUnix`** (number, Unix seconds). `lotId` optional debug only — controller does **not** use it to send. |
| Recency (controller) | keep ids with `updatedUnix >= nowUnix − 14 × 86400` |
| Missing store | controller falls back to allowlist. Empty ⇒ no HTTP. |

**Why not `lotId` as key:** lots are reused. Keying by lot would overwrite the former owner. MOMENT is per user.

**Scale (v1 acceptable, do not ignore):** TCG never deletes keys. The controller lists **every** historical claimant, then drops those older than 14 days, on the send cron. Fine for hundreds/thousands. Open Cloud list RPM is shared and low; at 10^5+ keys this hurts. If Live alumni grows, switch the audience **index** to an Ordered DataStore (`userId` → `updatedUnix`) so the controller can list only `now − 14d`. Keep `lotId` out of the send path either way. Controller must paginate and should cache; that is OC-15, not TCG.

Suggested value:

```lua
{
	updatedUnix = os.time(), -- required
	lotId = tostring(lotId), -- optional debug
}
```

### When to upsert

| Event | Keep the key? | Why |
| --- | --- | --- |
| **Claim** (`onClaimLot` success) | yes | Current owner must be pingable while offline |
| **Release** (`onReleaseLot` success, including `onPlayerRemoving`) | **yes — do not delete** | Former owner stays eligible **14 days** after release |
| **Join** if `EverOwnedLot` | yes | Post-ship alumni who join again (e.g. after 2 months) re-enter the 14-day window **without** claiming a lot again. Pre-ship owners are **not** alumni until they claim once after this ships (no backfill). |

### When **not** to write

- Studio Play (`RunService:IsStudio()`).
- Character respawn / `pushHud` / heartbeat / Collector poll. **At most one join-touch per session.**
- Failed claim (clone failed, already owns a lot, lot taken).
- Players who have **never** claimed a lot.

Claim and release are rare explicit events — always upsert those (even in the same session as a join-touch). Do not write from `SpecialNpcDirector` ticks.

### Failure policy

A failed DataStore write must **not** fail the claim/release/join. `pcall` + `warn`. The shop still works; that user may miss one MOMENT window.

### Suggested module

New `src/server/CollectorNotifyStore.lua` (name flexible). `UpdateAsync` so two servers cannot clobber `updatedUnix` **downward**. Capture `os.time()` **inside** the transform and take `max(old, now)`. A `now` captured before `UpdateAsync` lets the later-finishing call win with an older timestamp. `pcall` + `warn` on failure — do not swallow the error.

```lua
local DataStoreService = game:GetService("DataStoreService")
local RunService = game:GetService("RunService")

local store = DataStoreService:GetDataStore("CollectorNotify")

local function touch(userId, lotId)
	if RunService:IsStudio() then
		return
	end
	local key = tostring(userId)
	local ok, err = pcall(function()
		store:UpdateAsync(key, function(old)
			local next = type(old) == "table" and old or {}
			local prev = tonumber(next.updatedUnix)
			local t = os.time()
			if typeof(prev) ~= "number" or t > prev then
				next.updatedUnix = t
			end
			if lotId ~= nil then
				next.lotId = tostring(lotId)
			end
			return next
		end)
	end)
	if not ok then
		warn("CollectorNotify Touch failed userId=" .. key .. " err=" .. tostring(err))
	end
end

return { Touch = touch }
```

Hook points (current line numbers as of 2026-09-14 — they will drift):

| Call | File | Where |
| --- | --- | --- |
| `Touch(player.UserId, lotId)` | `PropertyManager.server.lua` | `onClaimLot` after successful clone (~line 438), together with `SetEverOwnedLot` |
| `Touch(playerReleasingLot.UserId, lotId)` | `PropertyManager.server.lua` | `onReleaseLot` after ownership cleared (~line 667). **Do not** `RemoveAsync`. |
| `Touch(player.UserId)` once | `PlayerDataInit.server.lua` | `Initialize` if `EverOwnedLot` (profile session start, **not** `CharacterAdded` / `pushHud`). |

Do **not** key, list, or send from TCG. The controller lists via a **separate** Open Cloud key (`universe-datastores.objects:list` + `:read` on this store only).

### Sandbox verify before Live alumni

Controller will not enable Live DataStore sends until Sandbox shows:

1. Claim → row exists, `updatedUnix` fresh, key = `userId`.
2. Release → row **stays**, `updatedUnix` bumped.
3. 15 days idle → controller would drop (TCG does not have to delete).
4. Rejoin with `EverOwnedLot` and no current lot → row fresh.
5. Player who last claimed **before** this shipped, has not claimed since → **no** row (no backfill).

---

## TCG-OC-03b — Durable `PromptOptIn` on first claim

What's New `2026-09-10-01` already prompts 13+ when that card is shown (`AnnouncementClient.client.lua` ~114–125). It **expires 2026-10-10**. Players who claimed a lot after dismissing it, or who never saw the card, stay opted out → Open Cloud **403**.

After **first successful claim**, client:

```lua
local service = game:GetService("ExperienceNotificationService")
local ok, canPrompt = pcall(function()
	return service:CanPromptOptInAsync()
end)
if ok and canPrompt then
	pcall(function()
		service:PromptOptIn()
	end)
end
```

Rules:

- **13+** only (`CanPromptOptInAsync` is false otherwise — do not special-case age in game code).
- Do **not** block the claim if they dismiss or the API errors.
- Fire **once per first claim**, not every join. `EverOwnedLot` going false → true is the trigger.
- Claim is server-side (`PropertyManager` proximity prompt). Add an S→C `RemoteEvent` (e.g. `PromptNotificationOptIn`) under `ReplicatedStorage.Events` in **both Studio places** (Live and Sandbox). Remotes are place-owned, not Rojo. `FireClient` only when this session set `EverOwnedLot` for the first time. Reuse the same `pcall` pattern as `AnnouncementClient`.
- Skip Studio Play if you skip `CollectorNotify` writes (same `IsStudio()` gate), or leave it on for local opt-in testing — either is fine; MOMENT still will not send to `studio:` slots.
- **Double prompt:** What's New `2026-09-10-01` still calls `PromptOptIn` until **2026-10-10**. First-time players can hit both in one session (What's New on join, then first claim). Same `pcall` pattern is fine; prefer one prompt per session if both would run. Do not block claim.

Until this ships, operators opt in from the experience page Notify bell.

---

## TCG-OC-07 — Patch spec `hash32` sentence

**File:** `docs/COLLECTOR_OPEN_CLOUD_NOTIFICATIONS.md` §2

Today it says:

> `xor` is 32-bit. Multiplication is mod 2^32.

That reads as uint32 wrap (`Math.imul` / Python `int`). That path hashes `2026-09-10T16` to jitter **237** and misses TCG spawn by **196s**.

Replace with:

> `xor` is 32-bit (`bit32.bxor`). Multiplication is **IEEE-754 double**, then `% 2^32` (Luau `(h * 16777619) % 4294967296`). It is **not** uint32 wrap / `Math.imul`. Golden: `2026-09-10T16` → hash `1396388120`, jitter **433**.

Do **not** change `SpecialNpcDirector.hash32` to match the old sentence.

---

## TCG-OC-04 — `launch_data` analytics (optional)

Controller already sends:

```json
"join_experience": { "launch_data": "collector:2026-09-10T16" }
```

TCG currently ignores join data. Spawn still uses `SpecialNpcDirector` clock. **Do not spawn from `launch_data`.** Joining after `slotUnix + 600` must still get **no** Collector for that slot.

If you add analytics:

1. Server, on join (`PlayerDataInit` / `onPlayerAdded`): `player:GetJoinData().LaunchData`.
2. If it matches `^collector:%d%d%d%d%-%d%d%-%d%dT%d%d$`, log via `AnalyticsModule.LogCustomEvent` (e.g. `collector_notify_join` + the slot key).
3. Never call `tickPlayer` / spawn from that string. `tickPlayer` is `local` in the director Script anyway.

---

## TCG-OC-05 — Next-slot HUD (optional)

Surface the next Collector time in the shop HUD using the **game** clock, not the Open Cloud service.

`SpecialNpcDirector.server.lua` is a **Script**, not a ModuleScript — do not `require` it. `clockSlotsNear`, `activeSlot`, and `nextUpcomingSlot` are all `local`.

| Helper | What it is | HUD? |
| --- | --- | --- |
| `nextUpcomingSlot(now)` | next `slot.unix > now` | **Yes** — countdown to the next visit |
| `activeSlot(now)` | slot whose **toast or catch** window contains `now` | Only “he is here / arriving now”. **Nil** most of the day |
| `clockSlotsNear(now)` | published hours ±1 day | Building block; not the HUD answer by itself |

Extract those helpers to a ModuleScript, or `FireClient` the next `slot.unix` from the director. Do not copy-paste a second jitter.

- Same `slotUnix` as spawn.
- Relative copy (“in about N minutes”) is safer than a wall clock. If you show a time, format in the **player’s** locale, never the server’s.
- Offline players will not see this; that is what MOMENT is for.

---

## TCG-OC-06 — Do not “fix” `hash32`

`SpecialNpcDirector.hash32` (local):

```lua
h = bit32.bxor(h, byte)
h = (h * 16777619) % 4294967296
```

Products exceed 2^53, so this **diverges** from uint32 FNV. Live/Sandbox jitter for `2026-09-10T16` is **433**. Changing the multiply would move every Collector spawn. If TCG ever changes hash, the **controller** follows.

Do not invoke in-game `jitterFor` in Studio Play to “check” Open Cloud (`StudioJitterSeconds` is **20**, not 600). Paste the snippet with `span = 600`, or read logs on a **published** Sandbox server.

---

## What TCG must not do

- Spawn NPCs, write ProfileStore Collector fields, or toast because a MOMENT was sent.
- Use MessagingService / Open Cloud `publishMessage` as offline notify (live servers only).
- Write `CollectorNotify` in Studio Play.
- `RemoveAsync` / delete the `CollectorNotify` key on release.
- Key `CollectorNotify` by `lotId`.
- Blast all CCU or all Notify-bell players from the game.
- Change `slotUnix`, jitter, toast lead, catch window, or Live `VisitHoursUtc` as part of this work.
- Put Roblox notification API keys or `message_id` in TCG git.
- Block claim/release/join on a DataStore or `PromptOptIn` failure.
- Backfill `EverOwnedLot` / `CollectorNotify` from historical ProfileStore or “everyone who ever owned a shop.”
- Change `hash32` to uint32 wrap / `Math.imul` to match the old spec sentence.

---

## Acceptance (game repo)

Sandbox published place, not Studio Play, unless noted.

| Check | Pass |
| --- | --- |
| Dashboard | Both universes have experience notifications on + a Collector string. Sandbox ≥100 visits. |
| `PushLeadSeconds` | `10 * 60`. Toast still T−2. Spawn still `slotUnix`. Catch still 10 min. Jitter still 433 for `2026-09-10T16`. |
| Claim | Profile `EverOwnedLot == true`. `CollectorNotify` key `tostring(userId)` exists with fresh `updatedUnix`. Opt-in prompt appears for 13+ who can prompt. Claim succeeds if they dismiss. |
| Release | Lot empties as today. `CollectorNotify` key **still exists**, `updatedUnix` bumped. `EverOwnedLot` still `true`. |
| Rejoin, no lot, `EverOwnedLot` | `CollectorNotify.updatedUnix` refreshed once this session. |
| Never claimed | No `CollectorNotify` row. No claim opt-in. |
| Claimed only before ship | No `CollectorNotify` row until they claim again. `EverOwnedLot` stays false. |
| Studio Play | No `CollectorNotify` writes. |
| Failed DS write | Claim/release still succeed. `warn` in Output. |
| Two servers touch same key | `updatedUnix` does not move backward. |
| `launch_data` (if TCG-OC-04) | Analytics only. Join after catch window → no spawn. |
| Spec §2 | No “mod 2^32” as uint32 wrap. Golden 433 documented. |

Controller-side checks after this lands (not TCG): Sandbox allowlist MOMENT in Notification Center ~10 min before spawn; later, list `CollectorNotify` (paginate; do not assume a small keyspace) and only ping ids in the 14-day window. Live notify hours stay **16 only** (Roblox one MOMENT per UTC day). 04:00 UTC still spawns for whoever is in-server; they do not get an offline ping.

---

## Files to touch

| File | Change |
| --- | --- |
| Creator Dashboard (both universes) | TCG-OC-01 |
| `src/server/Config/NPCConfig.lua` | `PushLeadSeconds = 10 * 60` |
| `src/server/Data/Template.lua` | `EverOwnedLot = false` |
| `src/server/Data/PlayerDataManager.lua` | get/set `EverOwnedLot` |
| `src/server/CollectorNotifyStore.lua` | **new** — standard DataStore upsert |
| `src/server/PropertyManager.server.lua` | claim + release hooks |
| `src/server/Data/PlayerDataInit.server.lua` | join re-touch in `Initialize` (once per profile session; no extra flag if that is the only join hook) |
| Studio place `ReplicatedStorage.Events` (Live **and** Sandbox) | new S→C `RemoteEvent` for first-claim `PromptOptIn` |
| Client (new remote handler or `AnnouncementClient` helper) | `CanPromptOptInAsync` + `PromptOptIn` on first claim |
| `docs/COLLECTOR_OPEN_CLOUD_NOTIFICATIONS.md` | 8→10 min; hash sentence; replace the short “TCG follow-ups” stub with this contract |
| Optional: join handler + `AnalyticsModule` | `launch_data` |
| Optional: shop HUD | next `slotUnix` |

---

## Out of scope (until product says otherwise)

- SMS / email / Discord
- Guaranteeing a lock-screen buzz
- Notifying under-13
- Studio Play MOMENTs
- Experience Updates as a Collector ping
- Widening the controller’s 60s send window
- A general Open Cloud SDK inside TCG
- Listing or sending from the game (the controller lists `CollectorNotify`)
