# Contributing to Vigie

Thanks for looking. Vigie is small on purpose, so a few ground rules keep it that way.

## Ground rules

- **Local only.** The server binds to `127.0.0.1`, makes no outgoing request and has no telemetry. Nothing that changes that will be merged.
- **Never modify Claude's files.** Transcripts and anything else under `~/.claude` are read-only. Anything Vigie needs to remember goes in its own `meta.json` (`--data-dir`).
- **Never run commands for the user.** "Resume" gives a command to copy, it does not execute it.
- **Zero runtime dependencies, no database, no front-end build step.** Dev dependencies are fine; a dependency that ships to users needs a very good reason.
- **The UI stays CSP-clean**: no inline scripts or styles, and transcript text is rendered with `textContent`, never as HTML.
- **The transcript format is undocumented.** Parse tolerantly: ignore unknown records and invalid lines rather than failing.

## Setup

Node.js 22.18 or newer.

```bash
git clone https://github.com/vinsliu/vigie && cd vigie
npm install
npm start          # http://127.0.0.1:4317, reads ~/.claude
npm run demo       # http://127.0.0.1:4318, made-up data only
```

Before a pull request:

```bash
npm run typecheck
npm test
npm run build
```

The same three steps run in CI on Linux and macOS, Node 22.18 and 24.

## Tests and fixtures

Tests use `node:test` and the anonymised fixtures in `test/fixtures/`. **Never commit a real transcript**, and never paste one in an issue: it can contain code, paths and secrets. Reproduce with `npm run demo`, or write a small fake fixture that shows the problem. Fake secrets in tests must be assembled at runtime (see `test/redact.test.ts`) so that secret scanners do not flag the repository.

## Secret masking

`src/core/redact.ts` masks secrets before text reaches the browser. It is best effort. If you find a common format it misses, add a pattern **and** a test for it, plus a test showing ordinary text is left alone: false positives (code, prose) hurt as much as misses.

## Supporting another session format

The core assumes Claude Code's transcripts. Another source (for example Cowork's `audit.jsonl`, or another tool) would need its own reader that produces the same `SessionSummary` / `SessionDetail` shapes (`src/core/types.ts`). Open an issue first to agree on the shape before writing a large patch.

## Reporting a security problem

Please do not open a public issue. Use GitHub's private vulnerability reporting on the repository's Security tab.
