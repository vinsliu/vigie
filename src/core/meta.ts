import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { SESSION_ID } from "./paths.ts";
import type { SessionSummary } from "./types.ts";

/**
 * User-owned data (pins, aliases) lives in our own file. Claude's transcripts are never modified.
 */
export interface SessionMeta {
  pinned?: true;
  alias?: string;
  /** Hidden from the default list. Purely a dashboard setting: the transcript stays where it is. */
  archived?: true;
}
export type MetaMap = Record<string, SessionMeta>;
export interface MetaPatch {
  pinned?: boolean;
  alias?: string | null;
  archived?: boolean;
}

const MAX_ALIAS = 120;

export function defaultDataDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "vigie");
}

export async function readMeta(dataDir: string): Promise<MetaMap> {
  try {
    const d = JSON.parse(await readFile(join(dataDir, "meta.json"), "utf8"));
    return d?.sessions && typeof d.sessions === "object" ? d.sessions : {};
  } catch {
    return {}; // missing or corrupt file: start empty
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Apply a patch to one session's metadata. Writes are serialised and atomic (tmp file + rename). */
export function updateMeta(dataDir: string, id: string, patch: MetaPatch): Promise<SessionMeta> {
  if (!SESSION_ID.test(id)) return Promise.reject(new Error("invalid session id"));
  const run = async () => {
    const all = await readMeta(dataDir);
    const cur: SessionMeta = { ...all[id] };
    if (patch.pinned !== undefined) {
      if (patch.pinned) cur.pinned = true;
      else delete cur.pinned;
    }
    if (patch.alias !== undefined) {
      if (patch.alias) cur.alias = patch.alias;
      else delete cur.alias;
    }
    if (patch.archived !== undefined) {
      if (patch.archived) cur.archived = true;
      else delete cur.archived;
    }
    if (Object.keys(cur).length) all[id] = cur;
    else delete all[id];
    // Private folder, and a temporary file that must not exist yet ("wx"): a link planted at a predictable
    // name in a shared folder (--data-dir /tmp/x) can never be followed.
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const file = join(dataDir, "meta.json");
    const tmp = join(dataDir, `.meta.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify({ version: 1, sessions: all }, null, 2), { mode: 0o600, flag: "wx" });
      await rename(tmp, file);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    return cur;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/** Validate an untrusted request body. Returns null when it is not an acceptable patch. */
export function parsePatch(body: unknown): MetaPatch | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const keys = Object.keys(b);
  if (keys.length === 0 || keys.some((k) => k !== "pinned" && k !== "alias" && k !== "archived")) return null;
  const patch: MetaPatch = {};
  if ("pinned" in b) {
    if (typeof b.pinned !== "boolean") return null;
    patch.pinned = b.pinned;
  }
  if ("archived" in b) {
    if (typeof b.archived !== "boolean") return null;
    patch.archived = b.archived;
  }
  if ("alias" in b) {
    if (b.alias === null) patch.alias = null;
    else if (typeof b.alias === "string") {
      // Control characters, and the invisible or direction-changing ones that make a name read differently from what it says.
      const a = b.alias.replace(INVISIBLE, " ").trim().slice(0, MAX_ALIAS);
      patch.alias = a || null;
    } else return null;
  }
  return patch;
}

export function withMeta<T extends SessionSummary>(s: T, meta: MetaMap): T {
  const m = meta[s.id];
  return { ...s, pinned: m?.pinned === true, alias: m?.alias ?? null, archived: m?.archived === true };
}

/** Pinned sessions first; otherwise keep the incoming (most recent first) order. */
export function pinnedFirst<T extends SessionSummary>(list: T[]): T[] {
  return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned));
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// C0/C1 controls, zero-width and bidirectional marks, line and paragraph separators, byte order mark.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const MAX_CWD = 1024;

/**
 * Command to resume a session from a POSIX shell. It must run from the session's own folder, since
 * Claude resolves sessions per project. We only ever build the text: nothing is executed here.
 */
export function resumeCommand(cwd: string | null, id: string): string | null {
  if (!cwd || !SESSION_ID.test(id)) return null;
  // Quoting makes the folder name inert, but a control character (a newline, Ctrl-C, an escape sequence) would
  // still travel to the user's terminal when they paste the command. Such a path gets no command at all.
  if (cwd.length > MAX_CWD || CONTROL.test(cwd)) return null;
  return `cd ${shellQuote(cwd)} && claude --resume ${id}`;
}
