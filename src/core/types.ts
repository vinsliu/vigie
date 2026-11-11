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
  /** Number of sub-agents spawned by this session (all depths). */
  agents: number;
}

export type TimelineKind = "user" | "assistant" | "tool_use" | "tool_result";

export interface TimelineEvent {
  kind: TimelineKind;
  ts: string | null;
  text: string;
  tool?: string;
}

export interface DetailTotals {
  messages: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface AgentNode {
  id: string;
  /** `Explore`, `general-purpose`, … as recorded by Claude. */
  type: string;
  description: string;
  model: string | null;
  finished: boolean;
  /** 1 for agents spawned by the session itself, 2 for agents spawned by those, … */
  depth: number;
  /** Id of the `Agent` tool call (in the parent transcript) that spawned it. */
  toolUseId: string | null;
  parentAgentId: string | null;
  startedAt: string | null;
  totals: DetailTotals;
}

export interface SessionDetail {
  summary: SessionSummary;
  events: TimelineEvent[];
  truncated: boolean;
  totals: DetailTotals;
  /** Sub-agents in tree order (parent before its children). */
  agents: AgentNode[];
}

export interface AgentDetail {
  agent: AgentNode;
  events: TimelineEvent[];
  truncated: boolean;
}
