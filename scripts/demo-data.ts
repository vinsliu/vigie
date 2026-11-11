// Generates a made-up Claude directory, so Vigie can be shown (screenshots, demos, bug reports)
// without exposing real sessions. Nothing here reads ~/.claude. All names, prompts and costs are invented.
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DAY = 86_400_000;
const MIN = 60_000;

// Illustrative per-million-token prices. They only need to be plausible, not exact.
const PRICES: Record<string, [input: number, output: number, cacheRead: number, cacheWrite: number]> = {
  "claude-opus-5-5": [15, 75, 1.5, 18.75],
  "claude-sonnet-5-5": [3, 15, 0.3, 3.75],
  "claude-haiku-5-5": [0.8, 4, 0.08, 1],
};

type Tool = [name: string, input: Record<string, unknown>, result: string];
interface Step {
  say?: string;
  tool?: Tool;
  /** Spawns a sub-agent (index into `agents`). */
  agent?: number;
}
interface AgentSpec {
  type: string;
  description: string;
  model: string;
  alias: string;
  steps: Step[];
  /** Index of the agent that spawned this one; absent when the main session did. */
  parent?: number;
}
interface SessionSpec {
  id: string;
  project: string;
  entrypoint: "claude-desktop" | "cli" | "claude-vscode";
  model: string;
  title?: string;
  prompt: string;
  daysAgo: number;
  /** Days the session spans (turns are spread over them). */
  span?: number;
  steps: Step[];
  agents?: AgentSpec[];
  pinned?: boolean;
  archived?: boolean;
  alias?: string;
  /** Marks the session as running, owned by the given pid. */
  activePid?: number;
}

function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Built at runtime so that no secret scanner flags this file: it only exists to show the masking.
const FAKE_STRIPE_KEY = "sk_" + "live_" + "51Hx9DemoOnlyNotARealKey000";
const FAKE_DB_URL = "postgres://shop:" + "s3cretPass99" + "@db.internal:5432/shop";

function sessions(activePid: number): SessionSpec[] {
  return [
    {
      id: "a1b2c3d4-0001-4000-8000-000000000001",
      project: "/Users/demo/code/shop-api",
      entrypoint: "cli",
      model: "claude-opus-5-5",
      title: "Rate limiting on checkout",
      prompt: "Add rate limiting to the checkout endpoint: 10 requests per minute per IP, return 429 with a Retry-After header.",
      daysAgo: 0,
      activePid,
      steps: [
        { say: "I'll start by looking at how the checkout route is wired and which middleware already exists." },
        { tool: ["Grep", { pattern: "router.post\\(.checkout" }, "src/routes/checkout.ts:14:router.post('/checkout', requireAuth, createOrder)"] },
        { tool: ["Read", { file_path: "/Users/demo/code/shop-api/src/routes/checkout.ts" }, "import { Router } from 'express';\nimport { requireAuth } from '../auth';\n// ..."] },
        { tool: ["Bash", { command: "cat .env.example" }, `DATABASE_URL=${FAKE_DB_URL}\nSTRIPE_SECRET_KEY=${FAKE_STRIPE_KEY}\nPORT=3000`] },
        { say: "There is no limiter yet. I'll add a small in-memory sliding window and keep it behind an interface so Redis can replace it later." },
        { tool: ["Write", { file_path: "/Users/demo/code/shop-api/src/middleware/rate-limit.ts", content: "..." }, "File created"] },
        { tool: ["Edit", { file_path: "/Users/demo/code/shop-api/src/routes/checkout.ts" }, "Edited: added rateLimit(10, 60_000)"] },
        { tool: ["Bash", { command: "npm test -- checkout" }, "PASS  src/routes/checkout.test.ts\n  ✓ returns 429 after 10 requests (41 ms)\n\nTests: 12 passed, 12 total"] },
        { say: "Checkout is now limited to 10 requests per minute per IP and answers 429 with Retry-After. I added tests for the limit and the reset." },
      ],
    },
    {
      id: "a1b2c3d4-0002-4000-8000-000000000002",
      project: "/Users/demo/code/shop-api",
      entrypoint: "claude-desktop",
      model: "claude-sonnet-5-5",
      title: "Webhook signature test",
      prompt: "The Stripe webhook signature test fails on CI but passes locally. Find out why.",
      daysAgo: 1,
      steps: [
        { say: "Let me run the test the way CI does." },
        { tool: ["Bash", { command: "CI=true npm test -- webhook" }, "FAIL  src/webhooks/stripe.test.ts\n  ✕ rejects an invalid signature\n  Expected: 400\n  Received: 200"] },
        { tool: ["Read", { file_path: "/Users/demo/code/shop-api/src/webhooks/stripe.ts" }, "export function verify(req) {\n  if (process.env.NODE_ENV === 'test') return true;\n  // ..."] },
        { say: "The handler skips verification when NODE_ENV is 'test', and CI sets it while the local runner does not. I'll remove the bypass and inject a test secret instead." },
        { tool: ["Edit", { file_path: "/Users/demo/code/shop-api/src/webhooks/stripe.ts" }, "Edited"] },
        { tool: ["Bash", { command: "CI=true npm test -- webhook" }, "PASS  src/webhooks/stripe.test.ts\nTests: 4 passed, 4 total"] },
        { say: "Fixed: the test environment bypassed signature checks, which only CI exercised." },
      ],
    },
    {
      id: "a1b2c3d4-0003-4000-8000-000000000003",
      project: "/Users/demo/code/blog",
      entrypoint: "claude-vscode",
      model: "claude-sonnet-5-5",
      title: "Migrate posts to MDX",
      prompt: "Migrate the blog from Markdown to MDX and keep the URLs unchanged.",
      daysAgo: 2,
      span: 2,
      pinned: true,
      alias: "Blog → MDX migration",
      agents: [
        {
          type: "Explore",
          description: "List posts and shared components",
          model: "claude-haiku-5-5",
          alias: "haiku",
          steps: [
            { tool: ["Glob", { pattern: "content/posts/**/*.md" }, "content/posts/hello.md\ncontent/posts/rss.md\n... (42 files)"] },
            { say: "42 posts, 3 use raw HTML blocks that need a component." },
          ],
        },
        {
          type: "general-purpose",
          description: "Check frontmatter of each post",
          model: "claude-haiku-5-5",
          alias: "haiku",
          parent: 0,
          steps: [{ tool: ["Bash", { command: "grep -L '^date:' content/posts/*.md" }, "content/posts/draft-ideas.md"] }, { say: "One post has no date." }],
        },
      ],
      steps: [
        { say: "I'll map the existing content first, then convert in small batches." },
        { agent: 0 },
        { tool: ["Bash", { command: "npm install @next/mdx @mdx-js/loader" }, "added 38 packages in 6s"] },
        { tool: ["Edit", { file_path: "/Users/demo/code/blog/next.config.mjs" }, "Edited"] },
        { say: "Config done. Converting the first batch of 10 posts and checking the generated routes." },
        { tool: ["Bash", { command: "npm run build" }, "Route (app)\n├ ○ /posts/hello\n├ ○ /posts/rss\n✓ Compiled successfully"] },
        { say: "URLs are unchanged. 32 posts remain; the three with raw HTML need the <Callout> component." },
      ],
    },
    {
      id: "a1b2c3d4-0004-4000-8000-000000000004",
      project: "/Users/demo/code/blog",
      entrypoint: "cli",
      model: "claude-haiku-5-5",
      prompt: "Write alt text for every image in content/posts that has none.",
      daysAgo: 3,
      steps: [
        { tool: ["Grep", { pattern: "!\\[\\]\\(" }, "content/posts/hello.md:12:![](/img/desk.jpg)\n... (9 matches)"] },
        { say: "Nine images have no alt text. Describing each from its file name and surrounding paragraph." },
        { tool: ["Edit", { file_path: "/Users/demo/code/blog/content/posts/hello.md" }, "Edited"] },
        { say: "Done: 9 images now have a short, descriptive alt text." },
      ],
    },
    {
      id: "a1b2c3d4-0005-4000-8000-000000000005",
      project: "/Users/demo/code/design-system",
      entrypoint: "claude-desktop",
      model: "claude-opus-5-5",
      title: "Button contrast audit",
      prompt: "Audit the color contrast of every Button variant against WCAG AA, light and dark.",
      daysAgo: 5,
      span: 2,
      steps: [
        { say: "I'll extract each variant's foreground and background tokens and compute the contrast ratios." },
        { tool: ["Read", { file_path: "/Users/demo/code/design-system/src/Button/Button.css" }, ".btn-primary { background: var(--blue-600); color: #fff; }\n..."] },
        { tool: ["Bash", { command: "node scripts/contrast.mjs" }, "primary      light 5.9  AA ✓   dark 4.2  AA ✗\nsecondary    light 4.6  AA ✓   dark 7.1  AA ✓\nghost        light 3.1  AA ✗   dark 5.0  AA ✓"] },
        { say: "Two failures: primary in dark mode (4.2) and ghost in light mode (3.1). Darkening --gray-500 by one step fixes the ghost button." },
        { tool: ["Edit", { file_path: "/Users/demo/code/design-system/src/tokens.css" }, "Edited"] },
        { say: "All variants now pass AA in both themes. I left a table of the ratios in docs/contrast.md." },
      ],
    },
    {
      id: "a1b2c3d4-0006-4000-8000-000000000006",
      project: "/Users/demo/code/design-system",
      entrypoint: "cli",
      model: "claude-sonnet-5-5",
      title: "Tooltip → popover API",
      prompt: "Convert the Tooltip component to the native popover API and drop the positioning library.",
      daysAgo: 7,
      steps: [
        { tool: ["Read", { file_path: "/Users/demo/code/design-system/src/Tooltip/Tooltip.tsx" }, "import { computePosition } from '@floating-ui/dom';\n// ..."] },
        { say: "The native popover plus CSS anchor positioning covers our cases. Keeping a fallback for older browsers." },
        { tool: ["Write", { file_path: "/Users/demo/code/design-system/src/Tooltip/Tooltip.tsx", content: "..." }, "File created"] },
        { tool: ["Bash", { command: "npm test -- Tooltip" }, "Tests: 9 passed, 9 total"] },
        { say: "Tooltip now uses the popover API; the bundle is 6 kB smaller." },
      ],
    },
    {
      id: "a1b2c3d4-0007-4000-8000-000000000007",
      project: "/Users/demo/code/shop-api",
      entrypoint: "claude-vscode",
      model: "claude-sonnet-5-5",
      prompt: "Explain the order state machine and where a refund can happen.",
      daysAgo: 9,
      steps: [
        { tool: ["Read", { file_path: "/Users/demo/code/shop-api/src/orders/machine.ts" }, "const transitions = {\n  pending: ['paid', 'cancelled'],\n  paid: ['shipped', 'refunded'],\n  // ..."] },
        { say: "An order goes pending → paid → shipped → delivered. A refund is possible from paid and delivered (within 30 days); shipped orders must be returned first." },
      ],
    },
    {
      id: "a1b2c3d4-0008-4000-8000-000000000008",
      project: "/Users/demo/code/blog",
      entrypoint: "claude-desktop",
      model: "claude-sonnet-5-5",
      title: "RSS feed",
      prompt: "Add an RSS feed with the latest 20 posts.",
      daysAgo: 12,
      archived: true,
      steps: [
        { tool: ["Write", { file_path: "/Users/demo/code/blog/app/rss.xml/route.ts", content: "..." }, "File created"] },
        { say: "The feed is served at /rss.xml with the 20 latest posts." },
      ],
    },
  ];
}

interface Tally {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

function cost(model: string, t: Tally): number {
  const [i, o, cr, cw] = PRICES[model] ?? PRICES["claude-sonnet-5-5"]!;
  return (t.input * i + t.output * o + t.cacheRead * cr + t.cacheCreation * cw) / 1_000_000;
}

/** Writes the whole demo tree under `dir` and returns the directories to point Vigie at. */
export async function generateDemo(dir: string, opts: { now?: number; pid?: number } = {}) {
  const now = opts.now ?? Date.now();
  const claudeDir = join(dir, "claude");
  const dataDir = join(dir, "data");
  await mkdir(join(claudeDir, "sessions"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const meta: Record<string, { pinned?: boolean; alias?: string; archived?: boolean }> = {};
  let n = 0;

  for (const [index, s] of sessions(opts.pid ?? process.pid).entries()) {
    const rand = rng(1000 + index);
    const projectDir = join(claudeDir, "projects", s.project.replace(/\//g, "-"));
    await mkdir(projectDir, { recursive: true });
    const lines: unknown[] = [];
    const span = (s.span ?? 0) * DAY;
    const start = now - s.daysAgo * DAY - span - (s.daysAgo === 0 ? 20 * MIN : 3 * 60 * MIN);
    let clock = start;
    const tick = (stepIndex: number, total: number) => {
      // Spread the turns over the span, with a few minutes of jitter.
      clock = start + (total > 1 ? (span * stepIndex) / (total - 1) : 0) + stepIndex * (2 + rand() * 3) * MIN;
      return new Date(clock).toISOString();
    };
    const base = { cwd: s.project, sessionId: s.id, version: "2.1.321", entrypoint: s.entrypoint };
    const tally: Record<string, Tally> = {};
    const add = (model: string, u: Tally) => {
      const t = (tally[model] ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
      t.input += u.input;
      t.output += u.output;
      t.cacheRead += u.cacheRead;
      t.cacheCreation += u.cacheCreation;
    };
    const usage = (model: string, heavy: boolean): { usage: Record<string, number>; tally: Tally } => {
      const t: Tally = {
        input: 2 + Math.floor(rand() * 40),
        output: (heavy ? 600 : 120) + Math.floor(rand() * (heavy ? 1400 : 500)),
        cacheRead: 15_000 + Math.floor(rand() * 90_000),
        cacheCreation: 800 + Math.floor(rand() * 9_000),
      };
      return {
        usage: {
          input_tokens: t.input,
          output_tokens: t.output,
          cache_read_input_tokens: t.cacheRead,
          cache_creation_input_tokens: t.cacheCreation,
        },
        tally: t,
      };
    };

    lines.push({ type: "user", message: { role: "user", content: s.prompt }, uuid: `u-${index}-0`, timestamp: new Date(start).toISOString(), ...base });

    const agentToolIds = (s.agents ?? []).map((_, i) => `toolu_${index}_agent${i}`);
    const emit = (sink: unknown[], steps: Step[], model: string, extra: Record<string, unknown>, tag: string, count: boolean) => {
      steps.forEach((step, i) => {
        const ts = tick(i + 1, steps.length + 1);
        const heavy = Boolean(step.say) && step.say!.length > 100;
        const { usage: u, tally: t } = usage(model, heavy);
        const mid = `msg_${tag}_${i}`;
        if (count) add(model, t);
        const blocks: unknown[][] = [];
        if (step.say) blocks.push([{ type: "text", text: step.say }]);
        if (step.tool) blocks.push([{ type: "tool_use", id: `toolu_${tag}_${i}`, name: step.tool[0], input: step.tool[1] }]);
        if (step.agent !== undefined) {
          const a = s.agents![step.agent]!;
          blocks.push([
            { type: "tool_use", id: agentToolIds[step.agent], name: "Agent", input: { description: a.description, subagent_type: a.type, prompt: a.description } },
          ]);
        }
        // Claude writes one record per content block, all sharing the message id and usage.
        blocks.forEach((content, b) => {
          sink.push({ type: "assistant", message: { id: mid, model, role: "assistant", content, usage: u }, uuid: `a-${tag}-${i}-${b}`, timestamp: ts, ...extra });
        });
        if (step.tool) {
          sink.push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_${tag}_${i}`, content: step.tool[2] }] }, uuid: `r-${tag}-${i}`, timestamp: ts, ...extra });
        }
      });
    };

    // Sub-agents first, so the main timeline can reference them by tool id.
    const agentFiles: Array<{ id: string; spec: AgentSpec; lines: unknown[] }> = [];
    for (const [i, a] of (s.agents ?? []).entries()) {
      const agentId = `${index}${String.fromCharCode(97 + i)}0demo${i}`.padEnd(8, "0");
      const out: unknown[] = [];
      const extra = { isSidechain: true, agentId, ...base };
      out.push({ type: "user", message: { role: "user", content: a.description }, uuid: `s-${index}-${i}`, timestamp: new Date(start + 5 * MIN).toISOString(), ...extra });
      emit(out, a.steps, a.model, extra, `${index}x${i}`, false);
      agentFiles.push({ id: agentId, spec: a, lines: out });
    }

    emit(lines, s.steps, s.model, { isSidechain: false, ...base }, `${index}m`, true);

    // Sub-agent tokens are not part of the session's own cost-state in this demo.
    if (s.title) lines.push({ type: "custom-title", customTitle: s.title, sessionId: s.id });
    lines.push({ type: "last-prompt", lastPrompt: s.prompt, sessionId: s.id });
    const modelUsage: Record<string, unknown> = {};
    let total = 0;
    for (const [model, t] of Object.entries(tally)) {
      const c = cost(model, t);
      total += c;
      modelUsage[model] = {
        inputTokens: t.input,
        outputTokens: t.output,
        cacheReadInputTokens: t.cacheRead,
        cacheCreationInputTokens: t.cacheCreation,
        costUSD: Number(c.toFixed(4)),
      };
    }
    lines.push({ type: "cost-state", sessionId: s.id, totalCostUSD: Number(total.toFixed(4)), modelUsage });

    await writeFile(join(projectDir, `${s.id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    // "Last activity" comes from the file time: make it match the last message, not the generation time.
    await utimes(join(projectDir, `${s.id}.jsonl`), new Date(clock), new Date(clock));

    if (agentFiles.length) {
      const subDir = join(projectDir, s.id, "subagents");
      await mkdir(subDir, { recursive: true });
      for (const [i, f] of agentFiles.entries()) {
        const parentIdx = f.spec.parent;
        // A nested agent is spawned from inside its parent's transcript.
        if (parentIdx !== undefined) {
          const parent = agentFiles[parentIdx]!;
          parent.lines.push({
            type: "assistant",
            message: { id: `msg_nest_${i}`, model: parent.spec.model, role: "assistant", content: [{ type: "tool_use", id: agentToolIds[i], name: "Agent", input: { description: f.spec.description, subagent_type: f.spec.type, prompt: f.spec.description } }], usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 9000, cache_creation_input_tokens: 600 } },
            uuid: `nest-${i}`,
            timestamp: new Date(start + 6 * MIN).toISOString(),
            isSidechain: true,
            agentId: parent.id,
            ...base,
          });
        }
      }
      for (const [i, f] of agentFiles.entries()) {
        await writeFile(join(subDir, `agent-${f.id}.jsonl`), f.lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
        await writeFile(
          join(subDir, `agent-${f.id}.meta.json`),
          JSON.stringify({ agentType: f.spec.type, description: f.spec.description, toolUseId: agentToolIds[i], spawnDepth: f.spec.parent === undefined ? 1 : 2, model: f.spec.alias, finished: true }),
        );
      }
    }

    if (s.activePid !== undefined) {
      await writeFile(join(claudeDir, "sessions", `${s.activePid}.json`), JSON.stringify({ pid: s.activePid, sessionId: s.id, cwd: s.project, kind: "interactive", entrypoint: s.entrypoint }));
    }
    if (s.pinned || s.archived || s.alias) meta[s.id] = { ...(s.pinned && { pinned: true }), ...(s.archived && { archived: true }), ...(s.alias && { alias: s.alias }) };
    n++;
  }

  await writeFile(join(dataDir, "meta.json"), JSON.stringify({ version: 1, sessions: meta }, null, 2));
  return { claudeDir, dataDir, sessions: n };
}
