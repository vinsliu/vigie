import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { listSessions } from "./scan.ts";
import { parseLine } from "./text.ts";

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface Stats {
  totals: { sessions: number; costUSD: number; tokens: Tokens };
  /** Last N calendar days (local time), oldest first, gaps filled with zeros. */
  days: { date: string; costUSD: number; tokens: Tokens; sessions: number }[];
  projects: { project: string; sessions: number; costUSD: number; tokens: Tokens }[];
  models: { model: string; costUSD: number; tokens: Tokens }[];
}

/** Token usage of one transcript, bucketed by local day and model, plus its final cost state. */
interface Usage {
  byDayModel: Map<string, Map<string, Tokens>>;
  cost: number | null;
  modelCost: Map<string, number>;
}

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
function add(a: Tokens, b: Tokens): void {
  a.input += b.input;
  a.output += b.output;
  a.cacheRead += b.cacheRead;
  a.cacheCreation += b.cacheCreation;
}

// Rough price ratios (relative to one input token) used ONLY to spread a known session cost
// over the days it was spent on. Totals per session, project and model stay exact.
const weight = (t: Tokens) => t.input + t.output * 5 + t.cacheRead * 0.1 + t.cacheCreation * 1.25;

export function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function readUsage(path: string): Promise<Usage> {
  const usage: Usage = { byDayModel: new Map(), cost: null, modelCost: new Map() };
  const seen = new Set<string>(); // each API message is written once per content block
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const isCost = line.includes('"cost-state"');
    if (!isCost && !line.includes('"usage"')) continue;
    const r = parseLine(line);
    if (!r) continue;

    if (r.type === "cost-state" && typeof r.totalCostUSD === "number") {
      usage.cost = r.totalCostUSD;
      usage.modelCost = new Map();
      for (const [m, v] of Object.entries<any>(r.modelUsage ?? {})) {
        if (typeof v?.costUSD === "number") usage.modelCost.set(m, v.costUSD);
      }
      continue;
    }
    if (r.type !== "assistant" || !r.message?.usage || typeof r.timestamp !== "string") continue;
    const id = r.message.id;
    if (typeof id === "string") {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    const when = new Date(r.timestamp);
    if (Number.isNaN(when.getTime())) continue;
    const u = r.message.usage;
    const day = localDay(when);
    const model = typeof r.message.model === "string" ? r.message.model : "unknown";
    const models = usage.byDayModel.get(day) ?? new Map<string, Tokens>();
    usage.byDayModel.set(day, models);
    const t = models.get(model) ?? zero();
    models.set(model, t);
    add(t, {
      input: Number(u.input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
      cacheRead: Number(u.cache_read_input_tokens) || 0,
      cacheCreation: Number(u.cache_creation_input_tokens) || 0,
    });
  }
  return usage;
}

const cache = new Map<string, { mtimeMs: number; size: number; usage: Usage }>();
async function cachedUsage(path: string): Promise<Usage> {
  const st = await stat(path);
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.usage;
  const usage = await readUsage(path);
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, usage });
  return usage;
}

export interface StatsOptions {
  days?: number;
  now?: number;
}

export async function computeStats(claudeDir: string, opts: StatsOptions = {}): Promise<Stats> {
  const nDays = opts.days ?? 30;
  const now = opts.now ?? Date.now();
  const sessions = await listSessions(claudeDir);

  const dayMap = new Map<string, { costUSD: number; tokens: Tokens; ids: Set<string> }>();
  const projectMap = new Map<string, { sessions: number; costUSD: number; tokens: Tokens }>();
  const modelMap = new Map<string, { costUSD: number; tokens: Tokens }>();
  const totals = { sessions: 0, costUSD: 0, tokens: zero() };

  for (const s of sessions) {
    let usage: Usage;
    try {
      usage = await cachedUsage(join(claudeDir, "projects", s.projectDir, `${s.id}.jsonl`));
    } catch {
      continue; // transcript vanished between listing and reading
    }
    const project = s.cwd ?? s.projectDir;
    const proj = projectMap.get(project) ?? { sessions: 0, costUSD: 0, tokens: zero() };
    projectMap.set(project, proj);
    proj.sessions++;
    totals.sessions++;
    const cost = usage.cost ?? 0;
    proj.costUSD += cost;
    totals.costUSD += cost;

    // Per-model token totals; models without a known cost share what `modelUsage` did not explain.
    const modelTokens = new Map<string, Tokens>();
    for (const models of usage.byDayModel.values()) {
      for (const [m, t] of models) {
        const mt = modelTokens.get(m) ?? zero();
        modelTokens.set(m, mt);
        add(mt, t);
      }
    }
    let unknownWeight = 0;
    for (const [m, t] of modelTokens) if (!usage.modelCost.has(m)) unknownWeight += weight(t);
    let explained = 0;
    for (const c of usage.modelCost.values()) explained += c;
    const unassigned = Math.max(0, cost - explained);
    for (const [m, t] of modelTokens) {
      const agg = modelMap.get(m) ?? { costUSD: 0, tokens: zero() };
      modelMap.set(m, agg);
      add(agg.tokens, t);
      if (!usage.modelCost.has(m) && unknownWeight > 0) agg.costUSD += unassigned * (weight(t) / unknownWeight);
      add(proj.tokens, t);
      add(totals.tokens, t);
    }
    for (const [m, c] of usage.modelCost) {
      const agg = modelMap.get(m) ?? { costUSD: 0, tokens: zero() };
      modelMap.set(m, agg);
      agg.costUSD += c;
    }

    // Spread the cost over days: exact per model when `modelUsage` is known, else by token weight.
    for (const [day, models] of usage.byDayModel) {
      const d = dayMap.get(day) ?? { costUSD: 0, tokens: zero(), ids: new Set<string>() };
      dayMap.set(day, d);
      d.ids.add(s.id);
      for (const [m, t] of models) {
        add(d.tokens, t);
        const known = usage.modelCost.get(m);
        const mw = weight(modelTokens.get(m) ?? zero());
        if (known !== undefined && mw > 0) d.costUSD += known * (weight(t) / mw);
        else if (known === undefined && unknownWeight > 0) d.costUSD += unassigned * (weight(t) / unknownWeight);
      }
    }
  }

  const days: Stats["days"] = [];
  for (let i = nDays - 1; i >= 0; i--) {
    const date = localDay(new Date(now - i * 86_400_000));
    const d = dayMap.get(date);
    days.push({ date, costUSD: d?.costUSD ?? 0, tokens: d?.tokens ?? zero(), sessions: d?.ids.size ?? 0 });
  }

  const byCost = <T extends { costUSD: number }>(a: T, b: T) => b.costUSD - a.costUSD;
  return {
    totals,
    days,
    projects: [...projectMap].map(([project, v]) => ({ project, ...v })).sort(byCost),
    models: [...modelMap].map(([model, v]) => ({ model, ...v })).sort(byCost),
  };
}
