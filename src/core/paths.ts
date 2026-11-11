import { homedir } from "node:os";
import { join } from "node:path";

export function defaultClaudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Session ids are UUIDs; anything else must never reach the filesystem. */
export const SESSION_ID = /^[0-9a-f][0-9a-f-]{7,63}$/i;
