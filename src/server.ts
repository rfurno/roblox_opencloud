import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { msUntilNextBoundary } from "./clock.ts";
import type { AppConfig, UniverseName } from "./config.ts";
import { takeSnapshotNow, tickSnapshots } from "./snapshot.ts";
import { buildStatus } from "./status.ts";
import { sendSandboxNow, tick } from "./worker.ts";

const PUBLIC_DIR = resolve(fileURLToPath(new URL("../public", import.meta.url)));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

let tickChain: Promise<void> = Promise.resolve();
let running = true;

export function enqueueTick(cfg: AppConfig, dryRun?: boolean): Promise<void> {
  const run = () => tick(cfg, dryRun === undefined ? {} : { dryRun });
  tickChain = tickChain.then(run, run);
  return tickChain;
}

export function enqueueSnapshots(cfg: AppConfig): Promise<void> {
  const run = () => tickSnapshots(cfg).then(() => undefined);
  tickChain = tickChain.then(run, run);
  return tickChain;
}

function enqueueManualSnapshot(cfg: AppConfig, name: UniverseName) {
  const run = () => takeSnapshotNow(cfg, name);
  const next = tickChain.then(run, run);
  tickChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function schedulerLoop(cfg: AppConfig): Promise<void> {
  while (running) {
    await enqueueTick(cfg);
    await enqueueSnapshots(cfg);
    const wait = msUntilNextBoundary(Date.now(), cfg.schedule.tickIntervalSeconds);
    await new Promise((r) => setTimeout(r, wait));
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(json);
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  let urlPath = new URL(req.url || "/", "http://127.0.0.1").pathname;
  if (urlPath === "/") urlPath = "/index.html";
  const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const data = readFileSync(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

function openBrowser(url: string): void {
  const plat = process.platform;
  if (plat === "darwin") execFile("open", [url]);
  else if (plat === "win32") execFile("cmd", ["/c", "start", "", url]);
  else execFile("xdg-open", [url]);
}

export function startLocal(cfg: AppConfig): void {
  const host = "127.0.0.1";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${host}`);
    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, buildStatus(cfg));
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/tick") {
      await enqueueTick(cfg, true);
      sendJson(res, 200, { ok: true, dryRun: true, status: buildStatus(cfg) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/sandbox/send") {
      const result = await sendSandboxNow(cfg);
      const http =
        result.error && result.results.length === 0 ? 400 : 200;
      sendJson(res, http, { ...result, status: buildStatus(cfg) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/snapshots/live") {
      const result = await enqueueManualSnapshot(cfg, "live");
      sendJson(res, 200, { ...result, status: buildStatus(cfg) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/snapshots/sandbox") {
      const result = await enqueueManualSnapshot(cfg, "sandbox");
      sendJson(res, 200, { ...result, status: buildStatus(cfg) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET") {
      serveStatic(req, res);
      return;
    }
    res.writeHead(405);
    res.end("method not allowed");
  });

  server.listen(cfg.port, host, () => {
    const url = `http://${host}:${cfg.port}`;
    console.log(
      JSON.stringify({
        event: "listen",
        url,
        dryRun: cfg.dryRun,
        liveSendsEnabled: cfg.liveSendsEnabled,
        bind: host,
      }),
    );
    if (cfg.openBrowser) openBrowser(url);
  });

  const stop = () => {
    running = false;
    server.close();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  void schedulerLoop(cfg);
}
