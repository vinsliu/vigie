import assert from "node:assert/strict";
import http from "node:http";
import { appendFile, cp, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { readDetail } from "../src/core/detail.ts";
import { createDashboard, sessionOfChange } from "../src/server/index.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/claude/", import.meta.url));
const ID = "11111111-1111-4111-8111-111111111111";
const user = (text: string) => JSON.stringify({ type: "user", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: text } });

describe("timeline of a long session", () => {
  it("keeps the latest events, oldest first, and says how many were left out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vigie-perf-"));
    try {
      const f = join(dir, "t.jsonl");
      const n = 4500;
      await writeFile(f, Array.from({ length: n }, (_, i) => user(`m${i}`)).join("\n"));
      const d = await readDetail(f);
      assert.equal(d.events.length, 2000);
      assert.equal(d.events[0]!.text, `m${n - 2000}`);
      assert.equal(d.events.at(-1)!.text, `m${n - 1}`);
      assert.equal(d.truncated, true);
      assert.equal(d.omitted, n - 2000);
      assert.equal(d.totals.messages, n, "totals still count every message");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is not truncated when it fits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vigie-perf-"));
    try {
      const f = join(dir, "t.jsonl");
      await writeFile(f, [user("a"), user("b")].join("\n"));
      const d = await readDetail(f);
      assert.deepEqual([d.truncated, d.omitted, d.events.length], [false, 0, 2]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("detail cache", () => {
  it("serves an unchanged transcript from memory and rereads it once it changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vigie-perf-"));
    try {
      const f = join(dir, "t.jsonl");
      await writeFile(f, user("a"));
      const first = await readDetail(f);
      assert.equal(await readDetail(f), first, "same object: not parsed again");
      assert.notEqual(await readDetail(f, { events: false }), first, "counts-only reads are cached apart");
      await appendFile(f, "\n" + user("b"));
      await utimes(f, new Date(), new Date(Date.now() + 5000));
      const second = await readDetail(f);
      assert.notEqual(second, first);
      assert.deepEqual(second.events.map((e) => e.text), ["a", "b"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("sessionOfChange", () => {
  it("finds the session a changed file belongs to", () => {
    assert.equal(sessionOfChange(`-proj/${ID}.jsonl`), ID);
    assert.equal(sessionOfChange(`-proj/${ID}/subagents/agent-abc123.jsonl`), ID);
    assert.equal(sessionOfChange("-proj"), null);
    assert.equal(sessionOfChange("-proj/notes.txt"), null);
    assert.equal(sessionOfChange(null), null);
  });
});

describe("targeted live updates", () => {
  it("names the session that changed in the update message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vigie-perf-"));
    await cp(FIXTURES, join(dir, "claude"), { recursive: true });
    const server = createDashboard({ claudeDir: join(dir, "claude"), dataDir: join(dir, "data") });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    let req: http.ClientRequest | undefined;
    try {
      const message = new Promise<string>((resolve, reject) => {
        req = http.get({ host: "127.0.0.1", port, path: "/api/events" }, (res) => {
          res.setEncoding("utf8");
          let buf = "";
          res.on("data", (c: string) => {
            buf += c;
            const m = /event: change\ndata: (.*)\n\n/.exec(buf);
            if (m) resolve(m[1]!);
          });
        });
        req.on("error", reject);
        setTimeout(() => reject(new Error("no update message")), 4000).unref();
      });
      await new Promise((r) => setTimeout(r, 300));
      const project = join(dir, "claude", "projects", "-tmp-demo");
      await writeFile(join(project, `${ID}.jsonl`), user("hello"));
      assert.deepEqual(JSON.parse(await message), { sessions: [ID] });
    } finally {
      req?.destroy();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await rm(dir, { recursive: true, force: true });
    }
  });
});
