import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readDetail } from "../src/core/detail.ts";
import { redact } from "../src/core/redact.ts";

// Fake secrets are assembled at runtime so that no secret scanner flags this file.
const fake = {
  anthropic: "sk-ant-" + "a1B2c3D4".repeat(5),
  github: "ghp_" + "x9Y8z7W6".repeat(5),
  aws: "AKIA" + "ABCDEFGH12345678",
  stripe: "sk_" + "live_" + "q1w2e3r4t5y6u7i8o9",
  jwt: ["eyJhbGciOiJI", "eyJzdWIiOiIxMjM0NTY3", "SflKxwRJSMeKKF2QT4fwpM"].join("."),
  pem: "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END " + "RSA PRIVATE KEY-----",
};

describe("redact", () => {
  it("masks provider tokens, JWTs and private keys", () => {
    for (const [name, value] of Object.entries(fake)) {
      const out = redact(`before ${value} after`);
      assert.ok(!out.includes(value.slice(0, 20)), `${name} still visible: ${out}`);
      assert.ok(out.includes("[redacted]"), `${name} not masked`);
      assert.ok(out.startsWith("before ") && out.includes(" after") || name === "pem", `${name} lost its context`);
    }
  });

  it("masks credentials in URLs, bearer headers and NAME=value assignments", () => {
    assert.equal(redact("postgres://admin:hunter2pass@db.local/app"), "postgres://admin:[redacted]@db.local/app");
    assert.equal(redact("Authorization: Bearer abcdef0123456789ABCDEF"), "Authorization: Bearer [redacted]");
    assert.equal(redact("STRIPE_SECRET_KEY=abcd1234efgh5678"), "STRIPE_SECRET_KEY=[redacted]");
    assert.equal(redact('api_key: "abcd1234efgh5678"'), 'api_key: "[redacted]"');
  });

  it("leaves ordinary text alone", () => {
    for (const text of [
      "tokens: 169303 and password: required",
      "Run npm test, then open http://127.0.0.1:4317/#/stats",
      "the secret is in how we cache it",
      "user@example.com wrote src/core/redact.ts",
      "sk-learn is a library",
      "password: Joi.string().min(8).max(100).required(),",
      "const passwordRules = Joi.string().pattern(/[A-Z]/).min(12)",
    ]) {
      assert.equal(redact(text), text);
    }
  });

  it("is applied to timelines, so nothing leaks through the API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vigie-redact-"));
    try {
      const file = join(dir, "t.jsonl");
      const rec = (o: object) => JSON.stringify(o);
      await writeFile(
        file,
        [
          rec({ type: "user", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: `key is ${fake.anthropic}` } }),
          rec({
            type: "assistant",
            timestamp: "2026-01-01T00:00:01Z",
            message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: `curl -H "Authorization: Bearer ${fake.github}" x` } }] },
          }),
          rec({ type: "user", timestamp: "2026-01-01T00:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI12345/K7MDENGbPxRfi\n${fake.aws}` }] } }),
        ].join("\n"),
      );
      const { events } = await readDetail(file);
      const all = events.map((e) => e.text).join("\n");
      for (const v of [fake.anthropic, fake.github, fake.aws, "wJalrXUtnFEMI12345"]) {
        assert.ok(!all.includes(v), `leaked: ${v}`);
      }
      assert.ok(all.includes("[redacted]"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
