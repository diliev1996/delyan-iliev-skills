---
name: frontend-pr-evidence
description: "Use when opening or updating a PR that changes UI, or when asked for before/after screenshots or video evidence."
---

# Frontend PR evidence

Record the PR's merge base and head with identical fixtures, viewport, and interactions, then post both recordings as one PR comment through `gh`. The repository's PR skill owns the PR body. `$SCRATCH` means the session scratch directory. Run the bundled scripts by their absolute paths.

## Steps

1. **Resolve revisions.** Read `baseRefName` and `headRefOid` from `gh pr view PR_URL --json baseRefName,headRefOid`. Run `git fetch origin BASE_BRANCH pull/PR_NUMBER/head`, then `git merge-base origin/BASE_BRANCH HEAD_SHA`. Done when both SHAs resolve locally.
2. **Build both revisions.** Done when each revision has a built output folder or a running dev server, and its source matches its SHA.
3. **Write the flow** under `$SCRATCH`, starting from [the example](examples/flow.cjs) and following the flow interface below.
4. **Capture** with `node scripts/capture.cjs FLOW "$SCRATCH/evidence"`. When it fails, its error names the fix: the install command, a navigation away from the app, or a highlight problem. Selector failures also leave `failure.png` and `failure-aria.yml` in the output folder. Fix the flow and rerun. Done when:
   - the command exits 0;
   - every `manifest.network` entry is explained (in a mocked run, each one is an unmocked call);
   - `comparison.png` frames the change in both phases;
   - `video-contact-sheet.png` shows the cursor reaching each target and the final state held.
5. **Publish** with `node scripts/publish.cjs "$SCRATCH/evidence" PR_URL`. It confirms the evidence matches the PR's current head and merge base, posts `comment.md` with the comparison and video attached, and checks that GitHub hosts both. Rerunning it for the same capture reuses that comment. If `gh auth status` shows a missing login, ask the user for that step only. If publishing stays blocked, keep the artifacts and report the exact error. Done when it prints the comment URL.
6. **Link** the comment URL from the PR body's evidence section. Done when the PR body links the URL `publish.cjs` printed for the current head, replacing any earlier evidence link.
7. **Clean up** the servers and worktrees you started. Keep artifacts, cookies, and storage-state files out of source control.

## Flow interface

A flow module exports:

- `description`: the tested interaction and whether data is mocked or live. It becomes the comment text.
- `phases`: two `{ label, revision, url | dir, run }` entries, Before then After. `dir` is a built output folder, served by the helper with client routes falling back to `index.html`. `url` points at a running dev server.
- `viewport` (optional, default 1440×900).
- `setup(page, phase)` (optional): runs before each phase's first navigation, on a page with routes, init scripts, cookies, and storage reset. Register mocks, seeds, and auth fixtures here. Routes match newest first, so register a catch-all abort before the specific mocks.
- `warmup(page, phase)` (optional): runs unrecorded after the page loads, for example while a dev server compiles.
- `run(page, tools)`: performs the interaction and asserts each phase's expected state, using `tools.click(locator)`, `tools.point(locator)`, and `tools.highlight(locator, label?)`. Each phase needs at least one highlight, still visible when `run` returns.

Outputs: `before.png`, `after.png`, `comparison.png`, `comparison.webm`, `video-contact-sheet.png` (the video as timestamped frames), `manifest.json`, and `comment.md`.

**Authenticated apps.** The helper's Chromium starts with no logins: browser sessions elsewhere and `gh` authentication do not reach it. Reproduce the signed-in state in `setup`; the example shows two ways. If live authenticated evidence is required and the capture context cannot reach it, report the limitation and the checks actually performed.

After changing the scripts or upgrading Playwright, run `node scripts/capture.test.cjs`. Set `CAPTURE_TEST_OUTPUT=DIR` to keep its artifacts, and `PLAYWRIGHT_MODULE=PATH` to test another Playwright install.
