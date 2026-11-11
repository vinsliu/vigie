import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readDetail } from "../src/core/detail.ts";
import { getSession, listSessions } from "../src/core/index.ts";
import { MAX_SCAN, redact } from "../src/core/redact.ts";
import { display } from "../src/core/text.ts";

// Fake secrets are assembled at runtime so that no secret scanner flags this file: a scanner reads the source,
// so a value written whole (even a made-up one) is reported, and rightly so.
const j = (...parts: string[]) => parts.join("");
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
    const value = j("abcd1234", "efgh5678");
    assert.equal(redact(`postgres://admin:${j("hunter", "2pass")}@db.local/app`), "postgres://admin:[redacted]@db.local/app");
    assert.equal(redact("Authorization: Bearer abcdef0123456789ABCDEF"), "Authorization: Bearer [redacted]");
    assert.equal(redact(`STRIPE_SECRET_KEY=${value}`), "STRIPE_SECRET_KEY=[redacted]");
    assert.equal(redact(`api_key: "${value}"`), 'api_key: "[redacted]"');
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

  it("masks the formats that used to slip through: JSON keys, CLI flags, more providers", () => {
    const secrets = {
      npm: "npm_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
      gitlab: "glpat-" + "A1b2C3d4E5f6G7h8I9j0",
      huggingFace: "hf_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5",
      sendgrid: "SG." + "a1B2c3D4e5F6g7H8" + "." + "i9J0k1L2m3N4o5P6",
      googleOauth: "ya29." + "a0AfH6SMBx1234567890abcdefgh",
      slackWebhook: "https://hooks.slack.com/services/" + "T01234567/B01234567/abcdefghijklmnopqrstuvwx",
      twilio: "SK" + "0123456789abcdef0123456789abcdef",
      discord: "N" + "a1B2c3D4e5F6g7H8i9J0k1L" + "." + "XyZ123" + "." + "abcdefghijklmnopqrstuvwxyz1",
    };
    for (const [name, value] of Object.entries(secrets)) {
      const out = redact(`token ${value} end`);
      assert.ok(!out.includes(value.slice(0, 14)), `${name} still visible: ${out}`);
    }
    const pw = j("Sup3r", "S3cret", "Pass99");
    const apiKey = j("k9x8c7v6", "b5n4m3q2", "w1e0");
    const clientSecret = j("abcd1234", "efgh5678", "ijkl");
    const accessToken = j("abc.def", "-1234567890");
    const flagToken = j("abcd", "1234");
    const envPassword = j("hunter", "2");
    const envToken = j("abc", "def");
    const cases: Array<[string, string]> = [
      [`{"apiKey": "${apiKey}"}`, `{"apiKey": "[redacted]"}`],
      [`{"password": "${pw}"}`, `{"password": "[redacted]"}`],
      [`{"client_secret":"${clientSecret}"}`, `{"client_secret":"[redacted]"}`],
      [`{"access_token": "${accessToken}"}`, `{"access_token": "[redacted]"}`],
      [`password: '${pw}'`, `password: '[redacted]'`],
      [`mysql --password ${pw} -h db`, `mysql --password [redacted] -h db`],
      [`run --token=${flagToken} now`, `run --token=[redacted] now`],
      [`curl -u admin:${pw} https://x.example`, `curl -u admin:[redacted] https://x.example`],
      [`PASSWORD=${envPassword}`, `PASSWORD=[redacted]`],
      [`export GITHUB_TOKEN=${envToken}`, `export GITHUB_TOKEN=[redacted]`],
    ];
    for (const [input, expected] of cases) assert.equal(redact(input), expected, input);
  });

  it("does not mistake numbers, words and code for secrets", () => {
    for (const text of [
      "MAX_TOKENS=4096",
      "TOKEN=true",
      "run --token-count 5 and --password-file path",
      "--password",
      `{"name": "alice", "role": "administrator"}`,
      `{"password": "string"}`,
      `{"password": "required"}`,
      `"tokenizer": "my-tokenizer-v2-large"`,
      `password: "hello world again"`,
      "the apiKey option is optional",
      "GET /api/users?token_count=1000000",
    ]) {
      assert.equal(redact(text), text);
    }
  });

  it("stays fast on hostile text: a prompt-injected page can put anything in a transcript", () => {
    // These shapes took seconds before the patterns were bounded (80 KB of the first one: 1.7 s).
    const n = 200_000;
    const shapes: Record<string, string> = {
      "dotted run": "a.".repeat(n / 2),
      "dashed run": "a-".repeat(n / 2),
      "scheme marks": "a://".repeat(n / 4),
      "jwt-like": "eyJaaaaaaaa-".repeat(n / 12),
      "jwt dots": "eyJaaaaaaaa.aaaaaaaa.".repeat(n / 21),
      "keyword run": "TOKEN".repeat(n / 5),
      "keyword equals": "TOKEN=".repeat(n / 6),
      "prefixed keyword": "A_TOKEN".repeat(n / 7),
      "quoted keys": '"token":"'.repeat(n / 9),
      "bearer spaces": "Bearer" + " ".repeat(n),
      "bearer run": "Bearer ".repeat(n / 7),
      "key blocks": "-----BEGIN A PRIVATE KEY-----".repeat(n / 29),
      "flags": "--password ".repeat(n / 11),
      "curl users": " -u a:".repeat(n / 6),
    };
    for (const [name, text] of Object.entries(shapes)) {
      const start = performance.now();
      redact(text);
      const ms = performance.now() - start;
      assert.ok(ms < 500, `${name}: ${ms.toFixed(0)} ms for ${text.length} characters`);
    }
  });

  it("never scans more than MAX_SCAN characters, and masks a secret before the text is cut", () => {
    const huge = redact("x".repeat(5_000_000));
    assert.ok(huge.length <= MAX_SCAN + 1);
    // The secret straddles the 1500-character cut: it must be masked first, never half shown.
    const text = "y".repeat(1489) + " " + fake.anthropic + " tail";
    const shown = display(text, 1500);
    assert.ok(!shown.includes("sk-ant-"), shown.slice(1480));
    assert.ok(shown.includes("[redacted]"));
  });

  it("also covers titles, agent names, tool names, models and sub-agent fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "vigie-redact-fields-"));
    try {
      const id = "33333333-3333-4333-8333-333333333333";
      const dir = join(root, "projects", "-tmp-leaky");
      await mkdir(join(dir, id, "subagents"), { recursive: true });
      const key = fake.anthropic;
      const rec = (o: object) => JSON.stringify(o);
      await writeFile(
        join(dir, `${id}.jsonl`),
        [
          rec({ type: "user", timestamp: "2026-01-01T00:00:00Z", cwd: "/tmp/leaky", entrypoint: `cli ${key}`, version: `1.0 ${key}`, message: { role: "user", content: "hello" } }),
          rec({ type: "agent-name", agentName: `agent ${key}` }),
          rec({ type: "custom-title", customTitle: `title ${key}` }),
          rec({
            type: "assistant",
            timestamp: "2026-01-01T00:00:01Z",
            message: { id: "m1", role: "assistant", model: `model ${key}`, content: [{ type: "tool_use", id: "toolu_1", name: `Tool ${key}`, input: { command: "ls" } }], usage: { input_tokens: 1, output_tokens: 1 } },
          }),
        ].join("\n"),
      );
      await writeFile(join(dir, id, "subagents", "agent-aaaa1111.meta.json"), JSON.stringify({ agentType: `type ${key}`, description: `desc ${key}`, model: `m ${key}`, toolUseId: "toolu_1", finished: true }));
      await writeFile(join(dir, id, "subagents", "agent-aaaa1111.jsonl"), rec({ type: "user", isSidechain: true, message: { role: "user", content: "x" } }));

      const everything = JSON.stringify({ list: await listSessions(root), session: await getSession(root, id) });
      assert.ok(!everything.includes("sk-ant-"), "a secret reached the API output");
      assert.ok(everything.includes("[redacted]"));
    } finally {
      await rm(root, { recursive: true, force: true });
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
