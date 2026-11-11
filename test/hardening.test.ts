import assert from "node:assert/strict";
import http from "node:http";
import { cp, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { remember } from "../src/core/cache.ts";
import { readDetail } from "../src/core/detail.ts";
import { countAgents } from "../src/core/agents.ts";
import { listSessions } from "../src/core/index.ts";
import { readLines } from "../src/core/lines.ts";
import { parsePatch, resumeCommand, updateMeta } from "../src/core/meta.ts";
import { createDashboard } from "../src/server/index.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/claude/", import.meta.url));
const ID = "11111111-1111-4111-8111-111111111111";
const posix = process.platform !== "win32";
// Special characters are built from their code, never typed as escapes.
const ch = (code: number) => String.fromCharCode(code);

async function tmp(prefix: string) {
  return mkdtemp(join(tmpdir(), `vigie-${prefix}-`));
}
async function collect(path: string, opts?: { maxLine?: number; chunkSize?: number }) {
  const out: string[] = [];
  for await (const line of readLines(path, opts)) out.push(line);
  return out;
}

describe("readLines", () => {
  it("reads lines, handles CRLF, blank lines and a last line without a newline", async () => {
    const dir = await tmp("lines");
    try {
      const f = join(dir, "a.txt");
      await writeFile(f, "one\r\ntwo\n\nthree");
      assert.deepEqual(await collect(f), ["one", "two", "", "three"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const dir = await tmp("lines");
    try {
      const f = join(dir, "u.txt");
      await writeFile(f, "héllo 世界\n" + String.fromCodePoint(0x1f600) + "\n");
      assert.deepEqual(await collect(f, { chunkSize: 1 }), ["héllo 世界", String.fromCodePoint(0x1f600)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops a line over the limit whole, without holding it, and keeps reading", async () => {
    const dir = await tmp("lines");
    try {
      const f = join(dir, "big.txt");
      await writeFile(f, ["before", "x".repeat(50_000), "after", "y".repeat(1001), "last"].join("\n"));
      assert.deepEqual(await collect(f, { maxLine: 1000, chunkSize: 4096 }), ["before", "after", "last"]);
      // Right at the limit is kept.
      await writeFile(f, `${"z".repeat(1000)}\nok\n`);
      assert.equal((await collect(f, { maxLine: 1000 }))[0]?.length, 1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("opens a session whose transcript holds a huge line", async () => {
    const dir = await tmp("huge");
    try {
      const f = join(dir, "t.jsonl");
      const user = (text: string) => JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: text } });
      // One line of 9 MB (over the 8 MB limit) between two normal ones.
      await writeFile(f, [user("first"), user("x".repeat(9 * 1024 * 1024)), user("last")].join("\n"));
      const { events } = await readDetail(f);
      assert.deepEqual(events.map((e) => e.text), ["first", "last"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("caches", () => {
  it("forgets the oldest entries beyond the limit, and a re-set key becomes the newest", () => {
    const m = new Map<string, number>();
    for (const [k, v] of [["a", 1], ["b", 2], ["c", 3]] as const) remember(m, k, v, 3);
    remember(m, "a", 10, 3); // a is now the newest
    remember(m, "d", 4, 3); // evicts b, the oldest
    assert.deepEqual([...m.keys()], ["c", "a", "d"]);
    assert.equal(m.get("a"), 10);
  });
});

describe("hostile input", () => {
  it("still opens a session whose tool input is nested too deep to print", async () => {
    const dir = await tmp("deep");
    try {
      const f = join(dir, "t.jsonl");
      const depth = 20_000;
      const nested = '{"a":'.repeat(depth) + "{}" + "}".repeat(depth);
      const line = `{"type":"assistant","timestamp":"2026-01-01T00:00:00Z","message":{"id":"m1","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Weird","input":${nested}}],"usage":{"input_tokens":1,"output_tokens":1}}}`;
      await writeFile(f, line + "\n");
      const { events, totals } = await readDetail(f);
      assert.equal(totals.toolCalls, 1);
      assert.match(events[0]!.text, /too deeply nested/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("gives no resume command for a folder name with a control character, and a long one", () => {
    assert.equal(resumeCommand("/Users/demo/my project", ID), `cd '/Users/demo/my project' && claude --resume ${ID}`);
    for (const bad of ["\n", ch(3), ch(27) + "[31m", ch(0x2028), ch(0x85)]) {
      assert.equal(resumeCommand(`/tmp/a${bad}b`, ID), null, JSON.stringify(bad));
    }
    assert.equal(resumeCommand("/" + "a".repeat(1024), ID), null);
  });

  it("strips invisible and direction-changing characters from a display name", () => {
    const alias = `ab${ch(0x202e)}cd${ch(0x200b)}ef${ch(7)}gh${ch(0xfeff)}`;
    assert.equal(parsePatch({ alias })?.alias, "ab cd ef gh");
  });
});

describe("the metadata folder", { skip: !posix }, () => {
  it("is private, the file is 0600, and no temporary file is left behind", async () => {
    const parent = await tmp("meta");
    try {
      const dataDir = join(parent, "data");
      await updateMeta(dataDir, ID, { pinned: true });
      await updateMeta(dataDir, ID, { alias: "hello" });
      assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
      assert.equal((await stat(join(dataDir, "meta.json"))).mode & 0o777, 0o600);
      assert.deepEqual(await readdir(dataDir), ["meta.json"]);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

describe("symbolic links", { skip: !posix }, () => {
  it("are never followed: not a project folder, not a transcript, not a sub-agent folder", async () => {
    const root = await tmp("links");
    try {
      const elsewhere = join(root, "elsewhere");
      await mkdir(elsewhere);
      const line = JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp/x", message: { role: "user", content: "hi" } });
      await writeFile(join(elsewhere, "t.jsonl"), line + "\n");

      const projects = join(root, "claude", "projects");
      await mkdir(join(projects, "-tmp-real"), { recursive: true });
      const real = "22222222-2222-4222-8222-222222222222";
      await writeFile(join(projects, "-tmp-real", `${real}.jsonl`), line + "\n");
      // a symlinked transcript, and a symlinked project folder
      await symlink(join(elsewhere, "t.jsonl"), join(projects, "-tmp-real", "33333333-3333-4333-8333-333333333333.jsonl"));
      await symlink(elsewhere, join(projects, "-tmp-linked"));
      // a symlinked sub-agents folder
      await mkdir(join(elsewhere, "agents"));
      await writeFile(join(elsewhere, "agents", "agent-aaaa1111.meta.json"), "{}");
      await symlink(join(elsewhere, "agents"), join(projects, "-tmp-real", real));
      assert.ok((await lstat(join(projects, "-tmp-linked"))).isSymbolicLink());

      const sessions = await listSessions(join(root, "claude"));
      assert.deepEqual(sessions.map((s) => s.id), [real]);
      assert.equal(await countAgents(join(projects, "-tmp-real", `${real}.jsonl`)), 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the server", () => {
  async function start() {
    const dir = await tmp("server");
    await cp(FIXTURES, join(dir, "claude"), { recursive: true });
    const server = createDashboard({ claudeDir: join(dir, "claude"), dataDir: join(dir, "data") });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    return { dir, server, port, stop: async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await rm(dir, { recursive: true, force: true }); } };
  }
  const get = (port: number, path: string) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers })); }).on("error", reject);
    });

  it("forbids being shown in a frame, on every response including the update stream", async () => {
    const s = await start();
    try {
      const page = await get(s.port, "/");
      const api = await get(s.port, "/api/sessions");
      for (const r of [page, api]) {
        const csp = String(r.headers["content-security-policy"]);
        for (const directive of ["frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "default-src 'self'"]) assert.ok(csp.includes(directive), `${directive} missing from: ${csp}`);
        assert.equal(r.headers["x-frame-options"], "DENY");
        assert.equal(r.headers["x-content-type-options"], "nosniff");
      }
      // the event stream carries the same headers
      const headers = await new Promise<http.IncomingHttpHeaders>((resolve) => {
        const req = http.get({ host: "127.0.0.1", port: s.port, path: "/api/events" }, (res) => { resolve(res.headers); req.destroy(); });
      });
      assert.equal(headers["content-type"], "text/event-stream");
      assert.equal(headers["x-content-type-options"], "nosniff");
      assert.ok(String(headers["content-security-policy"]).includes("frame-ancestors 'none'"));
    } finally {
      await s.stop();
    }
  });

  it("refuses new live-update connections past the limit, and accepts again once some close", async () => {
    const s = await start();
    const open: http.ClientRequest[] = [];
    try {
      const connect = () => new Promise<number>((resolve) => { const req = http.get({ host: "127.0.0.1", port: s.port, path: "/api/events" }, (res) => { resolve(res.statusCode ?? 0); if (res.statusCode !== 200) res.resume(); }); open.push(req); });
      const codes: number[] = [];
      for (let i = 0; i < 32; i++) codes.push(await connect());
      assert.ok(codes.every((c) => c === 200), "the first 32 are accepted");
      assert.equal(await connect(), 503, "the 33rd is refused");
      open.shift()!.destroy(); // one closes...
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(await connect(), 200, "...and a new one is accepted");
    } finally {
      for (const r of open) r.destroy();
      await s.stop();
    }
  });

  it("answers 413 to an oversized body without reading all of it, and keeps serving", async () => {
    const s = await start();
    try {
      const status = await new Promise<{ code: number; connection: string | undefined }>((resolve, reject) => {
        const req = http.request(
          { host: "127.0.0.1", port: s.port, method: "PATCH", path: `/api/sessions/${ID}/meta`, headers: { "Content-Type": "application/json", "Content-Length": String(50 * 1024 * 1024) } },
          (res) => { res.resume(); resolve({ code: res.statusCode ?? 0, connection: res.headers.connection }); },
        );
        req.on("error", () => { /* the server closes the connection: expected */ });
        req.write("x".repeat(64 * 1024)); // well over the 4 KB limit; the other 49.9 MB are never sent
        setTimeout(() => reject(new Error("no answer: the server is waiting for the whole body")), 3000).unref();
      });
      assert.equal(status.code, 413);
      assert.equal(status.connection, "close");
      assert.equal((await get(s.port, "/api/sessions")).status, 200);
    } finally {
      await s.stop();
    }
  });
});
