// Pure helpers for "The watch", the timeline of sessions. No DOM in here, so they are unit-tested.

export const SPANS = [
  [1, "24 h"],
  [7, "7 d"],
  [14, "14 d"],
];

const DAY = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const pad = (n) => String(n).padStart(2, "0");

/**
 * Tick marks of the time axis for the window (now - spanDays, now], in local time.
 * One tick per local midnight, or every 6 hours when the window is a single day.
 * `strong` marks the ticks worth emphasising: Mondays, or midnight on the 24 h view.
 */
export function axisTicks(now, spanDays) {
  const from = now - spanDays * DAY;
  const end = now - 60_000; // a tick sitting on "now" would only collide with the now marker
  const ticks = [];

  if (spanDays <= 1) {
    const d = new Date(from);
    d.setMinutes(0, 0, 0);
    while (d.getHours() % 6 !== 0 || d.getTime() <= from) d.setHours(d.getHours() + 1);
    for (; d.getTime() < end; d.setHours(d.getHours() + 6)) {
      ticks.push({ t: d.getTime(), label: `${pad(d.getHours())}:00`, strong: d.getHours() === 0 });
    }
    return ticks;
  }

  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  for (; d.getTime() < end; d.setDate(d.getDate() + 1)) {
    const monday = d.getDay() === 1;
    // Built by hand, not with toLocaleDateString: its word order differs between engines.
    const label = spanDays <= 7 || monday ? `${WEEKDAYS[d.getDay()]} ${d.getDate()}` : String(d.getDate());
    ticks.push({ t: d.getTime(), label, strong: monday });
  }
  return ticks;
}

/**
 * Places the sessions of one project on the window [from, to].
 * Each item is { id, start, end, cost } in ms. A short session becomes a dot, a long one a bar.
 * Sessions that would overlap are stacked on separate rows instead of being drawn on top of each other.
 * `left` and `width` are percentages of the window; a dot's `left` is its centre.
 */
export function layoutLane(items, from, to, { minBar = 2.2, dotHalf = 1.4, gap = 0.6 } = {}) {
  const span = to - from;
  const marks = [];
  for (const it of items) {
    // Clock oddities (end before start) are put back in order rather than dropped.
    const start = Math.min(it.start, it.end);
    const end = Math.max(it.start, it.end);
    if (!(end >= from && start <= to)) continue;
    const l = ((Math.max(start, from) - from) / span) * 100;
    const r = ((Math.min(end, to) - from) / span) * 100;
    const width = Math.max(0, r - l);
    const dot = width < minBar;
    const mid = (l + r) / 2;
    marks.push({
      id: it.id,
      cost: it.cost,
      kind: dot ? "dot" : "bar",
      left: dot ? mid : l,
      width: dot ? 0 : width,
      a: dot ? mid - dotHalf : l,
      b: dot ? mid + dotHalf : r,
      row: 0,
    });
  }
  marks.sort((x, y) => x.a - y.a || x.b - y.b);
  const ends = []; // right edge of the last mark placed on each row
  for (const m of marks) {
    let row = ends.findIndex((e) => e <= m.a);
    if (row < 0) row = ends.length;
    ends[row] = m.b + gap;
    m.row = row;
  }
  return { marks, rows: Math.max(1, ends.length) };
}

/** Short, unambiguous project names: the folder name, plus its parent when two projects share one. */
export function projectLabels(paths) {
  const parts = (p) => String(p).split(/[\\/]/).filter(Boolean); // POSIX and Windows separators
  const base = new Map();
  for (const p of paths) base.set(p, parts(p).slice(-1)[0] ?? String(p));
  const count = new Map();
  for (const name of base.values()) count.set(name, (count.get(name) ?? 0) + 1);
  const out = new Map();
  for (const p of paths) {
    const name = base.get(p);
    out.set(p, count.get(name) > 1 ? parts(p).slice(-2).join("/") : name);
  }
  return out;
}
