/** A raw JSONL record. The format is undocumented, so every field is optional. */
export type Rec = { [key: string]: any };

export interface SessionSummary {
  id: string;
  /** Encoded project folder name inside `projects/`. */
  projectDir: string;
  cwd: string | null;
  title: string | null;
  firstPrompt: string | null;
  lastPrompt: string | null;
  /** `claude-desktop`, `cli`, `claude-vscode`… as written by the client. */
  entrypoint: string | null;
  model: string | null;
  version: string | null;
  startedAt: string | null;
  updatedAt: string;
  costUSD: number | null;
  sizeBytes: number;
  active: boolean;
  pid: number | null;
}

export type TimelineKind = "user" | "assistant" | "tool_use" | "tool_result";

export interface TimelineEvent {
  kind: TimelineKind;
  ts: string | null;
  text: string;
  tool?: string;
}

export interface SessionDetail {
  summary: SessionSummary;
  events: TimelineEvent[];
  truncated: boolean;
  totals: {
    messages: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
}
