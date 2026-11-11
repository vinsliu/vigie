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
                h("div", { class: "meta" }, h("span", { class: "badge" }, clientName(s.entrypoint)), projectName(s)),
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
    h(
      "div",
      { class: "timeline" },
      d.events.map((e) =>
        h(
          "div",
          { class: `ev ${e.kind}` },
          h("div", { class: "who" }, e.tool ? `${LABEL[e.kind]} · ${e.tool}` : LABEL[e.kind], e.ts ? ` · ${new Date(e.ts).toLocaleTimeString()}` : ""),
          h("pre", {}, e.text),
        ),
      ),
      d.truncated ? h("div", { class: "empty" }, "Timeline truncated (too long).") : null,
    ),
  );
}

// ---------- routing + live refresh ----------
async function route() {
  try {
    const m = location.hash.match(/^#\/s\/(.+)$/);
    await (m ? renderDetail(decodeURIComponent(m[1])) : renderList());
  } catch {
    app.replaceChildren(h("div", { class: "empty" }, "Could not load data."));
  }
}
addEventListener("hashchange", route);

let t;
new EventSource("/api/events").addEventListener("change", () => {
  clearTimeout(t);
  // Do not wipe the search box while the user is typing in it.
  t = setTimeout(() => document.activeElement?.tagName !== "INPUT" && route(), 400);
});
route();
