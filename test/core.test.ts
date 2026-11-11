import assert from "node:assert/strict";
import http from "node:http";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { computeStats, getSession, listSessions } from "../src/core/index.ts";
import { localDay } from "../src/core/stats.ts";
import { createDashboard, isLocalHost } from "../src/server/index.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/claude/", import.meta.url));
const ID = "11111111-1111-4111-8111-111111111111";
let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "agents-dashboard-"));
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
      ["user", "assistant", "tool_use", "tool_result"],
    );
    assert.equal(d.events[0]?.text, "Add a login page");
    assert.equal(d.events[2]?.tool, "Write");
    assert.equal(d.totals.toolCalls, 1);
    // msg_1 is written twice (one record per content block): count it once.
    assert.equal(d.totals.messages, 2);
    assert.equal(d.totals.outputTokens, 20);
    assert.equal(d.totals.cacheReadTokens, 100);
  });

  it("computes stats with deduplicated tokens and exact per-model cost", async () => {
    const now = Date.parse("2026-01-03T12:00:00Z");
    const s = await computeStats(dir, { days: 5, now });
    assert.equal(s.totals.sessions, 1);
    assert.equal(s.totals.costUSD, 0.42);
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
    const server = createDashboard({ claudeDir: dir });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const base = `http://127.0.0.1:${port}`;
    try {
      const ok = await fetch(`${base}/api/sessions`);
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as { sessions: unknown[] }).sessions.length, 1);

      assert.equal((await fetch(`${base}/api/sessions/${ID}`)).status, 200);
      assert.equal((await fetch(`${base}/api/sessions/nope`)).status, 404);
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
});
