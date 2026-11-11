import { readDetail } from "./detail.ts";
import { SESSION_ID } from "./paths.ts";
import { findTranscript, summaryOf } from "./scan.ts";
import type { SessionDetail } from "./types.ts";

export { defaultClaudeDir } from "./paths.ts";
export { listSessions } from "./scan.ts";
export { computeStats } from "./stats.ts";
export type { Stats, Tokens } from "./stats.ts";
export type * from "./types.ts";

export async function getSession(claudeDir: string, id: string): Promise<SessionDetail | null> {
  if (!SESSION_ID.test(id)) return null;
  const file = await findTranscript(claudeDir, id);
  if (!file) return null;
  const [summary, detail] = await Promise.all([summaryOf(claudeDir, file), readDetail(file.path)]);
  return { summary, ...detail };
}
