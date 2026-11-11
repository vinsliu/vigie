import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { clip, parseLine, textOf } from "./text.ts";
import type { SessionDetail, TimelineEvent } from "./types.ts";

const MAX_EVENTS = 2000;
const MAX_TEXT = 1500;

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
export async function readDetail(path: string): Promise<Omit<SessionDetail, "summary">> {
  const events: TimelineEvent[] = [];
  const totals = {
    messages: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let truncated = false;
  const push = (e: TimelineEvent) => {
    if (events.length >= MAX_EVENTS) truncated = true;
    else events.push(e);
  };

  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const r = parseLine(line);
    if (!r || (r.type !== "user" && r.type !== "assistant") || r.isMeta) continue;
    const ts = typeof r.timestamp === "string" ? r.timestamp : null;
    const content = r.message?.content;

    if (r.type === "assistant") {
      totals.messages++;
      const u = r.message?.usage;
      if (u) {
        totals.inputTokens += Number(u.input_tokens) || 0;
        totals.outputTokens += Number(u.output_tokens) || 0;
        totals.cacheReadTokens += Number(u.cache_read_input_tokens) || 0;
        totals.cacheCreationTokens += Number(u.cache_creation_input_tokens) || 0;
      }
      const text = textOf(content);
      if (text) push({ kind: "assistant", ts, text: clip(text, MAX_TEXT) });
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== "tool_use") continue;
          totals.toolCalls++;
          push({ kind: "tool_use", ts, tool: String(b.name ?? "?"), text: clip(describeInput(b.input), 400) });
        }
      }
      continue;
    }

    // user record: either a human prompt or tool results
    if (Array.isArray(content) && content.some((b) => b?.type === "tool_result")) {
      for (const b of content) {
        if (b?.type === "tool_result") push({ kind: "tool_result", ts, text: clip(toolResultText(b.content), 600) });
      }
      continue;
    }
    const text = textOf(content);
    if (text) {
      totals.messages++;
      push({ kind: "user", ts, text: clip(text, MAX_TEXT) });
    }
  }
  return { events, truncated, totals };
}
