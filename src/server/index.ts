import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { computeStats, getAgent, getSession, listSessions } from "../core/index.ts";
import { liveSessions } from "../core/live.ts";

const UI_DIR = fileURLToPath(new URL("../../ui/", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

/** DNS-rebinding guard: only accept requests addressed to a loopback host name. */
export function isLocalHost(host: string | undefined): boolean {
  return typeof host === "string" && LOCAL_HOST.test(host);
}

function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'",
  });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown) =>
  send(res, status, JSON.stringify(data), "application/json; charset=utf-8");

export interface Options {
  claudeDir: string;
}

export function createDashboard({ claudeDir }: Options): Server {
  const clients = new Set<ServerResponse>();
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let liveKey = "";
  let poll: NodeJS.Timeout | undefined;

  const broadcast = () => {
    for (const c of clients) c.write("event: change\ndata: {}\n\n");
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(broadcast, 300);
  };
  const startWatching = () => {
    for (const sub of ["projects", "sessions"]) {
      try {
        const w = watch(join(claudeDir, sub), { recursive: true }, schedule);
        w.on("error", () => {});
        watchers.push(w);
      } catch {
        /* folder missing: nothing to watch yet */
      }
    }
    // A process can die without touching any file: re-check liveness while someone is looking.
    poll = setInterval(async () => {
      if (clients.size === 0) return;
      const key = [...(await liveSessions(claudeDir)).keys()].sort().join(",");
      if (key !== liveKey) {
        liveKey = key;
        broadcast();
      }
    }, 5000);
    poll.unref();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!isLocalHost(req.headers.host)) return send(res, 403, "Forbidden host", "text/plain");
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Read-only", "text/plain");

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/api/stats") {
      const n = Number(url.searchParams.get("days"));
      return json(res, 200, await computeStats(claudeDir, { days: Number.isInteger(n) && n >= 1 && n <= 365 ? n : 30 }));
    }

    if (path === "/api/sessions") return json(res, 200, { sessions: await listSessions(claudeDir) });

    if (path.startsWith("/api/sessions/")) {
      let parts: string[];
      try {
        parts = path.slice("/api/sessions/".length).split("/").map(decodeURIComponent);
      } catch {
        return json(res, 400, { error: "bad path" });
      }
      const [sessionId = "", sub, agentId] = parts;
      let result = null;
      if (parts.length === 1) result = await getSession(claudeDir, sessionId);
      else if (parts.length === 3 && sub === "agents" && agentId) result = await getAgent(claudeDir, sessionId, agentId);
      return result ? json(res, 200, result) : json(res, 404, { error: "not found" });
    }

    if (path === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(": ok\n\n");
      clients.add(res);
      const ka = setInterval(() => res.write(": ka\n\n"), 25000);
      req.on("close", () => {
        clearInterval(ka);
        clients.delete(res);
      });
      return;
    }

    // Static UI, with a path-traversal guard.
    const rel = normalize(path === "/" ? "index.html" : path.replace(/^\/+/, ""));
    const file = join(UI_DIR, rel);
    if (!file.startsWith(UI_DIR) || rel.split(sep).includes("..")) return send(res, 404, "Not found", "text/plain");
    try {
      const ext = file.slice(file.lastIndexOf("."));
      return send(res, 200, await readFile(file), MIME[ext] ?? "application/octet-stream");
    } catch {
      return send(res, 404, "Not found", "text/plain");
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "Internal error", "text/plain");
      else res.end();
    });
  });
  server.on("listening", startWatching);
  server.on("close", () => {
    clearTimeout(timer);
    clearInterval(poll);
    for (const w of watchers) w.close();
    for (const c of clients) c.end();
  });
  return server;
}
