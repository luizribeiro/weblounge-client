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
5c. [x] Wrapped-message virtualization fixes (measured row heights, live-edge and prepend anchoring, and received history/live coverage).
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
8. [ ] Production-shaped local Ergo profile and `wss://` TLS proxy are available through `nix run .#ergo-weblounge`; origin-refused connections now show a human error. The profile matches SASL-required registration, always-on, persistent channel and opt-out DM history, read markers, and the production command policy. Read-marker sync between independent browser contexts and paging through 1,000+ production-profile messages are covered. Remaining scenarios: WSS/SASL/autojoin, always-on channel and DM catch-up, channel and DM history across an Ergo restart, and the profile-level origin-refusal assertion. Redaction remains optional until client support exists. Testing against the real server waits for beta.weblounge.org (milestone 4).
8b. [ ] End-to-end perf scenarios through the engine and worker: cold/warm start, buffer switch, 2,000-message burst, reconnect, typing latency (doc 21 budgets).

## After milestone 2: dogfood first (Luiz, 2026-10-28)

Order: finish 6c and 6d, then 8, then the dogfood slice, then 7d/7f/8b, then beta.weblounge.org. Luiz dogfoods it and gives feedback; split view and the core shortcuts come after, informed by real use.

- **Dogfood slice** (minimal milestone 3):
  - [x] Keep joined-channel multiline history exact and chronologically ordered with papo
    `f0672c0`. Production-profile browser coverage sends Shift+Enter blank lines and bot split and
    multiline messages, then reconnects to assert one row, self authorship, member-line sender,
    and original server times. The post-open viewport stays pinned across a one-second frame trace;
    dogfood bug #46 no longer reproduces after the bump. The duplicate timestamp workaround is gone.
  - D1. [x] Load older history on scroll-up through an empty `CHATHISTORY BEFORE` page, with
    eviction-independent event cursors and exact ordering/deduplication across more than 1,000
    messages (scroll anchoring already exists).
  - [x] Requested history pages stay where they belong: papo `f0672c0` also emits each answered
    CHATHISTORY batch as a `Replay` event, which the engine had merged as a live append; Replay
    pages are now dropped when the server supports CHATHISTORY. A tab attaching to a running
    shared engine receives each buffer's retained rows. Open question for Luiz: should papo stop
    emitting the Replay copy for batches that answer a labeled request?
  - D2. [x] Rebuild the DM list from a 30-day `CHATHISTORY TARGETS` window on connect and
    reconnect, capped at 100 direct conversations and ordered by server-reported recent activity.
    Latest history hydrates desktop and mobile previews without disturbing older-page cursors.
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
    leases without history or channel traffic consuming slots; a full MONITOR list keeps the DM
    readable but disables unverified sends with a human reason; own-nick completion uses IRC
    casemapping; and historical rows never inherit an actor's current channel prefix.
  - [x] Size desktop timestamp columns from the active locale; never ellipsize times.
  - [x] Reset mobile back-swipe motion on cancellation, browser history, visibility, and interrupted transitions.
  - [x] Keep the mobile chat list mounted across back navigation without recreating rows on retained buffer updates or requesting history.
  - [x] Resubscribe desktop member windows when the active channel changes.
  - [x] Keep every touch text field at 16px or larger so focusing never zooms the page.
  - [x] Disable shell-level pinch and double-tap zoom while preserving root text scaling.
  - [x] Linkify safe message URLs and channel names on desktop and mobile.
  - [x] Keep a theme-correct loading splash until fonts and the engine snapshot are ready.
  - [x] Keep touch WebKit navigation replace-only in Safari tabs and standalone PWAs while Android retains a platform Back stack.
  - [x] Show an explicit Sign in again action when a hosted OAuth callback is missing state, has
    mismatched state, or reaches an expired authorization code instead of leaving a splash stalled.
  - [x] Keep composer suggestions mounted, locally narrowed, and keyed while engine updates are in flight.
  - [x] Submit exact composer completions on Enter and keep shell sizing CSP-safe.
  - [x] Let the desktop conversation reclaim the full width of collapsed side panels.
  - [x] Dim every overlay drawer with a theme-owned scrim in light and dark mode.
  - [x] Keep production consoles clean through desktop and mobile load, navigation, scrolling,
    sending, and member-list flows in Chromium, Firefox, and WebKit. Wasm initializes through
    the object API, and virtualizer offset and resize delivery avoid browser diagnostics.
  - [x] Sync read markers through papo on restore, live remote advances, and a 500ms foreground
    live-edge dwell. DMs count every peer message as a mention; unread-only rows keep the subtle
    dot while mentions use the accent count badge on both shells. Cross-context coverage targets
    the message list before invoking its End shortcut, independent of composer autofocus timing.
  - [x] Share axis-locked pan handling between mobile Back and the drag-to-close members drawer.
  - [x] Animate overlay drawers, scrims, and shadows as one progress-linked entrance and exit.
  - [x] Open channel members with a protected mid-screen pan while keeping browser-edge and history gestures platform-owned.
  - [x] Apply the bottom safe inset only at the active bottom surface; root lists scroll beneath it and composer padding takes the larger of its normal spacing and the inset.
  - [x] Remove home-indicator composer space while the software keyboard is open, following the keyboard motion without losing the live edge.
  - [x] Fill the iOS standalone layout viewport when `visualViewport` is shorter without a
    keyboard. Only a measured inset above 120px shrinks the mobile shell, preserving keyboard
    motion, effective safe-bottom handling, and live-edge pinning.
  - [x] Keep the transcript's touch-action boundary vertical so WebKit cannot cancel an in-app
    edge swipe while preserving long-press message selection.
  - [x] Synchronize desktop buffer routes in Firefox and restore the addressed channel on reload.
  - [x] Keep joined-buffer snapshots from overriding committed desktop selection before command
    focus arrives.
  - [x] Keep unresolved buffer routes above provisional startup fallbacks while explicit engine
    focus and user navigation remain authoritative.
  - [x] Show the pointer cursor for clickable URL and channel tokens in messages.
  - [x] Keep composer suggestions mounted while Backspace shrinks a pending engine query.
  - [x] Apply engine-owned nick addressing to explicit Tab completion and preserve it while cycling.
  - [x] Animate mobile button, keyboard, and Android Back through the same pop transition while swipe completion remains gesture-owned.
  - [x] Close the narrow-desktop member panel through the shared drawer exit motion.
- **Polish pass before beta:** screen by screen (desktop and mobile, light and dark) against the prototype source: spacing, button styles, typography, time formats, badges, icons, everything in `docs/polish-notes.md`, and the desktop focus policy from doc 15 with Playwright tests. Before/after screenshots for every fix. (The mobile focus rules and keyboard behaviour belong to 7d.)
  - [x] Apply the desktop focus policy after navigation, transient surfaces, sends, and member DMs; route printable chrome keys to the composer without taking navigation keys, dialog input, or text selection.
  - [x] Keep the initial splash visible through hosted OAuth exchange and engine connection; reveal only the ready shell or a human error, without an intermediate sign-in screen.
  - [x] Make startup and render failures retryable in place; standalone retries create a fresh worker and engine, while hosted retries restart authorization.
  - [x] Ellipsize long desktop message nicks within their fixed column while preserving a stable mode-symbol slot.
- **Milestone 4 at beta.weblounge.org:**
  - B1. [x] Hosted-mode build configuration and the concierge OAuth handover (design 03).
  - B1b. [x] Hosted sign-in hardening: explicit production config, redacted request secrets,
    immediate callback cleanup, and issuer-origin endpoint validation.
  - B2. [ ] NixOS deployment changes prepared in `~/weblounge` as a branch for Luiz to review: the static site at beta.weblounge.org and `https://beta.weblounge.org` in Ergo's `allowed-origins`. Never pushed or deployed by agents.
- **Milestone 2.5 (after dogfooding):** split view with per-pane member lists, and the core keyboard shortcuts.
- **Milestone 4b:** replace gamja at irc.weblounge.org once the beta has proven itself.

## External dependencies

- **papo:** papo 0.1 pinned at `f0672c0`. Guarded directs, split-send reconciliation, exact live
  and nested-history multiline concatenation, server name rules, lag diagnostics, and
  channel-recreation warnings are integrated.
  - Follow-up: adopt papo's planned `watch()` / free `direct()` operation with a per-send proof
    round trip so a full MONITOR list can still send without bypassing guarded-recipient safety.
