# Contributing to Vigie

Thanks for looking. Vigie is small on purpose, so a few ground rules keep it that way.

## Ground rules

- **Local only.** The server binds to `127.0.0.1`, makes no outgoing request and has no telemetry. Nothing that changes that will be merged.
- **Never modify Claude's files.** Transcripts and anything else under `~/.claude` are read-only. Anything Vigie needs to remember goes in its own `meta.json` (`--data-dir`).
- **Never run commands for the user.** "Resume" gives a command to copy, it does not execute it.
- **Zero runtime dependencies, no database, no front-end build step.** Dev dependencies are fine; a dependency that ships to users needs a very good reason.
- **The UI stays CSP-clean**: no inline scripts or styles, and transcript text is rendered with `textContent`, never as HTML. Positions and sizes are set from JavaScript through `el.style`, never as a `style="…"` attribute. `test/ui.test.ts` fails if `innerHTML`, `eval` or an inline style comes back.
- **Three colors**: the UI uses a background, a text and an accent color (chosen by the user); every other shade is a `color-mix()` of those. Please do not add new hues.
- **The transcript format is undocumented.** Parse tolerantly: ignore unknown records and invalid lines rather than failing.

## Setup

Node.js 22.18 or newer.

```bash
git clone https://github.com/vinsliu/vigie && cd vigie
npm install
npm start          # http://127.0.0.1:4317, reads ~/.claude
npm run demo       # http://127.0.0.1:4318, made-up data only
```

## Workflow

Two long-lived branches:

- **`main`** is stable: what the README tells people to install, and where releases are tagged.
- **`dev`** is where work is integrated. It is the base of every pull request.

```
feat/period-filter ─┐                         ┌─ tag v0.2.0
fix/drawer-close ───┼─► PR (squash) ─► dev ─► PR (merge) ─► main
chore/ci-cache ─────┘
```

1. Branch from `dev`: `feat/<topic>`, `fix/<topic>`, `docs/<topic>`, `refactor/<topic>`, `chore/<topic>`.
2. Commit with [Conventional Commits](https://www.conventionalcommits.org/): `feat(ui): add a period filter`, `fix: close the drawer on a click outside`. Types: `feat fix docs style refactor perf test build ci chore revert`. Run `npm run hooks` once per clone to have this checked locally.
3. Before pushing, run `npm run check` (typecheck, tests, build). CI runs the same on Linux and macOS, Node 22.18 and 24.
4. Open a pull request **against `dev`**. Its title must be conventional too: it becomes the commit message when squashed. Fill in the checklist.
5. User-facing change? Add a line under `[Unreleased]` in `CHANGELOG.md`, and refresh the README and screenshots if the interface changed.
6. Once CI is green, the PR is squash-merged into `dev` and its branch is deleted.

Never push straight to `main` or `dev`. Releases and urgent fixes are described in [RELEASING.md](RELEASING.md).

## Tests and fixtures

Tests use `node:test` and the anonymised fixtures in `test/fixtures/`. **Never commit a real transcript**, and never paste one in an issue: it can contain code, paths and secrets. Reproduce with `npm run demo`, or write a small fake fixture that shows the problem. Fake secrets in tests must be assembled at runtime (see `test/redact.test.ts`) so that secret scanners do not flag the repository.

## The watch and other UI logic

Anything that is not DOM work lives in a pure module so it can be tested: the layout of "The watch" (axis ticks, dots versus bars, stacking of overlapping sessions) is in `ui/watch.js` and covered by `test/watch.test.ts`. Dates are handled in local time, and those tests run in any time zone. Keep new logic of that kind out of `ui/app.js`.

## Secret masking

`src/core/redact.ts` masks secrets before text reaches the browser. It is best effort. If you find a common format it misses, add a pattern **and** a test for it, plus a test showing ordinary text is left alone: false positives (code, prose) hurt as much as misses.

## Supporting another session format

The core assumes Claude Code's transcripts. Another source (for example Cowork's `audit.jsonl`, or another tool) would need its own reader that produces the same `SessionSummary` / `SessionDetail` shapes (`src/core/types.ts`). Open an issue first to agree on the shape before writing a large patch.

## Reporting a security problem

Please do not open a public issue. Use GitHub's private vulnerability reporting on the repository's Security tab.
