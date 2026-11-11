# agents-dashboard

A lightweight, **local-only** dashboard to browse every Claude session on your machine — whether it was started from the Claude desktop app, the CLI or the VS Code extension.

```bash
npx agents-dashboard
# → http://127.0.0.1:4317
```

## Scope

- **Local only.** It reads the session files Claude already writes in `~/.claude` (or `$CLAUDE_CONFIG_DIR`). No account, no cloud, no telemetry, no outgoing request.
- Remote sessions (Claude Code on the web, other machines, SSH hosts) are out of scope. Each machine has its own view.
- **Read-only** for now. Management actions (rename, pin, resume) come later.

## Features (MVP)

- Session list: project, client (desktop / CLI / VS Code), title, last activity, cost, live status.
- Session detail: timeline of messages and tool calls, token totals.
- Stats: total cost, daily cost chart (last 30 days), breakdown by project and by model.
- Live refresh through Server-Sent Events.

> Costs per session, project and model come straight from Claude's own cost data. The cost of a given *day* is an estimate: a session's cost is spread over the days it ran, in proportion to the tokens used.

## Design goals

- **Light**: zero runtime dependencies, no database, no front-end build step. The JSONL transcripts stay the single source of truth.
- **Cheap on big files**: the list only reads the head and tail of each transcript; a full transcript is streamed only when you open it.
- **Private**: the server binds to `127.0.0.1` only and rejects any request whose `Host` header is not local (DNS-rebinding protection). Transcripts are rendered as plain text, never as HTML.

## Development

Requires Node.js 22.18 or newer (native TypeScript execution).

```bash
npm install
npm start          # run from sources
npm test           # node:test with anonymised fixtures
npm run typecheck
npm run build      # emits dist/ for publishing
```

Options: `--port <n>` (default `4317`), `--claude-dir <path>`.

## Layout

```
src/core/    JSONL parsing, session index, live process detection
src/server/  HTTP API, SSE, host guard
ui/          static HTML / CSS / vanilla JS
test/        tests and fixtures
```

## Disclaimer

The transcript format is not a documented public API and may change between Claude versions. The parser is deliberately tolerant and ignores unknown records.

## License

MIT
