const clockEl = document.getElementById("clock");
const flagsEl = document.getElementById("flags");
const jobsEl = document.getElementById("jobs");
const ticksEl = document.getElementById("ticks");
const tickBtn = document.getElementById("tick-now");
let sendingSandbox = false;

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
