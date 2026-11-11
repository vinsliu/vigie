<!--
Branch from `dev` and open this PR against `dev` (not `main`: only release PRs target main).
The title is the commit message once squashed, so it must follow Conventional Commits:
  feat(ui): add a period filter        fix: close the drawer on a click outside
-->

## What and why

<!-- What changes for the user or the maintainer, and why. Link the issue if there is one: "Closes #123". -->

## Checklist

- [ ] `npm run check` passes (typecheck, tests, build)
- [ ] New behaviour has a test, or the PR says why it cannot
- [ ] Nothing reads from, or writes to, Claude's files; nothing runs a command for the user
- [ ] No real transcript, path or secret in code, fixtures, screenshots or this description
- [ ] UI: no `innerHTML`, no inline style (positions go through `el.style`), only the three colors
- [ ] User-facing change: README and screenshots updated (`npm run demo`), entry added under `[Unreleased]` in CHANGELOG.md
