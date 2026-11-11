import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeStats,
  getAgent,
  getSession,
  listSessions,
  parsePatch,
  pinnedFirst,
  readMeta,
  updateMeta,
  withMeta,
} from "../core/index.ts";
import type { AgentDetail, MetaPatch, SessionDetail } from "../core/index.ts";
import { liveSessions } from "../core/live.ts";
import { SESSION_ID } from "../core/paths.ts";
import { findTranscript } from "../core/scan.ts";

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

/** Sent with every response, the live-update stream included. */
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  // frame-ancestors / X-Frame-Options: no other site may show Vigie in a frame and trick a click on Pin or Archive.
  "Content-Security-Policy":
    "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Frame-Options": "DENY",
} as const;

function send(res: ServerResponse, status: number, body: string | Buffer, type: string): void {
  res.writeHead(status, { "Content-Type": type, ...SECURITY_HEADERS });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown) =>
  send(res, status, JSON.stringify(data), "application/json; charset=utf-8");

export interface Options {
  claudeDir: string;
  /** Where our own metadata (pins, aliases) is stored. */
  dataDir: string;
}

const MAX_BODY = 4096;

/** CSRF guard: a browser-sent Origin must be exactly the host the request was addressed to. */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true; // not a browser request (curl, tests)
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** At most MAX_BODY bytes. Past that it stops reading at once (null): the caller answers 413 and closes the connection. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        req.off("data", onData);
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(c);
    };
    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

/**
 * Which session a change under `<claudeDir>/projects` belongs to: `<project>/<id>.jsonl` or
 * `<project>/<id>/subagents/…`. Null when the path says nothing about one session.
 */
export function sessionOfChange(filename: string | null): string | null {
  const id = (filename ?? "").split(/[\\/]/)[1]?.replace(/\.jsonl$/, "") ?? "";
  return SESSION_ID.test(id) ? id : null;
}

/** More live-update connections than any real use needs: beyond this, new ones are refused. */
const MAX_EVENT_CLIENTS = 32;

export function createDashboard({ claudeDir, dataDir }: Options): Server {
  const clients = new Set<ServerResponse>();
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let live = new Set<string>();
  let poll: NodeJS.Timeout | undefined;

  // Sessions that changed since the last message. `unknown` = something changed that no session explains.
  const changed = new Set<string>();
  let unknown = false;
  const broadcast = () => {
    // {"sessions": [...]} names what changed so a page can ignore the rest; {} means "reload everything".
    const data = JSON.stringify(unknown || changed.size === 0 ? {} : { sessions: [...changed] });
    changed.clear();
    unknown = false;
    for (const c of clients) c.write(`event: change\ndata: ${data}\n\n`);
  };
  const schedule = (id: string | null) => {
    if (id) changed.add(id);
    else unknown = true;
    clearTimeout(timer);
    timer = setTimeout(broadcast, 300);
  };
  const startWatching = () => {
    for (const sub of ["projects", "sessions"]) {
      try {
        const w = watch(join(claudeDir, sub), { recursive: true }, (_event, name) =>
          schedule(sub === "projects" ? sessionOfChange(name as string | null) : null),
        );
        w.on("error", () => {});
        watchers.push(w);
      } catch {
        /* folder missing: nothing to watch yet */
      }
    }
    // A process can die without touching any file: re-check liveness while someone is looking.
    poll = setInterval(async () => {
      if (clients.size === 0) return;
      const now = new Set((await liveSessions(claudeDir)).keys());
      const flipped = [...now].filter((id) => !live.has(id)).concat([...live].filter((id) => !now.has(id)));
      live = now;
      for (const id of flipped) schedule(id);
    }, 5000);
    poll.unref();
  };

  /** The only write route: pin / alias, stored in our own file, never in Claude's transcripts. */
  const patchMeta = async (req: IncomingMessage, res: ServerResponse, rawId: string) => {
    if (!isSameOrigin(req.headers.origin, req.headers.host) || req.headers["sec-fetch-site"] === "cross-site") {
      return send(res, 403, "Forbidden origin", "text/plain");
    }
    // A JSON content type cannot be sent by a plain cross-site <form>, and OPTIONS is refused.
    if (!/^application\/json(\s*;|$)/i.test(req.headers["content-type"] ?? "")) {
      return send(res, 415, "Expected application/json", "text/plain");
    }
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return json(res, 400, { error: "bad path" });
    }
    if (!SESSION_ID.test(id)) return json(res, 404, { error: "not found" });
    const raw = await readBody(req);
    if (raw === null) {
      res.setHeader("Connection", "close"); // the rest of the body is not read: drop the connection once answered
      res.once("finish", () => req.destroy());
      return json(res, 413, { error: "body too large" });
    }
    let patch: MetaPatch | null;
    try {
      patch = parsePatch(JSON.parse(raw));
    } catch {
      patch = null;
    }
    if (!patch) return json(res, 400, { error: "invalid body" });
    if (!(await findTranscript(claudeDir, id))) return json(res, 404, { error: "not found" });
    const meta = await updateMeta(dataDir, id, patch);
    changed.add(id);
    clearTimeout(timer);
    broadcast();
    return json(res, 200, { pinned: meta.pinned === true, alias: meta.alias ?? null, archived: meta.archived === true });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    if (!isLocalHost(req.headers.host)) return send(res, 403, "Forbidden host", "text/plain");

    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    const metaRoute = /^\/api\/sessions\/([^/]+)\/meta$/.exec(path);
    if (req.method === "PATCH" && metaRoute) return patchMeta(req, res, metaRoute[1] ?? "");
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", "text/plain");

    if (path === "/api/stats") {
      const n = Number(url.searchParams.get("days"));
      return json(res, 200, await computeStats(claudeDir, { days: Number.isInteger(n) && n >= 1 && n <= 365 ? n : 30 }));
    }

    if (path === "/api/sessions") {
      const [sessions, metas] = await Promise.all([listSessions(claudeDir), readMeta(dataDir)]);
      return json(res, 200, { sessions: pinnedFirst(sessions.map((s) => withMeta(s, metas))) });
    }

    if (path.startsWith("/api/sessions/")) {
      let parts: string[];
      try {
        parts = path.slice("/api/sessions/".length).split("/").map(decodeURIComponent);
      } catch {
        return json(res, 400, { error: "bad path" });
      }
      const [sessionId = "", sub, agentId] = parts;
      let result: SessionDetail | AgentDetail | null = null;
      if (parts.length === 1) {
        const detail = await getSession(claudeDir, sessionId);
        if (detail) detail.summary = withMeta(detail.summary, await readMeta(dataDir));
        result = detail;
      } else if (parts.length === 3 && sub === "agents" && agentId) {
        result = await getAgent(claudeDir, sessionId, agentId);
      }
      return result ? json(res, 200, result) : json(res, 404, { error: "not found" });
    }

    if (path === "/api/events") {
      if (clients.size >= MAX_EVENT_CLIENTS) return send(res, 503, "Too many open connections", "text/plain");
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive", ...SECURITY_HEADERS });
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
