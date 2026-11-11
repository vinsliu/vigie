import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readDetail, type DetailBody } from "./detail.ts";
import type { AgentDetail, AgentNode } from "./types.ts";
import { redact } from "./redact.ts";

/** Agent ids are short alphanumeric tokens; anything else must never reach the filesystem. */
export const AGENT_ID = /^[0-9a-z]{6,64}$/i;

const META = /^agent-(.+)\.meta\.json$/;

/** `<projectDir>/<sessionId>.jsonl` → `<projectDir>/<sessionId>/subagents` */
const agentsDir = (transcript: string) => `${transcript.replace(/\.jsonl$/, "")}/subagents`;

export async function countAgents(transcript: string): Promise<number> {
  try {
    return (await readdir(agentsDir(transcript))).filter((n) => META.test(n)).length;
  } catch {
    return 0;
  }
}

async function readMeta(dir: string, id: string): Promise<Record<string, any>> {
  try {
    const m = JSON.parse(await readFile(join(dir, `agent-${id}.meta.json`), "utf8"));
    return m && typeof m === "object" ? m : {};
  } catch {
    return {};
  }
}

function node(id: string, meta: Record<string, any>, body: DetailBody): Omit<AgentNode, "depth" | "parentAgentId"> {
  return {
    id,
    type: typeof meta.agentType === "string" ? meta.agentType : "agent",
    description: typeof meta.description === "string" ? redact(meta.description) : "",
    model: body.model ?? (typeof meta.model === "string" ? meta.model : null),
    finished: meta.finished === true,
    toolUseId: typeof meta.toolUseId === "string" ? meta.toolUseId : null,
    startedAt: body.startedAt,
    totals: body.totals,
  };
}

/**
 * Sub-agents of a session, in tree order. An agent's parent is whichever transcript (the session's
 * own, or another agent's) contains the `Agent` tool call whose id is the agent's `toolUseId`.
 */
export async function readAgents(transcript: string, mainSpawned: string[]): Promise<AgentNode[]> {
  const dir = agentsDir(transcript);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const loaded = await Promise.all(
    names.map(async (n) => {
      const id = META.exec(n)?.[1];
      if (!id || !AGENT_ID.test(id)) return null;
      try {
        const body = await readDetail(join(dir, `agent-${id}.jsonl`), { events: false });
        return { id, meta: await readMeta(dir, id), body };
      } catch {
        return null; // transcript missing or unreadable
      }
    }),
  );
  const agents = loaded.filter((a) => a !== null);

  // tool call id → agent that issued it (null = the session itself)
  const issuer = new Map<string, string | null>(mainSpawned.map((t) => [t, null]));
  for (const a of agents) for (const t of a.body.spawned) issuer.set(t, a.id);

  const nodes = agents.map((a) => {
    const n = node(a.id, a.meta, a.body);
    return { ...n, parentAgentId: (n.toolUseId && issuer.get(n.toolUseId)) || null };
  });

  const byStart = (a: { startedAt: string | null }, b: { startedAt: string | null }) =>
    (a.startedAt ?? "￿").localeCompare(b.startedAt ?? "￿");
  const children = (parent: string | null) => nodes.filter((n) => n.parentAgentId === parent).sort(byStart);

  const out: AgentNode[] = [];
  const visited = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const n of children(parent)) {
      if (visited.has(n.id)) continue; // guards against a cyclic or corrupt parent chain
      visited.add(n.id);
      out.push({ ...n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(null, 1);
  // Anything unreachable (corrupt data) is still shown, at depth 1.
  for (const n of nodes.sort(byStart)) if (!visited.has(n.id)) out.push({ ...n, depth: 1 });
  return out;
}

export async function readAgentDetail(transcript: string, id: string): Promise<AgentDetail | null> {
  if (!AGENT_ID.test(id)) return null;
  const dir = agentsDir(transcript);
  let body: DetailBody;
  try {
    body = await readDetail(join(dir, `agent-${id}.jsonl`));
  } catch {
    return null;
  }
  const meta = await readMeta(dir, id);
  return {
    agent: { ...node(id, meta, body), depth: 1, parentAgentId: null },
    events: body.events,
    truncated: body.truncated,
  };
}
