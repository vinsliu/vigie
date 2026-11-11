import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { display, parseLine, textOf } from "./text.ts";
import type { DetailTotals, TimelineEvent } from "./types.ts";

const MAX_EVENTS = 2000;
const MAX_TEXT = 1500;

/** Tool names under which Claude spawns a sub-agent (`Task` in older versions). */
const SPAWN_TOOLS = new Set(["Agent", "Task"]);

export interface DetailBody {
  events: TimelineEvent[];
  truncated: boolean;
  totals: DetailTotals;
  /** Ids of the tool calls in this transcript that spawned a sub-agent. */
  spawned: string[];
  startedAt: string | null;
  model: string | null;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  return textOf(content);
}

function describeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.description ?? o.query;
  return typeof pick === "string" ? pick : JSON.stringify(o);
}

/** Stream a full transcript into a bounded timeline plus token totals. */
export async function readDetail(path: string, opts: { events?: boolean } = {}): Promise<DetailBody> {
  const wantEvents = opts.events !== false;
  const events: TimelineEvent[] = [];
  const spawned: string[] = [];
  const totals: DetailTotals = {
    messages: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  const seen = new Set<string>();
  let truncated = false;
  let startedAt: string | null = null;
  let model: string | null = null;
  const push = (e: TimelineEvent) => {
    if (!wantEvents) return;
    if (events.length >= MAX_EVENTS) truncated = true;
    else events.push(e);
  };

  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const r = parseLine(line);
    if (!r || (r.type !== "user" && r.type !== "assistant") || r.isMeta) continue;
    const ts = typeof r.timestamp === "string" ? r.timestamp : null;
    startedAt ??= ts;
    const content = r.message?.content;

    if (r.type === "assistant") {
      if (typeof r.message?.model === "string") model = display(r.message.model, 80);
      // One API message is written once per content block with the same id and usage:
      // count messages and tokens once per id.
      const mid = r.message?.id;
      const firstOfMessage = typeof mid !== "string" || !seen.has(mid);
      if (typeof mid === "string") seen.add(mid);
      if (firstOfMessage) {
        totals.messages++;
        const u = r.message?.usage;
        if (u) {
          totals.inputTokens += Number(u.input_tokens) || 0;
          totals.outputTokens += Number(u.output_tokens) || 0;
          totals.cacheReadTokens += Number(u.cache_read_input_tokens) || 0;
          totals.cacheCreationTokens += Number(u.cache_creation_input_tokens) || 0;
        }
      }
      const text = textOf(content);
      if (text) push({ kind: "assistant", ts, text: display(text, MAX_TEXT) });
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== "tool_use") continue;
          totals.toolCalls++;
          if (SPAWN_TOOLS.has(b.name) && typeof b.id === "string") spawned.push(b.id);
          push({ kind: "tool_use", ts, tool: display(String(b.name ?? "?"), 80), text: display(describeInput(b.input), 400) });
        }
      }
      continue;
    }

    // user record: either a human prompt or tool results
    if (Array.isArray(content) && content.some((b) => b?.type === "tool_result")) {
      for (const b of content) {
        if (b?.type === "tool_result") push({ kind: "tool_result", ts, text: display(toolResultText(b.content), 600) });
      }
      continue;
    }
    const text = textOf(content);
    if (text) {
      totals.messages++;
      push({ kind: "user", ts, text: display(text, MAX_TEXT) });
    }
  }
  return { events, truncated, totals, spawned, startedAt, model };
}
