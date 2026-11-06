# weblounge-client: agent guide

A modern IRCv3 client (web/PWA, Tauri desktop, Tauri iOS/Android) built on papo.

## Read first
- `docs/PLAN.md`: where the project stands and what's next. Update it when you finish a task.
- `docs/design/`: the signed-off design docs; follow them. If implementation shows a design is wrong, stop and say so instead of silently diverging.
- `docs/reference/brief.md`: the build brief. It is the spec.
- `docs/reference/split-view.md`: the desktop split-view requirement (an addendum to the brief's §5.2).
- `docs/reference/prototype/*.dc.html`: the interactive prototype's source. It is the source of truth for **layout, look and behaviour**, but it was built with throwaway tech: **never port its code**, only its behaviour, tokens and structure.
- papo (the IRCv3 library we build on): `~/papo` (local checkout) / https://github.com/luizribeiro/papo. Read its API before designing anything that touches protocol. Never re-implement what papo does; if something is missing, write it down as a question for Luiz.
- Brand assets: `~/weblounge/web/styles/tokens.css`, `~/weblounge/web/images/{favicon,chair,wordmark}.svg`.

## Process
- Design first: every subsystem in brief §7 gets a short doc in `docs/design/` (problem, types, boundaries, out of scope, testing) **before** implementation. Large work waits for Luiz's review of its design.
- Build vertically: one thin end-to-end slice before widening.
- Run project tools through the dev shell (`nix develop -c pnpm …`, `nix develop -c cargo …`); they are not on PATH outside it. Build the app with `nix build --no-link .#app` (the flake has no default package). Never pass options that override Nix safety (min-free/max-free, sandbox), hooks or signing, and never use `nix build --rebuild` (clippy output isn't deterministic).
- Make invalid states unrepresentable; one source of truth per concern; DRY.

## Code standards
See brief §7 "Code standards" and "Testing". In short: TS strict, no `any`, exhaustive unions; Rust clippy + rustfmt, `thiserror`, no `unwrap` outside tests; Biome; small files and functions; one component per file; feature-sliced folders; tokens only, no raw colours.

Comments explain *why* (a current constraint), never *what*. Prefer extracting a well-named function to writing a comment.

## Done means a user can see it work
Unit and engine tests are not enough: twice a task passed every check while the feature was broken in the browser. Any task that changes what a user sees ships a Playwright test that drives the built app the way a person would (against the flake's local Ergo when IRC is involved), and the dev server (`pnpm --filter @weblounge/app dev`) must keep working. Before reporting done, run the app and use the feature yourself.
Every UI task must also keep the Playwright `nativeFeelAudit` and its idle/hidden checks green.
Tests wait for conditions, never for time: no fixed sleeps, retries, `test.slow()` or raised timeouts to make a test pass. A flaky test is a bug to root-cause. The `test-wait-policy` hook enforces this; the only exemption is a wait that measures a fixed window, marked `// wait-ok: <why>`.

## Waiting on long jobs
Every model call re-sends the whole session, so polling and big outputs burn quota even when cached. Block on a long job (Playwright, nix builds, CI) with one wait of up to 45 minutes instead of checking it repeatedly. Don't print large logs or JSON into the session: filter to the failing test, the error and a few lines of context (`tail`, `grep`, `--reporter=line`). Report when something changes, not while waiting.

## Commits
- One commit = one idea. If the message needs "and", split it.
- Commit after each small unit (a function with its tests, a single doc, a single fix). Aim for < ~5 files and < ~100 changed lines per commit (design docs may be longer, but one doc per commit).
- Tests go in the **same** commit as the code they test.
- Before each commit, run the fast checks that cover the change: the pre-commit hook (formatting, lint, clippy, typecheck, generated protocol types), unit tests for the touched code, and every Playwright spec file for each area you touched (not only your new tests: running too few has repeatedly broken CI). The full suites run in GitHub Actions on every push; a red CI is fixed before any new work.
- The host is shared and often overloaded: locally run only the specs that cover your change (GitHub CI runs the full matrix). Run heavy commands (Playwright, nix builds of checks, workspace cargo tests) under `nice -n 10`, cap Playwright at `--workers=2`, and use `nix build --max-jobs 2 --cores 4` for VM- or browser-heavy checks. If the 1-minute load is 40 or more, wait (`while [ "$(cut -d. -f1 /proc/loadavg)" -ge 40 ]; do sleep 30; done`) before a browser run: results under that load are unreliable. Reuse nix-store builds of the app/wasm instead of rebuilding them per worktree.
- Never push, never rewrite history.
