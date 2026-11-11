# Security policy

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private vulnerability reporting: on the repository page, open the **Security** tab and choose **Report a vulnerability**. It is available once the repository is public; until then, contact the maintainer through GitHub.

Please include what you did, what you expected and what happened, the Vigie version or commit, and your Node.js version. Do not include real transcripts, paths or keys: a short made-up reproduction (see `npm run demo`) is better.

## Supported versions

The latest release. Before 1.0, only the latest `0.x` receives fixes.

## What Vigie protects against

Vigie is a local tool for **one user on their own machine**. It reads the session files Claude Code writes in `~/.claude` and shows them in a browser through a small server.

- **Other websites in your browser.** The server listens on `127.0.0.1` only and rejects any request whose `Host` is not loopback (DNS rebinding). The one write route requires a same-origin request, a JSON content type and a small body. Pages cannot be put in a frame (`frame-ancestors 'none'`).
- **Hostile text inside transcripts.** A transcript holds whatever a session saw, including text written by an attacker (a web page, a file). It is shown as plain text, never as HTML, under a strict Content Security Policy with no inline script or style. Secret masking and every read are bounded, so a crafted transcript cannot freeze the server or exhaust its memory.
- **The files it touches.** Claude's files are never written. Vigie keeps only its own `meta.json` (pins, names, archive flags) in a private folder, with a temporary file that cannot be pre-planted. Symbolic links are not followed. Vigie makes no outgoing request and never runs a command: the "resume" command is text for you to copy.

## What it does not protect against

- **Other users of the same machine.** There is no authentication. Anyone who can reach `127.0.0.1` on your machine, that is any local account, can read your sessions through Vigie's port. Do not run it on a shared machine.
- **Secrets in transcripts.** Masking is best effort and meant for screenshots and screen sharing. A secret in an unusual format is shown as is, and the transcripts themselves are not modified.
- **A compromised machine, browser or Claude installation.**
- **Windows**, for now: the tool is developed and tested on macOS and Linux.

## Releases and dependencies

Vigie has no runtime dependency. Its development dependencies (TypeScript and its types) are updated through reviewed pull requests, and the GitHub Actions it uses are pinned to commits. Nothing is published to npm.
