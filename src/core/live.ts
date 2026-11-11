import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface LiveInfo {
  pid: number;
  kind: string | null;
  entrypoint: string | null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Running Claude processes, keyed by session id, from `<claudeDir>/sessions/*.json`. */
export async function liveSessions(claudeDir: string): Promise<Map<string, LiveInfo>> {
  const dir = join(claudeDir, "sessions");
  const out = new Map<string, LiveInfo>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (n) => {
        try {
          const d = JSON.parse(await readFile(join(dir, n), "utf8"));
          if (typeof d.sessionId !== "string" || !Number.isInteger(d.pid)) return;
          if (!isAlive(d.pid)) return;
          out.set(d.sessionId, {
            pid: d.pid,
            kind: typeof d.kind === "string" ? d.kind : null,
            entrypoint: typeof d.entrypoint === "string" ? d.entrypoint : null,
          });
        } catch {
          /* unreadable or half-written file: ignore */
        }
      }),
  );
  return out;
}
