import { stat } from "node:fs/promises";
import { remember } from "./cache.ts";
import { readLines } from "./lines.ts";
import { display, parseLine, textOf } from "./text.ts";
import type { DetailTotals, TimelineEvent } from "./types.ts";

const MAX_EVENTS = 2000;
const MAX_TEXT = 1500;

/** Tool names under which Claude spawns a sub-agent (`Task` in older versions). */
const SPAWN_TOOLS = new Set(["Agent", "Task"]);

export interface DetailBody {
  /** The most recent events (at most MAX_EVENTS), oldest first. */
  events: TimelineEvent[];
  truncated: boolean;
  /** How many earlier events were left out. */
  omitted: number;
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
  if (typeof pick === "string") return pick;
  try {
    return JSON.stringify(o);
  } catch {
    return "[input too deeply nested to show]"; // JSON.stringify throws on hostile nesting; the session must still open
  }
}

/** Stream a full transcript into a bounded timeline (its latest events) plus token totals. */
async function parseDetail(path: string, opts: { events?: boolean } = {}): Promise<DetailBody> {
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
  let omitted = 0;
  let startedAt: string | null = null;
  let model: string | null = null;
  const push = (e: TimelineEvent) => {
    if (!wantEvents) return;
    events.push(e);
    // Keep the latest events: drop the oldest in batches, so a long transcript costs O(n), not O(n * MAX_EVENTS).
    if (events.length >= MAX_EVENTS * 2) omitted += events.splice(0, events.length - MAX_EVENTS).length;
  };

  for await (const line of readLines(path)) {
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
  if (events.length > MAX_EVENTS) omitted += events.splice(0, events.length - MAX_EVENTS).length;
  return { events, truncated: omitted > 0, omitted, totals, spawned, startedAt, model };
}

type Cached = { mtimeMs: number; size: number; body: DetailBody };
const withEvents = new Map<string, Cached>();
const withoutEvents = new Map<string, Cached>();
// A timeline can weigh a few megabytes; the counts-only reads of sub-agents are tiny.
const MAX_CACHED_TIMELINES = 16;
const MAX_CACHED_COUNTS = 500;

/**
 * Like parseDetail, but a transcript that has not changed (same size and modification time) is not read again.
 * The result is shared between callers: it must not be modified.
 */
export async function readDetail(path: string, opts: { events?: boolean } = {}): Promise<DetailBody> {
  const wantEvents = opts.events !== false;
  const cache = wantEvents ? withEvents : withoutEvents;
  const st = await stat(path);
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.body;
  const body = await parseDetail(path, opts);
  remember(cache, path, { mtimeMs: st.mtimeMs, size: st.size, body }, wantEvents ? MAX_CACHED_TIMELINES : MAX_CACHED_COUNTS);
  return body;
}
