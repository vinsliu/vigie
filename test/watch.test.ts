import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { axisTicks, layoutLane, projectLabels } from "../ui/watch.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Built in local time on purpose: the axis follows the user's own midnights.
const NOW = new Date(2026, 10, 11, 18, 0).getTime(); // Wed 11 Nov 2026, 18:00

describe("axisTicks", () => {
  it("puts one tick on each local midnight of a 14 day window and emphasises Mondays", () => {
    const ticks = axisTicks(NOW, 14);
    assert.equal(ticks.length, 14); // 29 Oct … 11 Nov
    assert.ok(ticks.every((t) => new Date(t.t).getHours() === 0));
    assert.deepEqual(
      ticks.filter((t) => t.strong).map((t) => new Date(t.t).getDate()),
      [2, 9],
    );
    assert.equal(ticks.at(-1)?.label, "11");
    assert.equal(ticks.find((t) => new Date(t.t).getDate() === 9)?.label, "Mon 9");
  });

  it("names every day on the 7 day view", () => {
    const labels = axisTicks(NOW, 7).map((t) => t.label);
    assert.deepEqual(labels, ["Thu 5", "Fri 6", "Sat 7", "Sun 8", "Mon 9", "Tue 10", "Wed 11"]);
  });

  it("marks every 6 hours on the 24 hour view", () => {
    const ticks = axisTicks(NOW, 1);
    assert.deepEqual(
      ticks.map((t) => t.label),
      ["00:00", "06:00", "12:00"],
    );
    assert.deepEqual(ticks.filter((t) => t.strong).map((t) => t.label), ["00:00"]);
  });

  it("never puts a tick on the present moment", () => {
    for (const span of [1, 7, 14]) assert.ok(axisTicks(NOW, span).every((t) => t.t < NOW));
    const midnight = new Date(2026, 10, 12, 0, 0).getTime();
    assert.ok(axisTicks(midnight, 7).every((t) => t.t < midnight));
  });
});

describe("layoutLane", () => {
  const from = NOW - 14 * DAY;
  const item = (id: string, startAgoH: number, endAgoH: number, cost = 1) => ({
    id,
    start: NOW - startAgoH * HOUR,
    end: NOW - endAgoH * HOUR,
    cost,
  });

  it("draws a short session as a dot and a long one as a bar, as percentages of the window", () => {
    const { marks } = layoutLane([item("short", 30, 29.8), item("long", 100, 50)], from, NOW);
    const short = marks.find((m) => m.id === "short")!;
    const long = marks.find((m) => m.id === "long")!;
    assert.equal(short.kind, "dot");
    assert.equal(short.width, 0);
    assert.equal(long.kind, "bar");
    assert.ok(Math.abs(long.width - (50 / (14 * 24)) * 100) < 1e-9);
    assert.ok(Math.abs(long.left - (100 - (100 / (14 * 24)) * 100)) < 1e-9);
  });

  it("stacks overlapping sessions on separate rows and reuses a row once it is free", () => {
    const { marks, rows } = layoutLane(
      [item("bar", 100, 50), item("dot-inside", 75, 74.9), item("later", 20, 19)],
      from,
      NOW,
    );
    const row = (id: string) => marks.find((m) => m.id === id)!.row;
    assert.notEqual(row("bar"), row("dot-inside"));
    assert.equal(row("later"), row("bar")); // the bar is over by then
    assert.equal(rows, 2);
  });

  it("keeps a single row when nothing overlaps", () => {
    const { rows } = layoutLane([item("a", 200, 190), item("b", 100, 90), item("c", 10, 5)], from, NOW);
    assert.equal(rows, 1);
  });

  it("clips a session that started before the window and drops one entirely outside it", () => {
    const { marks } = layoutLane([item("old", 24 * 20, 24 * 10), item("gone", 24 * 30, 24 * 20)], from, NOW);
    assert.deepEqual(marks.map((m) => m.id), ["old"]);
    assert.equal(marks[0]!.left, 0);
    assert.ok(marks[0]!.width > 0 && marks[0]!.width < 100);
  });

  it("puts a session whose end is before its start back in order instead of dropping it", () => {
    const { marks } = layoutLane([item("odd", 10, 20)], from, NOW); // 20 h ago → 10 h ago
    assert.equal(marks.length, 1);
    assert.equal(marks[0]!.kind, "bar");
    assert.ok(Math.abs(marks[0]!.width - (10 / (14 * 24)) * 100) < 1e-9);
  });
});

describe("projectLabels", () => {
  it("uses the folder name, and adds the parent folder only when two projects collide", () => {
    const labels = projectLabels(["/a/code/blog", "/a/code/shop", "/b/work/shop"]);
    assert.equal(labels.get("/a/code/blog"), "blog");
    assert.equal(labels.get("/a/code/shop"), "code/shop");
    assert.equal(labels.get("/b/work/shop"), "work/shop");
  });

  it("understands Windows paths, drive letters and trailing separators", () => {
    const labels = projectLabels(["C:\\Users\\me\\code\\blog", "C:\\Users\\me\\code\\shop\\", "D:\\work\\shop"]);
    assert.equal(labels.get("C:\\Users\\me\\code\\blog"), "blog");
    assert.equal(labels.get("C:\\Users\\me\\code\\shop\\"), "code/shop");
    assert.equal(labels.get("D:\\work\\shop"), "work/shop");
  });
});
