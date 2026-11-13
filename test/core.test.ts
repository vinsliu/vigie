import assert from "node:assert/strict";
import http from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  computeStats,
  getAgent,
  getSession,
  listSessions,
  parsePatch,
  pinnedFirst,
  readMeta,
  resumeCommand,
  updateMeta,
  withMeta,
} from "../src/core/index.ts";
import { localDay } from "../src/core/stats.ts";
import { createDashboard, isLocalHost } from "../src/server/index.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/claude/", import.meta.url));
const ID = "11111111-1111-4111-8111-111111111111";
let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "vigie-"));
  await cp(FIXTURES, dir, { recursive: true });
  await mkdir(join(dir, "sessions"));
  await writeFile(
    join(dir, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: ID, kind: "interactive", entrypoint: "cli" }),
  );
  // A dead process must not be reported as active.
  await writeFile(join(dir, "sessions", "dead.json"), JSON.stringify({ pid: 2 ** 22 + 1, sessionId: "other" }));
});
after(() => rm(dir, { recursive: true, force: true }));

/** node:http request, because fetch() cannot set forbidden headers such as Origin. */
function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let json: any = null;
        try {
          json = JSON.parse(data);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("management metadata", () => {
  it("builds a safely quoted resume command", () => {
    assert.equal(resumeCommand("/tmp/demo", ID), `cd '/tmp/demo' && claude --resume ${ID}`);
    assert.equal(resumeCommand("/tmp/it's $(x) here", ID), `cd '/tmp/it'\\''s $(x) here' && claude --resume ${ID}`);
    assert.equal(resumeCommand(null, ID), null);
    assert.equal(resumeCommand("/tmp/demo", "x; rm -rf ~"), null, "ids that are not session ids are refused");
    return getSession(dir, ID).then((d) => assert.equal(d?.resumeCommand, `cd '/tmp/demo' && claude --resume ${ID}`));
  });

  it("validates patches from untrusted input", () => {
    assert.deepEqual(parsePatch({ pinned: true }), { pinned: true });
    assert.deepEqual(parsePatch({ alias: "  Hello\nworld  " }), { alias: "Hello world" });
    assert.deepEqual(parsePatch({ alias: "   " }), { alias: null });
    assert.deepEqual(parsePatch({ alias: null }), { alias: null });
    assert.deepEqual(parsePatch({ archived: true, pinned: false }), { archived: true, pinned: false });
    assert.equal((parsePatch({ alias: "x".repeat(500) })?.alias ?? "").length, 120);
    for (const bad of [null, [], "x", {}, { pinned: "yes" }, { archived: "true" }, { archived: 1 }, { alias: 3 }, { pinned: true, extra: 1 }, { __proto__: 1, x: 1 }]) {
      assert.equal(parsePatch(bad), null, JSON.stringify(bad));
    }
  });

  it("persists pins and aliases in our own file and pins sort first", async () => {
    const data = join(dir, "meta-unit");
    assert.deepEqual(await readMeta(data), {}, "missing file means empty");
    await updateMeta(data, ID, { pinned: true, alias: "Mine" });
    assert.deepEqual((await readMeta(data))[ID], { pinned: true, alias: "Mine" });
    await assert.rejects(updateMeta(data, "../evil", { pinned: true }));

    const [s] = await listSessions(dir);
    assert.ok(s);
    const pinned = withMeta(s, await readMeta(data));
    assert.equal(pinned.pinned, true);
    assert.equal(pinned.alias, "Mine");
    const other = { ...s, id: "22222222-2222-4222-8222-222222222222", pinned: false };
    assert.deepEqual(pinnedFirst([other, pinned]).map((x) => x.id), [ID, other.id]);

    await updateMeta(data, ID, { archived: true });
    const archived = withMeta(s, await readMeta(data));
    assert.equal(archived.archived, true);
    assert.equal(archived.pinned, true, "archiving does not touch other settings");
    assert.equal(withMeta(s, {}).archived, false);

    await updateMeta(data, ID, { pinned: false, alias: null, archived: false });
    assert.deepEqual(await readMeta(data), {}, "empty entries are removed");
  });
});

describe("core", () => {
  it("summarises a transcript, tolerating invalid lines and unknown records", async () => {
    const [s] = await listSessions(dir);
    assert.ok(s);
    assert.equal(s.id, ID);
    assert.equal(s.title, "Login page");
    assert.equal(s.firstPrompt, "Add a login page");
    assert.equal(s.cwd, "/tmp/demo");
    assert.equal(s.entrypoint, "cli");
    assert.equal(s.model, "claude-test");
    assert.equal(s.costUSD, 0.42, "last cost-state wins");
    assert.equal(s.active, true);
    assert.equal(s.pid, process.pid);
  });

  it("builds a timeline with totals and strips injected reminders", async () => {
    const d = await getSession(dir, ID);
    assert.ok(d);
    assert.deepEqual(
      d.events.map((e) => e.kind),
      ["user", "assistant", "tool_use", "tool_result", "tool_use"],
    );
    assert.equal(d.events[0]?.text, "Add a login page");
    assert.equal(d.events[2]?.tool, "Write");
    assert.equal(d.totals.toolCalls, 2);
    // msg_1 is written twice (one record per content block): count it once.
    assert.equal(d.totals.messages, 3);
    assert.equal(d.totals.outputTokens, 20);
    assert.equal(d.totals.cacheReadTokens, 100);
  });

  it("builds the sub-agent tree and keeps sub-agent tokens out of the session totals", async () => {
    const [summary] = await listSessions(dir);
    assert.equal(summary?.agents, 2);

    const d = await getSession(dir, ID);
    assert.ok(d);
    assert.deepEqual(
      d.agents.map((a) => [a.id, a.parentAgentId, a.depth, a.type]),
      [
        ["aaaa1111", null, 1, "Explore"],
        ["bbbb2222", "aaaa1111", 2, "general-purpose"],
      ],
    );
    const [first, nested] = d.agents;
    assert.equal(first?.description, "Explore the repo");
    assert.equal(first?.model, "claude-haiku-test", "actual model wins over the meta alias");
    assert.equal(first?.finished, true);
    assert.equal(first?.totals.outputTokens, 10, "msg_a1 is written twice but counted once");
    assert.equal(nested?.finished, false);
    assert.equal(d.totals.outputTokens, 20, "session totals exclude sub-agents");

    const a = await getAgent(dir, ID, "aaaa1111");
    assert.deepEqual(
      a?.events.map((e) => e.kind),
      ["user", "assistant", "tool_use"],
    );
    assert.equal(await getAgent(dir, ID, "../../x"), null);
    assert.equal(await getAgent(dir, ID, "cccc3333"), null);
  });

  it("computes stats with deduplicated tokens and exact per-model cost", async () => {
    const now = Date.parse("2026-01-03T12:00:00Z");
    const s = await computeStats(dir, { days: 5, now });
    assert.equal(s.totals.sessions, 1);
    assert.equal(s.totals.costUSD, 0.42);
    assert.equal(s.totals.unpriced, 0, "this session has a recorded cost");
    assert.equal(s.projects[0]?.unpriced, 0);
    assert.equal(s.totals.tokens.output, 20);
    assert.equal(s.totals.tokens.cacheRead, 100);
    assert.equal(s.days.length, 5);
    const day = s.days.find((d) => d.date === localDay(new Date("2026-01-01T12:00:05Z")));
    assert.ok(day, "activity day is inside the window");
    assert.ok(Math.abs(day.costUSD - 0.42) < 1e-9, "single day gets the whole cost");
    assert.equal(day.sessions, 1);
    assert.equal(s.days.filter((d) => d.costUSD > 0).length, 1);
    assert.deepEqual(s.projects.map((p) => [p.project, p.sessions, p.costUSD]), [["/tmp/demo", 1, 0.42]]);
    assert.equal(s.models[0]?.model, "claude-test");
    assert.equal(s.models[0]?.costUSD, 0.42);
  });

  it("rejects ids that are not session ids", async () => {
    assert.equal(await getSession(dir, "../../etc/passwd"), null);
    assert.equal(await getSession(dir, "22222222-2222-4222-8222-222222222222"), null);
  });
});

describe("server", () => {
  it("only accepts loopback hosts", () => {
    assert.equal(isLocalHost("127.0.0.1:4317"), true);
    assert.equal(isLocalHost("localhost:4317"), true);
    assert.equal(isLocalHost("[::1]:4317"), true);
    assert.equal(isLocalHost("evil.example.com"), false);
    assert.equal(isLocalHost("127.0.0.1.evil.com"), false);
    assert.equal(isLocalHost(undefined), false);
  });

  it("serves the API, blocks foreign hosts, writes and path traversal", async () => {
    const server = createDashboard({ claudeDir: dir, dataDir: join(dir, "data") });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    try {
      const ok = await fetch(`${base}/api/sessions`);
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as { sessions: unknown[] }).sessions.length, 1);

      assert.equal((await fetch(`${base}/api/sessions/${ID}`)).status, 200);
      assert.equal((await fetch(`${base}/api/sessions/nope`)).status, 404);
      assert.equal((await fetch(`${base}/api/sessions/${ID}/agents/aaaa1111`)).status, 200);
      assert.equal((await fetch(`${base}/api/sessions/${ID}/agents/nope-nope`)).status, 404);
      assert.equal((await fetch(`${base}/api/sessions/${ID}/agents`)).status, 404);
      assert.equal((await fetch(`${base}/api/sessions/%E0%A4%A`)).status, 400);
      const stats = await fetch(`${base}/api/stats?days=7`);
      assert.equal(stats.status, 200);
      assert.equal(((await stats.json()) as { days: unknown[] }).days.length, 7);
      assert.equal((await fetch(`${base}/`)).status, 200);
      assert.equal((await fetch(`${base}/api/sessions`, { method: "POST" })).status, 405);
      assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);

      // fetch() cannot override Host, so use node:http for the forged request.
      const forged = await new Promise<number>((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, path: "/api/sessions", headers: { Host: "evil.example.com" } }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          })
          .on("error", reject);
      });
      assert.equal(forged, 403);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it("only writes pins and aliases, behind origin, content-type and size checks", async () => {
    const server = createDashboard({ claudeDir: dir, dataDir: join(dir, "data2") });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const host = `127.0.0.1:${port}`;
    const json = { "Content-Type": "application/json" };
    const url = `/api/sessions/${ID}/meta`;
    const transcript = join(dir, "projects", "-tmp-demo", `${ID}.jsonl`);
    const before = await readFile(transcript, "utf8");
    try {
      const ok = await request(port, "PATCH", url, { ...json, Origin: `http://${host}` }, JSON.stringify({ pinned: true, alias: "My name" }));
      assert.equal(ok.status, 200);
      assert.deepEqual(ok.json, { pinned: true, alias: "My name", archived: false });

      const arch = await request(port, "PATCH", url, json, JSON.stringify({ archived: true, pinned: false }));
      assert.deepEqual(arch.json, { pinned: false, alias: "My name", archived: true });
      const listed = await request(port, "GET", "/api/sessions");
      assert.equal(listed.json.sessions.length, 1, "archived sessions are still returned: filtering is the UI's job");
      assert.equal(listed.json.sessions[0].archived, true);
      assert.equal((await request(port, "PATCH", url, json, JSON.stringify({ archived: false, pinned: true }))).status, 200);

      const list = await request(port, "GET", "/api/sessions");
      assert.equal(list.json.sessions[0].alias, "My name");
      assert.equal(list.json.sessions[0].pinned, true);
      const detail = await request(port, "GET", `/api/sessions/${ID}`);
      assert.equal(detail.json.summary.alias, "My name");

      const body = JSON.stringify({ pinned: false });
      assert.equal((await request(port, "PATCH", url, { ...json, Origin: "http://evil.example" }, body)).status, 403);
      assert.equal((await request(port, "PATCH", url, { ...json, Origin: "http://localhost:9" }, body)).status, 403, "another local origin is still cross-origin");
      assert.equal((await request(port, "PATCH", url, { ...json, "Sec-Fetch-Site": "cross-site" }, body)).status, 403);
      assert.equal((await request(port, "PATCH", url, { "Content-Type": "text/plain" }, body)).status, 415);
      assert.equal((await request(port, "PATCH", url, { "Content-Type": "application/x-www-form-urlencoded" }, "pinned=false")).status, 415);
      assert.equal((await request(port, "PATCH", url, json, "{nope")).status, 400);
      assert.equal((await request(port, "PATCH", url, json, JSON.stringify({ pinned: "x" }))).status, 400);
      assert.equal((await request(port, "PATCH", url, json, JSON.stringify({ alias: "x".repeat(5000) }))).status, 413);
      assert.equal((await request(port, "PATCH", `/api/sessions/22222222-2222-4222-8222-222222222222/meta`, json, body)).status, 404);
      assert.equal((await request(port, "PATCH", `/api/sessions/..%2f..%2fx/meta`, json, body)).status, 404);
      assert.equal((await request(port, "OPTIONS", url, { Origin: "http://evil.example" })).status, 405);
      assert.equal((await request(port, "DELETE", `/api/sessions/${ID}`)).status, 405);
      assert.equal((await request(port, "PATCH", `/api/sessions/${ID}`, json, body)).status, 405, "only /meta is writable");

      // Failed attempts changed nothing, and Claude's transcript was never touched.
      assert.equal((await request(port, "GET", "/api/sessions")).json.sessions[0].pinned, true);
      assert.equal(await readFile(transcript, "utf8"), before);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});
