const clockEl = document.getElementById("clock");
const flagsEl = document.getElementById("flags");
const jobsEl = document.getElementById("jobs");
const ticksEl = document.getElementById("ticks");
const tickBtn = document.getElementById("tick-now");
const snapshotJobsEl = document.getElementById("snapshot-jobs");
const snapshotTableEl = document.getElementById("snapshot-table");
const snapshotHintEl = document.getElementById("snapshot-today-hint");
let sendingSandbox = false;
let takingSnapshot = false;
let currentTab = "collector";

function pad(n) {
  return String(n).padStart(2, "0");
}

function fmtCountdown(seconds) {
  const sign = seconds < 0 ? "-" : "";
  const s = Math.abs(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${sign}${h}h ${pad(m)}m`;
  if (m > 0) return `${sign}${m}m ${pad(sec)}s`;
  return `${sign}${sec}s`;
}

function chip(text, kind) {
  const span = document.createElement("span");
  span.className = `chip${kind ? " " + kind : ""}`;
  span.textContent = text;
  return span;
}

function renderFlags(data) {
  flagsEl.replaceChildren();
  flagsEl.append(
    chip(data.dryRun ? "DRY_RUN on" : "DRY_RUN off — HTTP armed", data.dryRun ? "on" : "hot"),
    chip(
      data.liveSendsEnabled ? "LIVE_SENDS_ENABLED" : "Live HTTP gated off",
      data.liveSendsEnabled ? "hot" : "",
    ),
    chip(`zone ${data.timeZone}`),
    chip(`tick ${data.tickIntervalSeconds}s`),
    chip(
      data.keysConfigured.sandbox ? "Sandbox key set" : "Sandbox key missing",
      data.keysConfigured.sandbox ? "on" : "warn",
    ),
    chip(
      data.messageConfigured.sandbox ? "Sandbox message_id set" : "Sandbox message_id missing",
      data.messageConfigured.sandbox ? "on" : "warn",
    ),
    chip(
      data.snapshotKeysConfigured.live ? "Live snapshot key set" : "Live snapshot key missing",
      data.snapshotKeysConfigured.live ? "on" : "warn",
    ),
  );
}

function renderJob(name, job, data) {
  const card = document.createElement("article");
  card.className = "card";
  const title = document.createElement("h2");
  title.innerHTML = `<span>${name}</span><span>${job.allowlistN} allowlisted</span>`;
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = `universe ${job.universeId} · visit ${job.hoursLocal.join("/")} · notify ${job.notifyHoursLocal.join("/")}`;
  card.append(title, meta);

  if (name === "Sandbox") {
    const row = document.createElement("div");
    row.className = "card-actions";
    const sendBtn = document.createElement("button");
    sendBtn.type = "button";
    sendBtn.className = "danger";
    sendBtn.textContent = "Send notification now";
    const ready =
      data.keysConfigured.sandbox && data.messageConfigured.sandbox && job.allowlistN > 0;
    sendBtn.disabled = !ready || sendingSandbox;
    sendBtn.title = ready
      ? "Bypass the send window. Counts as this user’s one MOMENT for the UTC day."
      : "Need Sandbox API key, message_id, and a non-empty allowlist (restart npm start after .env changes).";
    sendBtn.addEventListener("click", () => sendSandboxNow(sendBtn, job.allowlistN));
    row.append(sendBtn);
    card.append(row);
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = ready
      ? "Ignores DRY_RUN and the 8-minute window. Does not spawn The Collector. Uses this UTC day’s one MOMENT (Roblox limit)."
      : sendBtn.title;
    card.append(hint);
  }

  if (job.windowSlot) {
    const banner = document.createElement("p");
    banner.className = "banner";
    banner.textContent = `Send window open for ${job.windowSlot.key} · spawn ${job.windowSlot.spawnUtc}`;
    card.append(banner);
  } else if (job.nextNotify) {
    const banner = document.createElement("p");
    banner.className = "meta";
    banner.textContent = `Next notify ${job.nextNotify.key} · push in ${fmtCountdown(job.nextNotify.secondsToPush)} · spawn ${job.nextNotify.spawnUtc}`;
    card.append(banner);
  }

  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>Key</th><th>Push</th><th>Spawn</th><th>Jitter</th><th></th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const slot of job.slots) {
    const tr = document.createElement("tr");
    if (slot.inSendWindow && slot.notify) tr.className = "window";
    else if (!slot.notify) tr.className = "skip";
    const mark = slot.inSendWindow && slot.notify ? "NOW" : slot.notify ? "notify" : "clock only";
    tr.innerHTML = `<td>${slot.key}</td><td>${slot.pushUtc.slice(11)}</td><td>${slot.spawnUtc.slice(11)}</td><td>${slot.jitter > 0 ? "+" : ""}${slot.jitter}s</td><td>${mark}</td>`;
    tbody.append(tr);
  }
  table.append(tbody);
  card.append(table);
  return card;
}

function setTab(name) {
  currentTab = name;
  for (const btn of document.querySelectorAll(".tab")) {
    const on = btn.dataset.tab === name;
    btn.classList.toggle("active", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  }
  document.getElementById("pane-collector").classList.toggle("hidden", name !== "collector");
  document.getElementById("pane-snapshots").classList.toggle("hidden", name !== "snapshots");
}

function snapshotOutcome(row) {
  if (!row) return "none today";
  if (row.error) return row.error;
  return row.newSnapshotTaken ? "new snapshot" : "already existed that UTC day";
}

function renderSnapshotJob(label, name, job, data) {
  const card = document.createElement("article");
  card.className = "card";
  const title = document.createElement("h2");
  title.innerHTML = `<span>${label}</span><span>${job.keyConfigured ? "key set" : "key missing"}</span>`;
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = `universe ${job.universeId}`;
  card.append(title, meta);

  const today = job.today;
  const banner = document.createElement("p");
  if (today) {
    banner.className = "banner";
    banner.textContent = `Today ${today.utcDate}: ${snapshotOutcome(today)} · Roblox ${today.latestSnapshotTime || "—"}`;
  } else {
    banner.className = "meta";
    banner.textContent = job.keyConfigured
      ? `No snapshot recorded for ${data.snapshots.utcDate} UTC yet`
      : "Set ROBLOX_API_KEY_LIVE_SNAPSHOT (or SANDBOX) in .env and restart";
  }
  card.append(banner);

  const row = document.createElement("div");
  row.className = "card-actions";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Take snapshot now";
  btn.disabled = !job.keyConfigured || takingSnapshot;
  btn.title = job.keyConfigured
    ? "Uses this UTC day’s one snapshot. Safe if already taken — Roblox returns the existing time."
    : "Need a snapshot-scoped API key (universe-datastores.control:snapshot).";
  btn.addEventListener("click", () => takeSnapshot(name, label));
  row.append(btn);
  card.append(row);
  return card;
}

function renderSnapshots(data) {
  const snaps = data.snapshots;
  snapshotJobsEl.replaceChildren(
    renderSnapshotJob("Live", "live", snaps.jobs.live, data),
    renderSnapshotJob("Sandbox", "sandbox", snaps.jobs.sandbox, data),
  );
  snapshotHintEl.textContent = snaps.sendWindowOpen
    ? `UTC day ${snaps.utcDate}. Collector send window is open — scheduled snapshot waits; manual still runs.`
    : `UTC day ${snaps.utcDate}. Scheduled snapshot runs on the 30s tick once per day.`;

  const recent = snaps.recent || [];
  if (!recent.length) {
    snapshotTableEl.textContent = "No snapshots recorded on this machine yet.";
    snapshotTableEl.className = "hint";
    return;
  }
  snapshotTableEl.className = "";
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th>UTC day</th><th>Universe</th><th>Taken</th><th>Roblox latest</th><th>New?</th><th>Source</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  for (const row of recent) {
    const tr = document.createElement("tr");
    if (row.utcDate === snaps.utcDate && row.newSnapshotTaken) tr.className = "window";
    const taken = row.takenUnix
      ? new Date(row.takenUnix * 1000).toISOString().replace("T", " ").slice(0, 19) + "Z"
      : "—";
    tr.innerHTML = `<td>${row.utcDate}</td><td>${row.universeId}</td><td>${taken}</td><td>${row.latestSnapshotTime || "—"}</td><td>${row.newSnapshotTaken ? "yes" : "no"}</td><td>${row.source}</td>`;
    tbody.append(tr);
  }
  table.append(tbody);
  snapshotTableEl.replaceChildren(table);
}

function render(data) {
  clockEl.textContent = data.nowUtc.replace(" ", "  ");
  renderFlags(data);
  jobsEl.replaceChildren(
    renderJob("Sandbox", data.jobs.sandbox, data),
    renderJob("Live", data.jobs.live, data),
  );
  ticksEl.textContent = data.ticks.length
    ? data.ticks
        .slice(0, 30)
        .map((t) => JSON.stringify(t))
        .join("\n")
    : "No ticks yet.";
  if (data.snapshots) renderSnapshots(data);
}

async function refresh() {
  const res = await fetch("/api/status", { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  render(await res.json());
}

tickBtn.addEventListener("click", async () => {
  tickBtn.disabled = true;
  try {
    const res = await fetch("/api/tick", { method: "POST" });
    const body = await res.json();
    render(body.status);
  } finally {
    tickBtn.disabled = false;
  }
});

for (const btn of document.querySelectorAll(".tab")) {
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
}

async function takeSnapshot(name, label) {
  const ok = window.confirm(
    `Take today’s DataStore snapshot for ${label}?\n\nRoblox allows one snapshot per UTC day. A repeat call returns the existing snapshot time and does not copy player data here.`,
  );
  if (!ok) return;
  takingSnapshot = true;
  try {
    const res = await fetch(`/api/snapshots/${name}`, { method: "POST" });
    const body = await res.json();
    if (body.status) render(body.status);
    setTab("snapshots");
  } catch (err) {
    snapshotHintEl.textContent = String(err);
  } finally {
    takingSnapshot = false;
  }
}

async function sendSandboxNow(btn, allowlistN) {
  const ok = window.confirm(
    `Send a Sandbox MOMENT now to ${allowlistN} allowlisted user(s)?\n\nThis does not wait for The Collector clock and does not spawn the NPC. Roblox allows one experience notification per user per UTC day, so a later scheduled send today will be skipped.`,
  );
  if (!ok) return;
  sendingSandbox = true;
  btn.disabled = true;
  try {
    const res = await fetch("/api/sandbox/send", { method: "POST" });
    const body = await res.json();
    if (body.status) render(body.status);
    const lines = (body.results || []).map((r) => {
      const err = r.error ? ` ${r.error}` : "";
      return `${r.userId} ${r.outcome}${r.httpStatus != null ? " HTTP " + r.httpStatus : ""}${err}`;
    });
    const header = body.error ? `Send failed: ${body.error}` : `Manual send ${body.slotKey}`;
    ticksEl.textContent = [header, ...lines, "", ticksEl.textContent].join("\n");
  } catch (err) {
    ticksEl.textContent = String(err);
  } finally {
    sendingSandbox = false;
    btn.disabled = false;
  }
}

refresh().catch((err) => {
  ticksEl.textContent = String(err);
});
setInterval(() => {
  refresh().catch(() => {});
}, 1000);
