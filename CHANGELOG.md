# Changelog

Notable changes to Vigie. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/). While the version is 0.x, the interface and options may still change between minor versions.

## [Unreleased]

### Added

- A local-only dashboard for Claude Code sessions, read from `~/.claude`: list, session page with its timeline, tree of sub-agents (each loaded on demand), and cost statistics by day, project and model.
- "The watch": a timeline with one lane per project; short sessions are dots, long ones bars, size follows cost, overlapping sessions are stacked, a running session pulses at "now". Zoom on 24 h, 7 d or 14 d.
- A floating sidebar that follows the page (list filters, timeline filters and sub-agent shortcuts on a session, period on Stats) and a floating header with search (`/`).
- Pin, archive and rename a session, and copy its resume command. Stored in Vigie's own `meta.json`; Claude's files are never modified.
- Theme menu (Auto, Light, Dark) and an accent color chosen by the user, stored in the browser.
- Best-effort masking of secrets (API keys, tokens, private keys, credentials in URLs) before text reaches the browser.
- A running session shows "–" for its cost, with an explanation: Claude records it when the session pauses or ends.
- `npm run demo`: made-up sessions to try or photograph Vigie without exposing real ones.
- Live refresh through Server-Sent Events.
- Development workflow: `main` and `dev` branches, Conventional Commits, pull request and issue templates, CI on Linux and macOS (Node 22.18 and 24), tagged releases.
