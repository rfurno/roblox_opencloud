# Gachamon OpenCloud Controller — Product

**Status:** Draft, 2026-09-13. Local scheduler + dashboard implemented (`npm start`). MOMENT HTTP still dry-run by default. Daily Live DataStore snapshot is independent of `DRY_RUN`. v1 send lead is **8 min** (`pushLeadSeconds` 480); **OC-19** moves that to **10 min**. v1 audience is an allowlist; **OC-15** is 14-day lot alumni via TCG `CollectorNotify`. Spec: `roblox_gacha/docs/COLLECTOR_OPEN_CLOUD_NOTIFICATIONS.md`.

**Places** (same ids as TCG)

| Place | Role | Universe ID | Place ID | Visit hours UTC | Notify hours |
| --- | --- | --- | --- | --- | --- |
| [Gachamon TCG](https://www.roblox.com/games/98219898516303/Gachamon-TCG) | Live BETA | `6674250544` | `98219898516303` | 16, 4 | **16 only** |
| Gachamon Sandbox | Private development | `7034342160` | `117194948580255` | 4, 10, 16, 22 | all, or one hour per test day |

Live and Sandbox are **different universes**. Sandbox sends must never use the Live universe id (and vice versa).

---

## Pitch

The Collector visits shops on a **wall clock**, not “N minutes after you join.” If you are in a server 2 minutes before arrival, TCG already toasts you. If you are offline, you miss the visit and there is **no catch-up**. This service pings opted-in **lot alumni** (anyone who has ever claimed a lot, current or former, active in the last 14 days) so they can join in time. v1 send is ~8 minutes before `slotUnix`; **OC-19** moves that to **10 minutes**.

It is a Roblox **experience notification** (`MOMENT`) via Open Cloud — not SMS, email, or Discord. Creators cannot use those channels.

The same process also takes **one Live DataStore snapshot per UTC day**. That is a versioning pin (keys current at snapshot time stay restorable ~30 days), not a downloadable backup and not a Collector trigger.

## Who it is for

| Person | Role |
| --- | --- |
| **Lot alumni (13+, Notify bell on)** | Has ever claimed a lot in that universe. Offline when a Collector slot approaches; needs a reason to open Roblox and join before `slotUnix`. Drops off after 14 days idle; **re-enters** if they join again (e.g. after 2 months) |
| **Operator (this repo)** | One-person live-ops: allowlist (v1), keys, Fly machine, compare slots to TCG logs, confirm the daily Live snapshot landed |
| **Not for** | Under-13; players who never claimed a lot; all Notify-bell CCU; Studio Play testers (out of scope) |

## Job to be done

**When** The Collector’s next UTC slot is 10 minutes away (v1: 8 minutes until OC-19), **I want** a Notification Center item that deep-links into Gachamon, **so I can** be in my shop for the 10-minute catch window.

Joining after the catch window still gets **no spawn**. That is game-owned (`SpecialNpcDirector.tickPlayer`) and correct. The notification is a reminder, not a spawn trigger.

## Player-facing copy

Creator Dashboard notification string (manual, per universe; no Open Cloud API to create copy):

| Field | Value |
| --- | --- |
| Title | `The Collector` |
| Body (v1, shipped string) | `The Collector is on the way to your shop. Be there in about 8 minutes.` |
| Body (OC-19) | `The Collector is on the way to your shop. Be there in about 10 minutes.` — edit the Dashboard string (or new `message_id`) **before** enabling 600s lead |

Relative time only. Do not put `16:07 UTC` or the server’s local clock in the string. Optional later: dashboard parameter `{localTime}` formatted in the **recipient’s** IANA zone — display only, never changes `slotUnix`.

`join_experience.launch_data` = `collector:<slotKey>` (e.g. `collector:2026-09-10T16`). TCG currently **ignores** launch data; spawn still uses the clock. Optional TCG analytics later.

## Success metrics

v1 is an allowlist of tens of userIds, not CCU. Metrics are operational, not vanity.

| Signal | Target |
| --- | --- |
| Clock match | Controller `slotUnix` equals TCG server/Studio log for the same `slotKey` (golden: `2026-09-10T16` → `1789056433`) |
| Send time | v1: `[slotUnix − 480, slotUnix − 480 + 60)`. OC-19: `[slotUnix − 600, slotUnix − 600 + 60)`. Not N minutes after join |
| Offline delivery | Opted-in alumni (v1: allowlisted user) sees the item in Notification Center (OS push is **not** guaranteed) |
| No late send | If the 60s window is missed, skip. No toast-window or post-spawn MOMENT |
| Idempotency | Re-running the job does not double-send; unique `(universe, slot, user)` |
| Cap | At most one MOMENT per user per **UTC day** per universe (Roblox; **confirmed 2026-09-10**). Live sends **16:00 UTC only** (`notifyHoursLocal`); 04:00 is computed for clock tests but not sent |
| Isolation | Sandbox HTTP never uses universe `6674250544` |
| Live notify hour | MOMENT spends the 1/day cap on **16:00 UTC** (13:00 Brazil), not 04:00 UTC (01:00 Brazil). TCG still spawns at 04 |
| Game still owns spawn | Ignore the ping and join after `slotUnix + 600` → no Collector (TCG) |
| In-server players | Still get TCG toast at T−2 min; at most one Open Cloud MOMENT that UTC day |
| Live snapshot | One `data-stores:snapshot` POST per UTC day when `ROBLOX_API_KEY_LIVE_SNAPSHOT` is set; skip Collector send windows; ledger unique `(universe, utc_date)` |

## Constraints from Roblox (do not weaken)

Documented on Creator Hub / experience-notifications guide; verify if they change.

- Recipient **13+** and **opted in** (experience Notify bell). Under-13 Notify-bell users get experience **updates** only, not MOMENT.
- Delivered to **Notification Center** (silent inbox). Mobile/desktop push only if the user enabled those channels.
- **One experience notification per user per UTC day** from a given experience (treat as UTC calendar day of send; confirmed 2026-09-10).
- Experience eligibility: **≥100 visits**, not under moderation, you can manage the experience.
- `payload.type` must be `"MOMENT"` (only supported type).
- Notification **string** is created in Creator Dashboard; there is no Open Cloud API to create copy.
- API key scoped to **that universe** only.

DataStore snapshots (separate key; do not weaken):

- Scope **`universe-datastores.control:snapshot`** on Live `6674250544` only. Not the notifications key.
- **One snapshot per UTC day** per experience. A second POST that day is a no-op and returns `latestSnapshotTime`.
- Snapshot is a **versioning pin**, not a dump. Data current at snapshot time is a versioned backup for ~**30 days**.
- Roblox has **no list-snapshots API**. This controller’s history is local sqlite.
- Restore (not this service) needs `objects:read` / version-at-time, not the snapshot scope.

## Rollout stages

| Stage | Audience | HTTP? |
| --- | --- | --- |
| 0 Clock | none | no — golden tests (`npm test`) |
| 1 Local dry-run | this laptop: `npm start` + `http://127.0.0.1:3848` | no |
| 2 Sandbox curl | one team user, manual curl | yes, off-clock acceptable once |
| 3 Local Sandbox send | `config/allowlist.sandbox.json`. Gates: dashboard string + Sandbox key + ≥100 visits + opted-in user + `DRY_RUN=false` **armed only for that UTC day/hour** + laptop awake + clock golden 433 | yes |
| 4 Gated Live (local) | tiny `allowlist.live.json` + `LIVE_SENDS_ENABLED=true` | yes, not CCU |
| 5 Fly always-on | same jobs, machine not a laptop | later |
| 6 DataStore audience | TCG `CollectorNotify` lot alumni, 14-day recency, re-add on join | yes — **blocked on TCG-OC-02 + TCG-OC-08** |

Rollback is “Ctrl-C / set `DRY_RUN=true`.” TCG spawn is unaffected. The laptop sleeping through a 60s window is a missed send.

## Load (v1)

| Item | Number |
| --- | --- |
| Live visit slots | 2 / UTC day (16 and 04) — TCG spawn |
| Live notify slots | **1 / UTC day** (`notifyHoursLocal: [16]`) |
| Sandbox visit slots | 4 / UTC day |
| Sandbox notify slots | up to 4; Roblox 1/day cap still applies — arm one hour per test user |
| Send window | 60 seconds once per slot |
| Audience | tens of userIds |
| HTTP | 1 POST per user per sent slot, sequential; plus 1 Live snapshot POST per UTC day |
| Ledger | O(users × **notify** slots) — ~10 users × 1 Live notify/day × 365 ≈ **3.65k** Live send rows/year. Snapshots: 1 Live row/UTC day |

## Out of scope

- SMS / email / Discord
- Guaranteeing a lock-screen buzz
- Notifying under-13
- Changing Collector spawn time or jitter in TCG
- Studio Play slots
- Inventing a Live blast list / notifying all opted-in CCU
- Keying `CollectorNotify` by `lotId` (lots are reused; MOMENT needs `userId`)
- A general Open Cloud platform for other Gachamon features
- Downloading DataStore contents or implementing key restore from a snapshot time
