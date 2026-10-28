# Plan and progress

The single place a fresh session reads to know where the project stands. Update it in the same commit that completes a task.

## Status

- **Milestone 1 (design):** done. Docs in `docs/design/`, signed off by Luiz on 2026-10-27. Engine edge cases from papo's maintainer: `docs/design/edge-cases.md`.
- **Milestone 2 (vertical slice, both shells):** in progress.

## Milestone 2 tasks

Each task is one fresh codex session, reviewed before the next starts. The orchestrating session pushes `main` to https://github.com/luizribeiro/weblounge-client after each reviewed task; codex sessions never push.

1. [x] Flake, Rust workspace (papo pinned by git rev), SolidJS app skeleton, `nix flake check`, GitHub Actions.
2. [x] wasm engine in a SharedWorker (dedicated Worker fallback) talking to the UI through `EngineClient`; local Ergo for dev.
3. [x] Engine connects through papo; network and buffer state; protocol types generated with ts-rs.
3a. [x] Design doc `15-selection-and-native-feel.md` (brief §2): selectable surfaces, copy-as-IRC-text, the context-menu hook, motion tokens, base CSS defaults and primitives (`selectable`, `Line`), and a Playwright native-feel audit (chrome not selectable, no I-beam or browser context menu on chrome, selection doesn't spill, no layout shift on font load) plus idle/hidden-tab waste checks. Task 4 and later UI tasks must pass the audit in CI.
3b. [x] Fix engine slice findings from manual testing and code review.
4. [x] Desktop shell: sidebar buffer list, single pane, Lounge and Lounge Night themes following the system.
4b. [x] Member list.
5. [x] Message list (virtualised one-line timeline, read state, latest history, and membership runs).
5b. [x] Message list fixes (scrolling, logo, bottom anchor, real screenshots, and copy coverage).
6. [x] Composer with optimistic send (`Sent`-based confirmation).
6b. [x] Composer fixes (engine-owned navigation and completion, human errors, stable guarded drafts, and refreshed screenshots).
7. [x] Mobile shell: chats list and pushed chat screen.
7b. [x] Mobile shell fixes (inline rows, compact previews, history, swipe cancellation, consistent times, DM previews, and routing/read tests).
7c. [x] Mobile members drawer.
7d. [ ] Mobile and PWA polish, iPhone 16 Pro as the reference device (Android first-class too): manifest, icons and iOS launch images, standalone display, status-bar colour per theme under the Dynamic Island (`theme-color` per light/dark, translucent iOS status bar), safe areas from `env()` only (Dynamic Island, home indicator, landscape), `100dvh` fixed root, composer above the keyboard on iOS and Android, no input zoom/double-tap zoom/rubber-band/pull-to-refresh/callouts on chrome, swipe-back not fighting Safari's edge swipe, Android back via the stack, Dynamic Type/font scaling, minimal app-shell service worker. Tested with Playwright WebKit (iPhone 16 Pro profile) and an Android profile; Luiz's phone is the final check once beta.weblounge.org exists.
7e. [x] Perf scenarios run several times and report the median (single runs quantise to whole frames and are noisy under throttling).
8. [ ] Local Ergo configured like weblounge (from `~/weblounge/services/ergo.nix`: SASL required, always-on, persistent channel history, DM history disabled, read markers) reached over `wss://` through a local TLS proxy, as an end-to-end check. Testing against the real server waits for beta.weblounge.org (milestone 4).

## After milestone 2

- **Milestone 2.5 (brought forward by Luiz):** split view and the core keyboard shortcuts.
- **Milestone 4 (Luiz, 2026-10-28): hosted mode at beta.weblounge.org first** — concierge OAuth as gamja does, deployed from the weblounge NixOS config, `https://beta.weblounge.org` added to Ergo's `allowed-origins`. Luiz and friends try it there (including on phones, installed as a PWA); replacing gamja at irc.weblounge.org is the last step once the beta has proven itself.

## External dependencies

- **papo:** pinned at `7d5e4bf`. Breaking changes approved for 0.1 are in flight (guarded `client.direct(nick)`, `Sent::Confirmed|Unconfirmed`, `name_rules()` unavailable before 005, per-conversation lag gaps). The engine wraps DM sending and name storage in its own small types so adopting them stays local. papo 0.1.0 is tagged after this milestone's slice works on it.
