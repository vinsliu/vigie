import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { computeStats, getSession, listSessions, readMeta } from "../src/core/index.ts";
import { generateDemo } from "../scripts/demo-data.ts";

describe("demo data", () => {
  it("produces a believable, safe dataset that Vigie can read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vigie-demo-test-"));
    try {
      const { claudeDir, dataDir, sessions } = await generateDemo(dir, { pid: process.pid });
      const list = await listSessions(claudeDir);
      assert.equal(list.length, sessions);
      assert.equal(list.filter((s) => s.active).length, 1);
      assert.ok(list.every((s) => s.costUSD !== null && s.costUSD > 0), "every session has a cost");
      assert.deepEqual([...new Set(list.map((s) => s.entrypoint))].sort(), ["claude-desktop", "claude-vscode", "cli"]);

      // Sub-agents, one of them nested.
      const withAgents = list.find((s) => s.agents > 0);
      assert.ok(withAgents);
      const detail = await getSession(claudeDir, withAgents.id);
      assert.deepEqual(detail?.agents.map((a) => a.depth), [1, 2]);

      // Pins / archive / alias come from the data dir.
      const meta = await readMeta(dataDir);
      assert.ok(Object.values(meta).some((m) => m.pinned));
      assert.ok(Object.values(meta).some((m) => m.archived));

      // The made-up .env content must come out masked.
      const rate = list.find((s) => s.title === "Rate limiting on checkout");
      assert.ok(rate);
      const events = (await getSession(claudeDir, rate.id))!.events.map((e) => e.text).join("\n");
      assert.ok(!events.includes("51Hx9Demo") && !events.includes("s3cretPass99"));
      assert.ok(events.includes("[redacted]"));

      const stats = await computeStats(claudeDir, { days: 30 });
      assert.ok(stats.totals.costUSD > 0);
      assert.ok(stats.days.filter((d) => d.costUSD > 0).length >= 5, "cost spread over several days");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
