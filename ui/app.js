// Transcripts are untrusted text: everything goes through textContent, never innerHTML.
const app = document.getElementById("app");
const statusEl = document.getElementById("status");

const CLIENTS = { "claude-desktop": "Desktop", "claude-vscode": "VS Code", cli: "CLI", "sdk-cli": "CLI" };
const clientName = (e) => (e ? (CLIENTS[e] ?? e) : "Unknown");

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) el[k] = v;
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const money = (n) => (n == null ? "–" : n === 0 ? "$0" : `$${n.toFixed(n < 1 ? 3 : 2)}`);
const num = (n) => new Intl.NumberFormat().format(n);
function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
const sessionTitle = (s) => s.title || s.firstPrompt || s.id;
const projectName = (s) => (s.cwd ? s.cwd.split("/").filter(Boolean).slice(-2).join("/") : s.projectDir);

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// ---------- list view ----------
const filters = { q: "", client: "", activeOnly: false };

async function renderList() {
  const { sessions } = await api("/api/sessions");
  const clients = [...new Set(sessions.map((s) => clientName(s.entrypoint)))].sort();
  const listEl = h("ul", { class: "sessions" });

  const draw = () => {
    const q = filters.q.toLowerCase();
    const shown = sessions.filter(
      (s) =>
        (!filters.client || clientName(s.entrypoint) === filters.client) &&
        (!filters.activeOnly || s.active) &&
        (!q || `${sessionTitle(s)} ${s.cwd ?? ""} ${s.lastPrompt ?? ""}`.toLowerCase().includes(q)),
    );
    const total = shown.reduce((n, s) => n + (s.costUSD ?? 0), 0);
    statusEl.textContent = `${shown.length} ${shown.length === 1 ? "session" : "sessions"} · ${sessions.filter((s) => s.active).length} active · ${money(total)}`;
    listEl.replaceChildren(
      ...(shown.length
        ? shown.map((s) =>
            h(
              "li",
              {},
              h(
                "a",
                { href: `#/s/${encodeURIComponent(s.id)}` },
                h("div", { class: "title" }, s.active ? h("span", { class: "dot", title: "running" }) : null, sessionTitle(s)),
                h("div", { class: "right" }, ago(s.updatedAt)),
                h(
                  "div",
                  { class: "meta" },
                  h("span", { class: "badge" }, clientName(s.entrypoint)),
                  s.agents ? h("span", { class: "badge" }, `${s.agents} ${s.agents === 1 ? "agent" : "agents"}`) : null,
                  projectName(s),
                ),
                h("div", { class: "right" }, money(s.costUSD)),
              ),
            ),
          )
        : [h("li", { class: "empty" }, "No session found.")]),
    );
  };

  const search = h("input", {
    type: "search",
    placeholder: "Search title, project, prompt…",
    value: filters.q,
    oninput: (e) => ((filters.q = e.target.value), draw()),
  });
  const select = h(
    "select",
    { onchange: (e) => ((filters.client = e.target.value), draw()) },
    h("option", { value: "" }, "All clients"),
    clients.map((c) => h("option", { value: c, selected: c === filters.client }, c)),
  );
  const active = h("input", { type: "checkbox", checked: filters.activeOnly, onchange: (e) => ((filters.activeOnly = e.target.checked), draw()) });

  app.replaceChildren(h("div", { class: "toolbar" }, search, select, h("label", {}, active, " Active only")), listEl);
  draw();
}

// ---------- detail view ----------
const LABEL = { user: "You", assistant: "Claude", tool_use: "Tool call", tool_result: "Result" };

function eventEl(e) {
  return h(
    "div",
    { class: `ev ${e.kind}` },
    h("div", { class: "who" }, e.tool ? `${LABEL[e.kind]} · ${e.tool}` : LABEL[e.kind], e.ts ? ` · ${new Date(e.ts).toLocaleTimeString()}` : ""),
    h("pre", {}, e.text),
  );
}

// Sub-agents are listed as a tree; each one loads its own timeline only when opened.
function agentSection(sessionId, agents) {
  if (!agents.length) return null;
  const rows = agents.map((a) => {
    const body = h("div", { class: "timeline agent-body" });
    let loaded = false;
    const det = h(
      "details",
      { class: `agent d${Math.min(a.depth, 4)}` },
      h(
        "summary",
        {},
        h("b", {}, a.type),
        ` ${a.description}`,
        h("span", { class: "muted" }, ` · ${a.model ?? "?"} · ${num(a.totals.outputTokens)} out · ${num(a.totals.toolCalls)} tools`),
        a.finished ? null : h("span", { class: "badge" }, "unfinished"),
      ),
      body,
    );
    det.addEventListener("toggle", async () => {
      if (!det.open || loaded) return;
      loaded = true;
      body.textContent = "Loading…";
      try {
        const r = await api(`/api/sessions/${encodeURIComponent(sessionId)}/agents/${encodeURIComponent(a.id)}`);
        body.replaceChildren(...r.events.map(eventEl), ...(r.truncated ? [h("div", { class: "empty" }, "Timeline truncated (too long).")] : []));
      } catch {
        loaded = false;
        body.textContent = "Could not load this agent.";
      }
    });
    return det;
  });
  return h(
    "div",
    {},
    h("h3", {}, `Sub-agents (${agents.length})`),
    rows,
    h("p", { class: "muted" }, "Sub-agent tokens are shown separately and are not added to the session totals above."),
  );
}

async function renderDetail(id) {
  const d = await api(`/api/sessions/${encodeURIComponent(id)}`);
  const s = d.summary;
  statusEl.textContent = "";
  const stat = (label, value) => h("div", { class: "stat" }, h("b", {}, value), label);

  app.replaceChildren(
    h("p", {}, h("a", { href: "#/" }, "← All sessions")),
    h("h2", {}, s.active ? h("span", { class: "dot" }) : null, sessionTitle(s)),
    h("div", { class: "meta mono" }, `${clientName(s.entrypoint)} · ${s.cwd ?? s.projectDir} · ${s.model ?? "?"} · v${s.version ?? "?"} · ${s.id}`),
    h(
      "div",
      { class: "stats" },
      stat("cost", money(s.costUSD)),
      stat("messages", num(d.totals.messages)),
      stat("tool calls", num(d.totals.toolCalls)),
      stat("output tokens", num(d.totals.outputTokens)),
      stat("cache read", num(d.totals.cacheReadTokens)),
    ),
    agentSection(s.id, d.agents),
    h("h3", {}, "Timeline"),
    h(
      "div",
      { class: "timeline" },
      d.events.map(eventEl),
      d.truncated ? h("div", { class: "empty" }, "Timeline truncated (too long).") : null,
    ),
  );
}

// ---------- stats view ----------
const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v);
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}

function costChart(days) {
  const W = 700, H = 170, padL = 40, padB = 20, padT = 8;
  const max = Math.max(0.01, ...days.map((d) => d.costUSD));
  const slot = (W - padL) / days.length;
  const barW = Math.max(2, slot - 3);
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const chart = svg("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Estimated daily cost" });
  for (const f of [0, 0.5, 1]) {
    const gy = y(max * f);
    chart.append(svg("line", { class: "grid", x1: padL, x2: W, y1: gy, y2: gy }));
    const label = svg("text", { x: padL - 6, y: gy + 3, "text-anchor": "end" });
    label.textContent = money(max * f);
    chart.append(label);
  }
  days.forEach((d, i) => {
    const top = y(d.costUSD);
    const tip = svg("title");
    tip.textContent = `${d.date} · ${money(d.costUSD)} · ${num(d.tokens.output)} output tokens · ${d.sessions} sessions`;
    chart.append(svg("rect", { class: "bar", x: padL + i * slot + 1, y: top, width: barW, height: Math.max(0, H - padB - top) }, tip));
    if (i === 0 || i === days.length - 1 || i === Math.floor(days.length / 2)) {
      const t = svg("text", { x: padL + i * slot + barW / 2, y: H - 5, "text-anchor": i === 0 ? "start" : i === days.length - 1 ? "end" : "middle" });
      t.textContent = d.date.slice(5);
      chart.append(t);
    }
  });
  return chart;
}

function table(headers, rows) {
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, headers.map((x, i) => h("th", { class: i ? "num" : "" }, x)))),
      h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c, i) => h("td", { class: i ? "num" : "" }, String(c)))))),
    ),
  );
}

async function renderStats() {
  const s = await api("/api/stats?days=30");
  const stat = (label, value) => h("div", { class: "stat" }, h("b", {}, value), label);
  const last30 = s.days.reduce((n, d) => n + d.costUSD, 0);
  statusEl.textContent = "";
  app.replaceChildren(
    h(
      "div",
      { class: "stats" },
      stat("total cost", money(s.totals.costUSD)),
      stat("last 30 days (est.)", money(last30)),
      stat("sessions", num(s.totals.sessions)),
      stat("output tokens", num(s.totals.tokens.output)),
      stat("cache read tokens", num(s.totals.tokens.cacheRead)),
    ),
    h("h3", {}, "Daily cost, last 30 days"),
    costChart(s.days),
    h("p", { class: "muted" }, "Session and model totals come from Claude's own cost data. A day's cost is an estimate: a session's cost is spread over the days it ran, in proportion to the tokens used."),
    h("h3", {}, "By project"),
    table(["Project", "Sessions", "Cost", "Output tokens"], s.projects.map((p) => [p.project, p.sessions, money(p.costUSD), num(p.tokens.output)])),
    h("h3", {}, "By model"),
    table(["Model", "Cost", "Input", "Output", "Cache read"], s.models.map((m) => [m.model, money(m.costUSD), num(m.tokens.input), num(m.tokens.output), num(m.tokens.cacheRead)])),
  );
}

// ---------- routing + live refresh ----------
async function route() {
  try {
    const hash = location.hash;
    document.getElementById("nav-stats").classList.toggle("current", hash === "#/stats");
    document.getElementById("nav-sessions").classList.toggle("current", hash !== "#/stats");
    const m = hash.match(/^#\/s\/(.+)$/);
    await (hash === "#/stats" ? renderStats() : m ? renderDetail(decodeURIComponent(m[1])) : renderList());
  } catch {
    app.replaceChildren(h("div", { class: "empty" }, "Could not load data."));
  }
}
addEventListener("hashchange", route);

let t;
new EventSource("/api/events").addEventListener("change", () => {
  clearTimeout(t);
  // Do not wipe the search box while the user is typing in it.
  // ...nor collapse a sub-agent the user has just opened.
  t = setTimeout(() => document.activeElement?.tagName !== "INPUT" && !document.querySelector("details[open]") && route(), 400);
});
route();
