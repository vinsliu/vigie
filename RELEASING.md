# Releasing Vigie

For maintainers. The branch model and the day-to-day flow are in [CONTRIBUTING.md](CONTRIBUTING.md).

- `main` holds released, stable code. `dev` integrates ongoing work.
- Versions follow [SemVer](https://semver.org/): `0.x` while the interface may still change, a patch (`0.1.1`) for fixes only, a minor (`0.2.0`) for features.
- Nothing is published to npm: a release is a tag plus a GitHub release.

## Cut a release

1. **Prepare on `dev`.** Branch `chore/release-X.Y.Z` from `dev`, then:
   - set the version: `npm version X.Y.Z --no-git-tag-version`;
   - in `CHANGELOG.md`, rename `[Unreleased]` to `[X.Y.Z] - YYYY-MM-DD` and add an empty `[Unreleased]` above it;
   - open a PR against `dev` titled `chore(release): X.Y.Z`, and merge it once CI is green.
2. **Promote to `main`.** Open a PR from `dev` to `main` titled `release: vX.Y.Z`. Merge it with a **merge commit** (not squash), so `dev` stays an ancestor of `main`.
3. **Tag `main`.**

   ```bash
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "Vigie vX.Y.Z"
   git push origin vX.Y.Z
   ```

   The Release workflow checks that the tag matches `package.json` and sits on `main`, runs `npm run check`, and creates the GitHub release with the notes of that CHANGELOG section. If the CHANGELOG has no such section, it fails before publishing anything.
4. **Realign `dev`.** `git switch dev && git pull --ff-only origin main && git push origin dev`. This is a fast-forward, because `dev` is an ancestor of `main`: no new content is pushed.

   **Never delete `dev` when the release PR is merged.** `dev` is the head branch of that PR, and the repository setting "Automatically delete head branches" would remove it (this happened once on the first promotion, and `dev` was restored from a local copy). That setting must stay **off** while `main` and `dev` are not protected. Delete other branches yourself after merging: `gh pr merge --squash --delete-branch`.

## Urgent fix on a released version

1. Branch `fix/<topic>` from `main`, open a PR **against `main`** titled `fix: …`, merge it with a squash.
2. Bump the patch version and the CHANGELOG in the same PR, then tag `main` as above.
3. Bring the fix back: `git switch dev && git merge origin/main`, and push `dev` through a PR if it is protected.

## Before the repository goes public

Branch protection cannot be enabled while the repository is private on a free plan (GitHub answers "Upgrade to GitHub Pro or make this repository public"). Until then the rules are conventions. When it becomes public, enable them, for example for `main` (repeat for `dev`):

```bash
gh api -X PUT repos/vinsliu/vigie/branches/main/protection --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "test (ubuntu-latest, 22.18)", "test (ubuntu-latest, 24)",
      "test (macos-latest, 22.18)", "test (macos-latest, 24)",
      "pr-title"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0 },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON
```

This payload could not be tested yet for the reason above: check the status names against a real PR first. `enforce_admins: false` lets the owner bypass in an emergency; set it to `true` for a strict flow. Also enable private vulnerability reporting (Settings, Security).
