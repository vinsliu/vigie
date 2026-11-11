import { readAgentDetail, readAgents } from "./agents.ts";
import { readDetail } from "./detail.ts";
import { resumeCommand } from "./meta.ts";
import { SESSION_ID } from "./paths.ts";
import { findTranscript, summaryOf } from "./scan.ts";
import type { AgentDetail, SessionDetail } from "./types.ts";

export { defaultClaudeDir } from "./paths.ts";
export { listSessions } from "./scan.ts";
export { computeStats } from "./stats.ts";
export { defaultDataDir, parsePatch, pinnedFirst, readMeta, resumeCommand, updateMeta, withMeta } from "./meta.ts";
export type { MetaMap, MetaPatch, SessionMeta } from "./meta.ts";
export type { Stats, Tokens } from "./stats.ts";
export type * from "./types.ts";

export async function getSession(claudeDir: string, id: string): Promise<SessionDetail | null> {
  if (!SESSION_ID.test(id)) return null;
  const file = await findTranscript(claudeDir, id);
  if (!file) return null;
  const [summary, body] = await Promise.all([summaryOf(claudeDir, file), readDetail(file.path)]);
  const agents = await readAgents(file.path, body.spawned);
  return {
    summary,
    events: body.events,
    truncated: body.truncated,
    totals: body.totals,
    agents,
    resumeCommand: resumeCommand(summary.cwd, summary.id),
  };
}

export async function getAgent(claudeDir: string, sessionId: string, agentId: string): Promise<AgentDetail | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  const file = await findTranscript(claudeDir, sessionId);
  return file ? readAgentDetail(file.path, agentId) : null;
}
