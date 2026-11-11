import { redact } from "./redact.ts";

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

function clean(s: string): string {
  return s.replace(REMINDER, "").trim();
}

/** Plain text of a message `content` (string or array of blocks), without injected reminders. */
export function textOf(content: unknown): string {
  if (typeof content === "string") return clean(content);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const b of content) {
    if (b && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return clean(parts.join("\n"));
}

export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** What the UI may show of a transcript text: secrets masked first, then truncated. */
export function display(s: string, max: number): string {
  return clip(redact(s), max);
}

export function parseLine(line: string): Record<string, any> | null {
  if (!line) return null;
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
