import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { countAgents } from "./agents.ts";
import { remember } from "./cache.ts";
import { readLines } from "./lines.ts";
import { liveSessions } from "./live.ts";
import { display, parseLine, textOf } from "./text.ts";
import type { Rec, SessionSummary } from "./types.ts";

const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 512 * 1024;
const CONCURRENCY = 16;

async function readRange(path: string, start: number, length: number): Promise<string> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    await fh.close();
  }
}

function records(text: string, dropFirst: boolean, dropLast: boolean): Rec[] {
  const lines = text.split("\n");
  if (dropFirst) lines.shift();
  if (dropLast) lines.pop();
  const out: Rec[] = [];
  for (const l of lines) {
    const r = parseLine(l);
    if (r) out.push(r);
  }
  return out;
}

/** Last `cost-state` of a transcript, found by streaming it entirely (fallback only). */
async function costByStreaming(path: string): Promise<number | null> {
  let cost: number | null = null;
  for await (const line of readLines(path)) {
    if (!line.includes('"cost-state"')) continue;
    const r = parseLine(line);
    if (r?.type === "cost-state" && typeof r.totalCostUSD === "number") cost = r.totalCostUSD;
  }
  return cost;
}

/** Summarise one transcript by reading only its head and tail. */
export async function summarize(
  path: string,
  projectDir: string,
): Promise<Omit<SessionSummary, "active" | "pid" | "agents" | "pinned" | "alias" | "archived">> {
  const st = await stat(path);
  const id = path.slice(path.lastIndexOf("/") + 1).replace(/\.jsonl$/, "");
  const size = st.size;

  const head = records(await readRange(path, 0, Math.min(size, HEAD_BYTES)), false, size > HEAD_BYTES);
  const tailStart = Math.max(0, size - TAIL_BYTES);
  const tail =
    tailStart === 0 ? [] : records(await readRange(path, tailStart, size - tailStart), true, false);

  let cwd: string | null = null;
  let entrypoint: string | null = null;
  let version: string | null = null;
  let startedAt: string | null = null;
  let firstPrompt: string | null = null;
  let title: string | null = null;
  let agentName: string | null = null;
  let lastPrompt: string | null = null;
  let model: string | null = null;
  let cost: number | null = null;

  for (const r of head) {
    cwd ??= typeof r.cwd === "string" ? r.cwd : null;
    entrypoint ??= typeof r.entrypoint === "string" ? display(r.entrypoint, 60) : null;
    version ??= typeof r.version === "string" ? display(r.version, 40) : null;
    startedAt ??= typeof r.timestamp === "string" ? r.timestamp : null;
    if (firstPrompt === null && r.type === "user" && !r.isMeta) {
      const t = textOf(r.message?.content);
      if (t) firstPrompt = display(t, 300);
    }
  }
  // Later records win: they reflect the latest title, prompt, model and cost.
  for (const r of [...head, ...tail]) {
    if (r.type === "custom-title" && r.customTitle) title = display(String(r.customTitle), 200);
    else if (r.type === "agent-name" && r.agentName) agentName = display(String(r.agentName), 200);
    else if (r.type === "last-prompt" && typeof r.lastPrompt === "string") lastPrompt = display(r.lastPrompt, 300);
    else if (r.type === "cost-state" && typeof r.totalCostUSD === "number") cost = r.totalCostUSD;
    else if (r.type === "assistant" && typeof r.message?.model === "string") model = display(r.message.model, 80);
    version = typeof r.version === "string" ? display(r.version, 40) : version;
  }
  if (cost === null && tailStart > 0) cost = await costByStreaming(path);

  return {
    id,
    projectDir,
    cwd,
    title: title ?? agentName,
    firstPrompt,
    lastPrompt,
    entrypoint,
    model,
    version,
    startedAt,
    updatedAt: st.mtime.toISOString(),
    costUSD: cost,
    sizeBytes: size,
  };
}

type CacheEntry = { mtimeMs: number; size: number; value: Awaited<ReturnType<typeof summarize>> };
const cache = new Map<string, CacheEntry>();
const MAX_CACHED_SUMMARIES = 5000;

async function cachedSummarize(path: string, projectDir: string) {
  const st = await stat(path);
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
  const value = await summarize(path, projectDir);
  remember(cache, path, { mtimeMs: st.mtimeMs, size: st.size, value }, MAX_CACHED_SUMMARIES);
  return value;
}

export async function listTranscripts(claudeDir: string): Promise<{ path: string; projectDir: string }[]> {
  const root = join(claudeDir, "projects");
  // Symbolic links are skipped: only real project folders and real transcript files are read.
  let dirs: string[];
  try {
    dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: { path: string; projectDir: string }[] = [];
  await Promise.all(
    dirs.map(async (d) => {
      try {
        for (const f of await readdir(join(root, d), { withFileTypes: true })) {
          if (f.isFile() && f.name.endsWith(".jsonl")) out.push({ path: join(root, d, f.name), projectDir: d });
        }
      } catch {
        /* unreadable folder */
      }
    }),
  );
  return out;
}

export async function listSessions(claudeDir: string): Promise<SessionSummary[]> {
  const [files, live] = await Promise.all([listTranscripts(claudeDir), liveSessions(claudeDir)]);
  const out: SessionSummary[] = [];
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const done = await Promise.all(
      batch.map(async (f) => {
        try {
          return await cachedSummarize(f.path, f.projectDir);
        } catch {
          return null; // file vanished or unreadable
        }
      }),
    );
    for (const s of done) {
      if (!s) continue;
      const l = live.get(s.id);
      out.push({
        ...s,
        entrypoint: s.entrypoint ?? l?.entrypoint ?? null,
        active: Boolean(l),
        pid: l?.pid ?? null,
        agents: await countAgents(join(claudeDir, "projects", s.projectDir, `${s.id}.jsonl`)),
        pinned: false,
        alias: null,
        archived: false,
      });
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function summaryOf(
  claudeDir: string,
  file: { path: string; projectDir: string },
): Promise<SessionSummary> {
  const [s, live] = await Promise.all([cachedSummarize(file.path, file.projectDir), liveSessions(claudeDir)]);
  const l = live.get(s.id);
  return {
    ...s,
    entrypoint: s.entrypoint ?? l?.entrypoint ?? null,
    active: Boolean(l),
    pid: l?.pid ?? null,
    agents: await countAgents(file.path),
    pinned: false,
    alias: null,
    archived: false,
  };
}

export async function findTranscript(
  claudeDir: string,
  id: string,
): Promise<{ path: string; projectDir: string } | null> {
  for (const f of await listTranscripts(claudeDir)) {
    if (f.path.endsWith(`/${id}.jsonl`)) return f;
  }
  return null;
}
