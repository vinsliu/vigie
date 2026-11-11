import { SPANS, axisTicks, layoutLane, projectLabels } from "/watch.js";

// Transcripts are untrusted text: everything goes through textContent, never innerHTML.
// Layout values (positions, sizes) are set through the CSSOM (el.style): the CSP forbids inline style attributes.
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
const side = $("#side");
const statusEl = $("#status");
const searchEl = $("#q");
const tipEl = $("#tip");

const CLIENTS = { "claude-desktop": "Desktop", "claude-vscode": "VS Code", cli: "CLI", "sdk-cli": "CLI" };
const clientName = (e) => (e ? (CLIENTS[e] ?? e) : "Unknown");

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null) continue;
    if (k === "class") el.className = v;
    else if (k === "style") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k.startsWith("aria-") || k.startsWith("data-") || k === "role") el.setAttribute(k, v);
    else el[k] = v;
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attrs, ...kids) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v);
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}
const icon = (d) => svg("svg", { viewBox: "0 0 24 24", class: "ico", "aria-hidden": "true" }, svg("path", { d }));
const ICON_LIST = "M4 6h16M4 12h16M4 18h10";
const ICON_CHART = "M4 20V10M10 20V4M16 20v-7M22 20H2";

const money = (n) => (n == null ? "–" : n === 0 ? "$0" : `$${n.toFixed(n < 1 ? 3 : 2)}`);
const num = (n) => new Intl.NumberFormat().format(n);
function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
const sessionTitle = (s) => s.alias || s.title || s.firstPrompt || s.id;
const projectKey = (s) => s.cwd ?? s.projectDir;
const sessionHref = (s) => `#/s/${encodeURIComponent(s.id)}`;

async function api(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// ---------- state ----------
const state = {
  sessions: [],
  span: 14, // days shown by the watch
  moreProjects: false, // sidebar: show every project, not only the 6 most recent
  moreLanes: false, // watch: show every project lane, not only the 8 most recent
  hiddenKinds: new Set(), // session page: kinds of timeline events the user turned off
  statsDays: 30, // stats page: period
  filters: { q: "", projects: new Set(), clients: new Set(), activeOnly: false, showArchived: false },
};

function matches(s) {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  return (
    (f.showArchived || !s.archived) &&
    (!f.activeOnly || s.active) &&
    (!f.projects.size || f.projects.has(projectKey(s))) &&
    (!f.clients.size || f.clients.has(clientName(s.entrypoint))) &&
    (!q || `${sessionTitle(s)} ${s.cwd ?? ""} ${s.lastPrompt ?? ""}`.toLowerCase().includes(q))
  );
}

function updateStatus(list, hiddenArchived = 0) {
  const total = list.reduce((n, s) => n + (s.costUSD ?? 0), 0);
  const running = list.filter((s) => s.active).length;
  statusEl.textContent =
    `${list.length} ${list.length === 1 ? "session" : "sessions"} · ${running} running · ${money(total)}` +
    (hiddenArchived ? ` · ${hiddenArchived} archived hidden` : "");
}

// ---------- tooltip ----------
function bindTip(el, title, detail) {
  const show = (x, y) => {
    tipEl.replaceChildren(h("b", {}, title), h("span", {}, detail));
    tipEl.classList.add("on");
    tipEl.style.left = `${Math.max(8, Math.min(x + 14, innerWidth - 310))}px`;
    tipEl.style.top = `${y + 16}px`;
  };
  const hide = () => tipEl.classList.remove("on");
  el.addEventListener("mousemove", (e) => show(e.clientX, e.clientY));
  el.addEventListener("mouseleave", hide);
  el.addEventListener("focus", () => {
    const r = el.getBoundingClientRect();
    show(r.left, r.bottom - 12);
  });
  el.addEventListener("blur", hide);
}

// ---------- sidebar ----------
function option(label, checked, onchange, count) {
  return h(
    "label",
    { class: "opt" },
    h("input", { type: "checkbox", checked, onchange }),
    h("span", { class: "lbl", title: label }, label),
    count == null ? null : h("span", { class: "n" }, String(count)),
  );
}

function radio(name, label, checked, onchange) {
  return h("label", { class: "opt" }, h("input", { type: "radio", name, checked, onchange }), h("span", { class: "lbl" }, label));
}

// Timeline event kinds, as the server names them.
const KINDS = [
  ["user", "Your messages"],
  ["assistant", "Claude"],
  ["tool_use", "Tool calls"],
  ["tool_result", "Results"],
];
const applyTimelineFilter = () => (app.dataset.hide = [...state.hiddenKinds].join(" "));

function openAgent(id) {
  const el = app.querySelector(`details[data-agent="${CSS.escape(id)}"]`);
  if (!el) return;
  el.open = true; // loads its timeline
  el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}

// The sidebar follows the page: filters for the list, controls for the session being read, a period for the stats.
function detailSections(ctx) {
  const d = ctx.detail;
  const counts = {};
  for (const e of d?.events ?? []) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  const out = [
    h("h4", {}, "Timeline"),
    ...KINDS.map(([k, label]) =>
      option(
        label,
        !state.hiddenKinds.has(k),
        (e) => {
          if (e.target.checked) state.hiddenKinds.delete(k);
          else state.hiddenKinds.add(k);
          applyTimelineFilter();
        },
        d ? `${counts[k] ?? 0}${d.truncated ? "+" : ""}` : undefined,
      ),
    ),
  ];
  if (d?.agents?.length) {
    out.push(
      h("h4", {}, "Sub-agents"),
      ...d.agents.map((a) =>
        h("button", { type: "button", class: `jump d${Math.min(a.depth, 4)}`, title: `${a.type} · ${a.description}`, onclick: () => openAgent(a.id) }, h("b", {}, a.type), ` ${a.description}`),
      ),
    );
  }
  const id = decodeURIComponent(location.hash.slice(4));
  const s = state.sessions.find((x) => x.id === id);
  if (s) {
    const key = projectKey(s);
    const siblings = state.sessions
      .filter((x) => projectKey(x) === key && (!x.archived || x.id === s.id))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 8);
    if (siblings.length > 1) {
      out.push(
        h("h4", {}, `In ${projectLabels([key]).get(key)}`),
        ...siblings.map((x) =>
          h("a", { class: "side-link", href: sessionHref(x), title: sessionTitle(x), "aria-current": x.id === s.id ? "page" : null }, h("span", { class: `st${x.active ? " live" : ""}` }), h("span", { class: "lbl" }, sessionTitle(x))),
        ),
      );
    }
  }
  return out;
}

const PERIODS = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
];
function statsSections() {
  return [
    h("h4", {}, "Period"),
    ...PERIODS.map(([d, label]) =>
      radio("period", label, state.statsDays === d, () => {
        state.statsDays = d;
        renderStats();
      }),
    ),
  ];
}

function renderSide(view, ctx = {}) {
  const sessions = state.sessions;
  const open = sessions.filter((s) => !s.archived);
  const f = state.filters;
  const toggle = (set, value) => (set.has(value) ? set.delete(value) : set.add(value));

  const parts = [
    h("a", { class: "brand", href: "#/" }, h("i", {}), "vigie"),
    h(
      "nav",
      { class: "nav" },
      h("a", { href: "#/", "aria-current": view === "stats" ? null : "page" }, icon(ICON_LIST), "Sessions", h("span", { class: "n" }, String(open.length))),
      h("a", { href: "#/stats", "aria-current": view === "stats" ? "page" : null }, icon(ICON_CHART), "Stats"),
    ),
  ];

  if (view === "sessions") {
    const byProject = new Map();
    for (const s of open) {
      const k = projectKey(s);
      const e = byProject.get(k) ?? { k, n: 0, last: 0 };
      e.n++;
      e.last = Math.max(e.last, Date.parse(s.updatedAt) || 0);
      byProject.set(k, e);
    }
    const projects = [...byProject.values()].sort((a, b) => b.last - a.last);
    const labels = projectLabels(projects.map((p) => p.k));
    const listed = projects.filter((p, i) => state.moreProjects || i < 6 || f.projects.has(p.k));
    const clients = [...new Set(open.map((s) => clientName(s.entrypoint)))].sort();

    parts.push(
      h("h4", {}, "Projects"),
      ...listed.map((p) =>
        option(labels.get(p.k), f.projects.has(p.k), () => (toggle(f.projects, p.k), drawSessions()), p.n),
      ),
      projects.length > listed.length || (state.moreProjects && projects.length > 6)
        ? h(
            "button",
            { type: "button", class: "more", onclick: () => ((state.moreProjects = !state.moreProjects), renderSide(view)) },
            state.moreProjects ? "Show fewer" : `Show all ${projects.length}`,
          )
        : null,
      h("h4", {}, "Clients"),
      ...clients.map((c) => option(c, f.clients.has(c), () => (toggle(f.clients, c), drawSessions()))),
      h("h4", {}, "Show"),
      option("Running only", f.activeOnly, (e) => ((f.activeOnly = e.target.checked), drawSessions())),
      option("Archived", f.showArchived, (e) => ((f.showArchived = e.target.checked), drawSessions()), sessions.length - open.length),
    );
  } else if (view === "detail") {
    parts.push(...detailSections(ctx));
  } else if (view === "stats") {
    parts.push(...statsSections());
  }

  const pinned = open.filter((s) => s.pinned);
  if (pinned.length) {
    parts.push(
      h("h4", {}, "Pinned"),
      ...pinned.map((s) => h("a", { class: "side-link", href: sessionHref(s), title: sessionTitle(s) }, h("span", { class: "lbl" }, sessionTitle(s)))),
    );
  }
  parts.push(h("div", { class: "foot" }, "Local only · 127.0.0.1", h("br"), "Never writes to Claude's files."));
  // Never pass null to replaceChildren(): it would render the text "null".
  side.replaceChildren(...parts.filter(Boolean));
}

// ---------- sessions page: the watch + the list ----------
function markEl(m, s, rows, maxCost, trackPx) {
  const c = Math.sqrt((s.costUSD ?? 0) / maxCost); // area ~ cost
  const top = rows === 1 ? "50%" : `${m.row * 42 + 27}px`;
  const inside = m.kind === "bar" && (m.width / 100) * trackPx >= 90; // a bar wide enough carries its own name
  const size = m.kind === "dot" ? 9 + c * 13 : inside ? 20 + c * 8 : 8 + c * 14;
  const title = sessionTitle(s);
  const a = h(
    "a",
    {
      class: `mark ${m.kind}${s.active ? " live" : ""}${s.archived ? " arch" : ""}`,
      href: sessionHref(s),
      "aria-label": `${title}, ${money(s.costUSD)}`,
      style:
        m.kind === "dot"
          ? { top, left: `${m.left}%`, width: `${size}px`, height: `${size}px` }
          : { top, left: `${m.left}%`, width: `${m.width}%`, height: `${size}px` },
    },
    inside ? h("span", { class: "in" }, title) : null,
  );
  bindTip(a, title, `${money(s.costUSD)} · ${s.model ?? "?"} · ${clientName(s.entrypoint)} · ${s.active ? "running now" : ago(s.updatedAt)}`);
  return a;
}

function watchCard(shown) {
  const now = Date.now();
  const days = state.span;
  const spanMs = days * 86_400_000;
  const from = now - spanMs;
  const maxCost = Math.max(0.001, ...state.sessions.map((s) => s.costUSD ?? 0));

  const groups = new Map();
  for (const s of shown) {
    const k = projectKey(s);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const lanes = [];
  let marked = 0;
  for (const [key, ss] of groups) {
    const items = ss
      .map((s) => ({ id: s.id, start: Date.parse(s.startedAt ?? s.updatedAt), end: s.active ? now : Date.parse(s.updatedAt), cost: s.costUSD ?? 0 }))
      .filter((i) => Number.isFinite(i.start) && Number.isFinite(i.end));
    const lay = layoutLane(items, from, now);
    if (!lay.marks.length) continue;
    marked += lay.marks.length;
    lanes.push({ key, lay, byId: new Map(ss.map((s) => [s.id, s])), last: Math.max(...items.map((i) => i.end)), cost: lay.marks.reduce((n, m) => n + m.cost, 0) });
  }
  lanes.sort((a, b) => b.last - a.last);
  const labels = projectLabels(lanes.map((l) => l.key));
  const visible = state.moreLanes ? lanes : lanes.slice(0, 8);

  const ticks = axisTicks(now, days);
  const pos = (t) => `${((t - from) / spanMs) * 100}%`;
  // Approximate width of a lane track, to decide how much text fits (card padding + lane label column).
  const trackPx = Math.max(160, app.clientWidth - 36 - (innerWidth <= 980 ? 78 : 124));

  const head = h(
    "div",
    { class: "ch" },
    h("h3", {}, "The watch"),
    h("span", { class: "sub" }, "each mark is a session · longer = ran longer · bigger = costs more"),
    h("span", { class: "sp" }),
    h(
      "div",
      { class: "seg", role: "group", "aria-label": "Time range" },
      SPANS.map(([d, label]) => h("button", { type: "button", "aria-pressed": String(d === state.span), onclick: () => ((state.span = d), drawSessions()) }, label)),
    ),
  );

  if (!lanes.length) {
    return h("section", { class: "card" }, head, h("div", { class: "empty" }, "No session in this period."));
  }

  const body = h(
    "div",
    { class: "watch-body" },
    // With many ticks, small screens only label the strong ones (Mondays / midnight): the others would overlap.
    h("div", { class: `axis${ticks.length > 5 ? " dense" : ""}` }, ticks.map((t) => h("span", { class: t.strong ? "strong" : "minor", style: { left: pos(t.t) } }, t.label))),
    visible.map((l) => {
      const rows = l.lay.rows;
      return h(
        "div",
        { class: "lane" },
        h("div", { class: "nm", title: l.key }, labels.get(l.key), h("small", {}, money(l.cost))),
        h(
          "div",
          { class: "track", style: { height: `${rows === 1 ? 62 : rows * 42 + 12}px` } },
          ticks.map((t) => h("i", { class: `gl${t.strong ? " strong" : ""}`, style: { left: pos(t.t) } })),
          l.lay.marks.map((m) => markEl(m, l.byId.get(m.id), rows, maxCost, trackPx)),
        ),
      );
    }),
    h("div", { class: "now" }),
  );

  const older = shown.length - marked;
  const notes = [];
  if (lanes.length > visible.length) {
    notes.push(h("button", { type: "button", onclick: () => ((state.moreLanes = true), drawSessions()) }, `Show ${lanes.length - visible.length} more projects`));
  }
  if (older > 0) notes.push(`${notes.length ? " · " : ""}${older} older ${older === 1 ? "session is" : "sessions are"} in the list below.`);
  return h("section", { class: "card" }, head, body, notes.length ? h("p", { class: "note" }, notes) : null);
}

function listCard(shown) {
  const max = Math.max(0.001, ...state.sessions.map((s) => s.costUSD ?? 0));
  const labels = projectLabels([...new Set(state.sessions.map(projectKey))]);
  const rows = shown.length
    ? shown.map((s) => {
        const tr = h(
          "tr",
          { class: s.archived ? "arch" : "" },
          h(
            "td",
            {},
            h("span", { class: `st${s.active ? " live" : s.pinned ? " pin" : ""}`, title: s.active ? "Running" : s.pinned ? "Pinned" : "" }),
            h("a", { class: "t", href: sessionHref(s) }, sessionTitle(s)),
            s.archived ? h("span", { class: "badge" }, "archived") : null,
            s.agents ? h("span", { class: "badge" }, `${s.agents} ${s.agents === 1 ? "agent" : "agents"}`) : null,
            h("div", { class: "p" }, `${labels.get(projectKey(s))} · ${s.model ?? "?"}`),
          ),
          h("td", {}, clientName(s.entrypoint)),
          h("td", {}, s.active ? "running now" : ago(s.updatedAt)),
          h("td", { class: "n" }, h("span", { class: "cb", style: { width: `${Math.max(3, ((s.costUSD ?? 0) / max) * 60)}px` } }), money(s.costUSD)),
        );
        // The whole row is clickable; the title link keeps it reachable from the keyboard.
        tr.addEventListener("click", (e) => !e.target.closest("a") && (location.hash = sessionHref(s)));
        return tr;
      })
    : [h("tr", {}, h("td", { colSpan: 4, class: "empty" }, "Nothing matches. Clear a filter or the search."))];
  return h(
    "section",
    { class: "card" },
    h("div", { class: "ch" }, h("h3", {}, "Sessions"), h("span", { class: "sub" }, `${shown.length} shown`)),
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, h("th", {}, "Session"), h("th", {}, "Client"), h("th", {}, "Last activity"), h("th", { class: "n" }, "Cost"))),
        h("tbody", {}, rows),
      ),
    ),
  );
}

function drawSessions() {
  const shown = state.sessions.filter(matches);
  updateStatus(shown, state.filters.showArchived ? 0 : state.sessions.filter((s) => s.archived).length);
  if (!state.sessions.length) {
    app.replaceChildren(h("h1", { class: "sr" }, "Sessions"), h("div", { class: "card empty" }, "No Claude Code session found yet. Start one and it shows up here."));
    return;
  }
  app.replaceChildren(h("h1", { class: "sr" }, "Sessions"), watchCard(shown), listCard(shown));
}

// ---------- session page ----------
// Pin / rename / archive only change the dashboard's own metadata file, never Claude's transcripts.
async function saveMeta(id, body) {
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/meta`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(String(r.status));
}

function actionsCard(s) {
  const msg = h("span", { class: "muted" });
  const run = async (body) => {
    try {
      await saveMeta(s.id, body);
      await route();
    } catch {
      msg.textContent = "Could not save.";
    }
  };
  const name = h("input", { type: "text", placeholder: "Display name", value: s.alias ?? "", maxLength: 120, "aria-label": "Display name (does not rename the session in Claude)" });
  name.addEventListener("keydown", (e) => e.key === "Enter" && run({ alias: name.value }));
  return h(
    "section",
    { class: "card" },
    h("h2", { class: "sec-h" }, "Manage"),
    h(
      "div",
      { class: "body", style: { paddingTop: "0" } },
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", onclick: () => run({ pinned: !s.pinned }) }, s.pinned ? "★ Unpin" : "☆ Pin"),
        // Archiving only hides the session in this dashboard; nothing is moved or deleted.
        h(
          "button",
          { type: "button", title: "Hide from the list. Nothing is deleted.", onclick: () => run(s.archived ? { archived: false } : { archived: true, pinned: false }) },
          s.archived ? "Unarchive" : "Archive",
        ),
      ),
      h("div", { class: "row" }, name, h("button", { type: "button", onclick: () => run({ alias: name.value }) }, "Save name")),
      h("div", { class: "row" }, msg),
    ),
  );
}

function resumeCard(d) {
  if (!d.resumeCommand) return null;
  const code = h("code", {}, d.resumeCommand);
  const copyBtn = h("button", { type: "button", class: "primary" }, "Copy command");
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(d.resumeCommand);
      copyBtn.textContent = "Copied ✓";
    } catch {
      // Clipboard blocked: select the text so the user can copy it by hand.
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      copyBtn.textContent = "Selected: copy it";
    }
    setTimeout(() => (copyBtn.textContent = "Copy command"), 2000);
  });
  return h(
    "section",
    { class: "card resume" },
    h("h2", { class: "sec-h" }, "Resume"),
    h("div", { class: "body", style: { paddingTop: "0" } }, h("div", { class: "lead" }, "Run this in a terminal. Vigie never runs commands itself."), code, h("div", { class: "row" }, copyBtn)),
  );
}

const LABEL = { user: "You", assistant: "Claude", tool_use: "Tool call", tool_result: "Result" };
function eventEl(e) {
  return h(
    "div",
    { class: `te ${e.kind}` },
    h("time", {}, e.ts ? new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : ""),
    h("div", {}, h("div", { class: "who" }, e.tool ? `${LABEL[e.kind]} · ${e.tool}` : LABEL[e.kind]), h("pre", {}, e.text)),
  );
}

// Sub-agents are listed as a tree; each one loads its own timeline only when opened.
function agentsCard(sessionId, agents) {
  if (!agents.length) return null;
  const rows = agents.map((a) => {
    const body = h("div", { class: "timeline agent-body" });
    let loaded = false;
    const det = h(
      "details",
      { class: `agent d${Math.min(a.depth, 4)}`, "data-agent": a.id },
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
    "section",
    { class: "card" },
    h("h2", { class: "sec-h" }, `Sub-agents (${agents.length})`),
    rows,
    h("p", { class: "agents-note" }, "Sub-agent tokens are shown separately and are not added to the session totals."),
  );
}

function renderDetail(d) {
  const s = d.summary;
  applyTimelineFilter();
  updateStatus(state.sessions.filter((x) => !x.archived));
  const cell = (label, value) => h("div", {}, h("small", {}, label), h("b", {}, value));
  app.replaceChildren(
    h(
      "div",
      { class: "dhead" },
      h("a", { class: "back", href: "#/" }, "← Sessions"),
      h("h1", {}, s.active ? h("span", { class: "live-dot", title: "Running" }) : null, sessionTitle(s)),
      h("div", { class: "meta mono" }, `${clientName(s.entrypoint)} · ${s.cwd ?? s.projectDir} · ${s.model ?? "?"} · v${s.version ?? "?"} · ${s.id}`),
    ),
    h(
      "div",
      { class: "dgrid" },
      h(
        "div",
        { class: "stack" },
        h(
          "section",
          { class: "card" },
          h(
            "div",
            { class: "kv" },
            cell("Cost", money(s.costUSD)),
            cell("Messages", num(d.totals.messages)),
            cell("Tool calls", num(d.totals.toolCalls)),
            cell("Output tokens", num(d.totals.outputTokens)),
            cell("Cache read", num(d.totals.cacheReadTokens)),
            cell("Sub-agents", String(d.agents.length)),
          ),
        ),
        actionsCard(s),
        resumeCard(d),
        agentsCard(s.id, d.agents),
      ),
      h(
        "section",
        { class: "card" },
        h("h2", { class: "sec-h" }, "Timeline"),
        h("div", { class: "timeline" }, d.events.map(eventEl), d.truncated ? h("div", { class: "empty" }, "Timeline truncated (too long).") : null),
      ),
    ),
  );
}

// ---------- stats page ----------
function costChart(days) {
  const W = 760, H = 190, padL = 40, padB = 22, padT = 8;
  const max = Math.max(0.01, ...days.map((d) => d.costUSD));
  const slot = (W - padL) / days.length;
  const barW = Math.max(2, slot - 4);
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
    const last = i === days.length - 1;
    chart.append(svg("rect", { class: `bar${last ? " last" : ""}`, x: padL + i * slot + 2, y: top, width: barW, height: Math.max(0, H - padB - top), rx: 2 }, tip));
    if (i === 0 || last || i === Math.floor(days.length / 2)) {
      const t = svg("text", { x: padL + i * slot + barW / 2, y: H - 6, "text-anchor": i === 0 ? "start" : last ? "end" : "middle" });
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
      h("thead", {}, h("tr", {}, headers.map((x, i) => h("th", { class: i ? "n" : "" }, x)))),
      h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c, i) => h("td", { class: i ? "n" : "" }, String(c)))))),
    ),
  );
}

async function renderStats() {
  const days = state.statsDays;
  const s = await api(`/api/stats?days=${days}`);
  const kpi = (label, value) => h("div", { class: "card kpi" }, h("small", {}, label), h("b", {}, value));
  const last30 = s.days.reduce((n, d) => n + d.costUSD, 0);
  updateStatus(state.sessions.filter((x) => !x.archived));
  app.replaceChildren(
    h("h1", { class: "sr" }, "Stats"),
    h(
      "div",
      { class: "kpis" },
      kpi("Total cost", money(s.totals.costUSD)),
      kpi(`Last ${days} days (est.)`, money(last30)),
      kpi("Sessions", num(s.totals.sessions)),
      kpi("Output tokens", num(s.totals.tokens.output)),
      kpi("Cache read tokens", num(s.totals.tokens.cacheRead)),
    ),
    h(
      "section",
      { class: "card" },
      h("div", { class: "ch" }, h("h3", {}, "Daily cost"), h("span", { class: "sub" }, `last ${days} days`)),
      costChart(s.days),
      h("p", { class: "hint" }, "Session and model totals come from Claude's own cost data. A day's cost is an estimate: a session's cost is spread over the days it ran, in proportion to the tokens used."),
    ),
    h(
      "div",
      { class: "two" },
      h("section", { class: "card" }, h("div", { class: "ch" }, h("h3", {}, "By project")), table(["Project", "Sessions", "Cost", "Output tokens"], s.projects.map((p) => [p.project, p.sessions, money(p.costUSD), num(p.tokens.output)]))),
      h("section", { class: "card" }, h("div", { class: "ch" }, h("h3", {}, "By model")), table(["Model", "Cost", "Input", "Output", "Cache read"], s.models.map((m) => [m.model, money(m.costUSD), num(m.tokens.input), num(m.tokens.output), num(m.tokens.cacheRead)]))),
    ),
  );
}

// ---------- routing, live refresh, keyboard ----------
const currentView = () => (location.hash === "#/stats" ? "stats" : /^#\/s\/.+/.test(location.hash) ? "detail" : "sessions");

async function route({ keepSide = false } = {}) {
  document.body.classList.remove("nav-open");
  $("#menu").setAttribute("aria-expanded", "false");
  try {
    const view = currentView();
    const { sessions } = await api("/api/sessions");
    state.sessions = sessions;
    // A live refresh must not rebuild the sidebar under the user's hands (a focused checkbox would lose focus).
    const rebuildSide = !(keepSide && side.contains(document.activeElement)) || !side.children.length;
    if (view === "detail") {
      const d = await api(`/api/sessions/${encodeURIComponent(decodeURIComponent(location.hash.slice(4)))}`);
      if (rebuildSide) renderSide(view, { detail: d }); // needs the session: sub-agents and event counts
      renderDetail(d);
    } else {
      if (rebuildSide) renderSide(view);
      if (view === "stats") await renderStats();
      else drawSessions();
    }
  } catch {
    app.replaceChildren(h("div", { class: "card empty" }, "Could not load data."));
  }
}
addEventListener("hashchange", () => {
  scrollTo(0, 0); // a new page starts at the top
  renderSide(currentView()); // the sidebar content depends on the page
  route();
});

searchEl.addEventListener("input", () => {
  state.filters.q = searchEl.value;
  if (currentView() === "sessions") drawSessions();
  else location.hash = "#/"; // searching from another page brings you to the list
});

$("#menu").addEventListener("click", () => {
  const open = document.body.classList.toggle("nav-open");
  $("#menu").setAttribute("aria-expanded", String(open));
});
addEventListener("keydown", (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if (e.key === "/" && !typing) {
    e.preventDefault();
    searchEl.focus();
  } else if (e.key === "Escape") {
    if (document.body.classList.contains("nav-open")) route();
    else if (typing) document.activeElement.blur();
    else if (currentView() === "detail") location.hash = "#/";
  }
});

let timer;
new EventSource("/api/events").addEventListener("change", () => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    // Do not wipe the name box while the user types in it, nor collapse a sub-agent they just opened.
    const editing = app.contains(document.activeElement) && document.activeElement.tagName === "INPUT";
    if (currentView() === "detail" && (editing || document.querySelector("details[open]"))) return;
    route({ keepSide: true });
  }, 400);
});
route();
