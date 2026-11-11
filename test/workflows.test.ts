import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// A guard on the GitHub Actions workflows, with no YAML dependency: it reads them as text.
const DIR = fileURLToPath(new URL("../.github/workflows/", import.meta.url));

async function workflows() {
  const names = (await readdir(DIR)).filter((n) => /\.ya?ml$/.test(n));
  assert.ok(names.length >= 2, "the CI and release workflows are there");
  return Promise.all(names.map(async (name) => ({ name, text: await readFile(join(DIR, name), "utf8") })));
}

/** The shell scripts of a workflow: every `run:` value, inline or as a block. */
function runScripts(text: string): string[] {
  const lines = text.split("\n");
  const scripts: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.length;
    if (!/^[|>]/.test(m[2]!)) {
      scripts.push(m[2]!);
      continue;
    }
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() !== "" && l.length - l.trimStart().length <= indent) break;
      block.push(l);
    }
    scripts.push(block.join("\n"));
  }
  return scripts;
}

describe("workflows", () => {
  it("pin every action to a commit, so a moved tag cannot change what runs with our token", async () => {
    for (const { name, text } of await workflows()) {
      const uses = [...text.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]!);
      assert.ok(uses.length > 0, `${name} uses no action?`);
      for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${name}: ${u} is not pinned to a commit`);
    }
  });

  it("never put an event field inside a shell script (script injection)", async () => {
    for (const { name, text } of await workflows()) {
      for (const script of runScripts(text)) {
        const bad = script.match(/\$\{\{[^}]*\}\}/g) ?? [];
        assert.deepEqual(bad, [], `${name}: expressions inside a run script, pass them through env: ${bad.join(" ")}`);
      }
    }
  });

  it("declare permissions at the top, and give write access only to the release job", async () => {
    for (const { name, text } of await workflows()) {
      assert.match(text, /^permissions:/m, `${name} declares no top-level permissions`);
    }
    const all = await workflows();
    const release = all.find((w) => w.name === "release.yml")!;
    const ci = all.find((w) => w.name === "ci.yml")!;
    assert.ok(!/contents:\s*write/.test(ci.text), "CI must not be able to write");
    // In the release workflow the only write permission sits in the job that runs no project code.
    const writes = release.text.match(/contents:\s*write/g) ?? [];
    assert.equal(writes.length, 1);
    const publish = release.text.slice(release.text.indexOf("  publish:"));
    assert.match(publish, /contents:\s*write/);
    assert.ok(!/npm (ci|run|install|test)/.test(publish), "the job that can write must not run project code");
  });

  it("do not keep the token in the checkout", async () => {
    for (const { name, text } of await workflows()) {
      const checkouts = text.match(/actions\/checkout@/g)?.length ?? 0;
      const safe = text.match(/persist-credentials:\s*false/g)?.length ?? 0;
      assert.equal(safe, checkouts, `${name}: every checkout needs persist-credentials: false`);
    }
  });
});
