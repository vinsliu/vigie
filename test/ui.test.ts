import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const UI = fileURLToPath(new URL("../ui/", import.meta.url));
const read = (f: string) => readFile(join(UI, f), "utf8");

// The server sends `default-src 'self'; style-src 'self'; script-src 'self'` and the UI renders untrusted
// transcript text. These checks keep it that way: they fail when a change brings back something the CSP
// would block, or an HTML sink that could turn transcript text into markup.
const SINKS: Array<[string, RegExp]> = [
  ["innerHTML / outerHTML", /\b(inner|outer)HTML\b/],
  ["insertAdjacentHTML", /insertAdjacentHTML/],
  ["document.write", /document\.write/],
  ["eval", /\beval\s*\(/],
  ["new Function", /new\s+Function\s*\(/],
  ["a style attribute built as text", /setAttribute\(\s*["']style["']/],
  ["style=\"…\" inside a string", /["'`][^"'`\n]*\sstyle\s*=\s*["']/],
];

/** Comments may mention these words ("never innerHTML"): only look at the code. */
const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const violations = (code: string) => SINKS.filter(([, re]) => re.test(stripComments(code))).map(([what]) => what);

describe("UI stays CSP-clean and renders text safely", () => {
  it("detects the patterns it is meant to forbid, and ignores comments", () => {
    assert.deepEqual(violations('el.innerHTML = "x";'), ["innerHTML / outerHTML"]);
    assert.deepEqual(violations("div.insertAdjacentHTML('beforeend', t)"), ["insertAdjacentHTML"]);
    assert.deepEqual(violations('el.setAttribute("style", "left:1px")'), ["a style attribute built as text"]);
    assert.deepEqual(violations("const m = `<i style=\"left:${x}%\"></i>`;"), ['style="…" inside a string']);
    assert.deepEqual(violations("eval(code); new Function('x')").sort(), ["eval", "new Function"]);
    // Allowed: CSSOM styling, textContent, and the words appearing only in comments.
    assert.deepEqual(violations("el.style.left = `${x}%`; Object.assign(el.style, { top });"), []);
    assert.deepEqual(violations("el.textContent = t; // never innerHTML\n/* no eval( here */"), []);
    assert.deepEqual(violations('const ns = "http://www.w3.org/2000/svg"; el.append(x);'), []);
  });

  it("has no inline script, style element or style attribute in the page", async () => {
    const html = await read("index.html");
    assert.ok(!/<style[\s>]/i.test(html), "inline <style>");
    assert.ok(!/\sstyle\s*=/i.test(html), "inline style attribute");
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), "inline <script>");
    assert.ok(!/\son[a-z]+\s*=/i.test(html), "inline event handler");
  });

  it("uses no HTML sink, eval, or inline-style markup in any UI script", async () => {
    const files = (await readdir(UI)).filter((f) => f.endsWith(".js"));
    assert.ok(files.includes("app.js") && files.includes("watch.js") && files.includes("theme.js"));
    for (const f of files) assert.deepEqual(violations(await read(f)), [], `${f} breaks the CSP / text-only rules`);
  });
});
