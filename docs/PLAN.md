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
4c. [x] Member window fixes (per-view live ranges, bounded delta delivery, shell-correct virtualization, and scrolling performance).
5. [x] Message list (virtualised one-line timeline, read state, latest history, and membership runs).
5b. [x] Message list fixes (scrolling, logo, bottom anchor, real screenshots, and copy coverage).
6. [x] Composer with optimistic send (`Sent`-based confirmation).
6b. [x] Composer fixes (engine-owned navigation and completion, human errors, stable guarded drafts, and refreshed screenshots).
6c. [x] One `Command` table (derive macro producing `CommandSpec`s, from `docs/design/commands-catalog.md`, M2 subset), renames (`EngineRequest`, action registry), action registry fed by UI actions + engine `CommandSpec`s.
6d. [x] Composer suggestions popup for `/`, `@`, `#` (engine-backed, compact, and consistent on desktop and mobile).
6e. [x] Command policy fixes (runtime-owned parsing, aliases, completion and help; secret redaction; derived gating; inline confirmation in both shells; cached topic notices).
6f. [x] Suggestions polish (opaque surfaces, concise rows, deliberate ranking, focus retention, stable updates, and no layout shift).
7. [x] Mobile shell: chats list and pushed chat screen.
7b. [x] Mobile shell fixes (inline rows, compact previews, history, swipe cancellation, consistent times, DM previews, and routing/read tests).
7c. [x] Mobile members drawer.
7d. [ ] Mobile and PWA polish, iPhone 16 Pro as the reference device (Android first-class too): manifest, icons and iOS launch images, standalone display, status-bar colour per theme under the Dynamic Island (`theme-color` per light/dark, translucent iOS status bar), safe areas from `env()` only (Dynamic Island, home indicator, landscape), `100dvh` fixed root, composer above the keyboard on iOS and Android, no input zoom/double-tap zoom/rubber-band/pull-to-refresh/callouts on chrome, swipe-back not fighting Safari's edge swipe, Android back via the stack, Dynamic Type/font scaling, minimal app-shell service worker. Tested with Playwright WebKit (iPhone 16 Pro profile) and an Android profile; Luiz's phone is the final check once beta.weblounge.org exists.
7e. [x] Perf scenarios run several times and report the median (single runs quantise to whole frames and are noisy under throttling).
7f. [ ] First paint and loading: inline splash (theme background, large tinted chair mark), metrics-matched font fallback, ≤200ms cross-fade, CI filmstrip test (no blank/white frames, no font shift; light/dark, Chromium+WebKit, slow network).
8. [ ] Production-shaped local Ergo profile and `wss://` TLS proxy are available through `nix run .#ergo-weblounge`; origin-refused connections now show a human error. The profile matches SASL-required registration, always-on, persistent channel and opt-out DM history, read markers, and the production command policy. Remaining scenarios: WSS/SASL/autojoin, always-on channel and DM catch-up, channel and DM history across an Ergo restart, read-marker sync between browser contexts, and the profile-level origin-refusal assertion. Redaction remains optional until client support exists. Testing against the real server waits for beta.weblounge.org (milestone 4).
8b. [ ] End-to-end perf scenarios through the engine and worker: cold/warm start, buffer switch, 2,000-message burst, reconnect, typing latency (doc 21 budgets).

## After milestone 2: dogfood first (Luiz, 2026-10-28)

Order: finish 6c and 6d, then 8, then the dogfood slice, then 7d/7f/8b, then beta.weblounge.org. Luiz dogfoods it and gives feedback; split view and the core shortcuts come after, informed by real use.

- **Dogfood slice** (minimal milestone 3):
  - [ ] Fix joined-channel history timestamps/order. The production profile reproduced the beta
    bug: papo drops the continuation text and opening `server-time` from a
    `draft/multiline-concat` batch nested in `CHATHISTORY`, so the engine can only fall back to
    receipt time. Same-msgid live/history overlap now enriches an untimed row instead of dropping
    the history metadata; ordinary PRIVMSG and NOTICE replay preserves server time.
  - D1. [ ] Load older history on scroll-up (`CHATHISTORY BEFORE` with msgid cursors; scroll anchoring already exists).
  - D2. [ ] Rebuild the DM list from `CHATHISTORY TARGETS` on connect.
  - D3. [x] Clean resume after reconnect: papo catch-up gap fill and `Lagged` resync; one
    engine-owned lifecycle; quiet desktop/mobile indicators; visible-only worker liveness and
    transparent respawn; ordered in-memory composer sends across network reconnects. Desktop and
    iPhone 16 Pro WebKit cover background/server loss, browser offline, worker termination, Ergo
    restart, hosted-token expiry, and preservation of the established shell, draft, and message
    viewport. The in-memory send queue cannot survive worker termination.
  - [x] Preserve the sender's highest channel prefix on optimistic and confirmed own messages;
    confirmation re-snapshots current membership, while DMs remain unprefixed. Engine coverage
    spans owner, operator, voice, plain, mode changes during send, and DMs; local Ergo proves `@`
    before and after browser confirmation.
  - [x] Keep engine buffer order deterministic: server first, channels by casemapped name without
    `#`/`&`, and direct messages by latest activity with a casemapped nick tiebreaker. Desktop and
    mobile consume the same engine order; shuffled joins remain stable across three reloads.
  - [x] Generate home-screen, favicon, and maskable icons from the canonical chair artwork during
    the build. The self-hosted install manifest and Apple metadata ship in the hosted artifact;
    production validation covers image dimensions and Apple opacity, and the browser fetches every
    declared asset under the app's CSP.
  - [x] Centralize platform adaptation behind one capability environment. Primary input selects the
    shell while the 760px breakpoint only changes desktop panel presentation; narrow desktop uses
    one mirrored overlay drawer without remounting conversation state. Safe-area and keyboard
    tokens cover iPhone portrait/landscape and Android gesture navigation, with a repository policy,
    native-feel geometry audit, and light/dark reference captures.
  - [x] Close engine bugs found in the papo API review: DM buffers own and release their MONITOR
    leases without history or channel traffic consuming slots; a full MONITOR list degrades only
    presence while direct sends continue; own-nick completion uses IRC casemapping; and historical
    rows never inherit an actor's current channel prefix.
- **Polish pass before beta:** screen by screen (desktop and mobile, light and dark) against the prototype source: spacing, button styles, typography, time formats, badges, icons, everything in `docs/polish-notes.md`, and the desktop focus policy from doc 15 with Playwright tests. Before/after screenshots for every fix. (The mobile focus rules and keyboard behaviour belong to 7d.)
- **Milestone 4 at beta.weblounge.org:**
  - B1. [x] Hosted-mode build configuration and the concierge OAuth handover (design 03).
  - B1b. [x] Hosted sign-in hardening: explicit production config, redacted request secrets,
    immediate callback cleanup, and issuer-origin endpoint validation.
  - B2. [ ] NixOS deployment changes prepared in `~/weblounge` as a branch for Luiz to review: the static site at beta.weblounge.org and `https://beta.weblounge.org` in Ergo's `allowed-origins`. Never pushed or deployed by agents.
- **Milestone 2.5 (after dogfooding):** split view with per-pane member lists, and the core keyboard shortcuts.
- **Milestone 4b:** replace gamja at irc.weblounge.org once the beta has proven itself.

## External dependencies

- **papo:** papo 0.1 pinned at `949bd5d`. Guarded directs, split-send reconciliation, exact multiline concatenation, server name rules, lag diagnostics, and channel-recreation warnings are integrated.
  - Question for Luiz: the production-profile Ergo test shows papo dropping replayed
    `draft/multiline-concat` continuation segments and the opening batch's `server-time` when the
    multiline batch is nested in a `CHATHISTORY` batch. The server sends and stores every segment
    with the timestamp; should this be fixed in papo before WebLounge relies on replaying long
    logical lines?
