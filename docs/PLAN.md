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
7f. [x] First paint and loading: inline splash (theme background, large tinted chair mark), metrics-matched font fallback, ≤200ms cross-fade, CI filmstrip test (no blank/white frames, no font shift; light/dark, Chromium+WebKit, slow network).
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
  - [x] Requested history pages stay where they belong: papo `9ca82d9` consumes correlated
    CHATHISTORY responses instead of also emitting them as `Replay` events. The engine therefore
    accepts unrequested playback again, including when the server supports CHATHISTORY. A tab
    attaching to a running shared engine receives each buffer's retained rows.
  - [x] Pin papo `feaac6e` so registration and reconnect sends wait for numeric 001, guarded DMs
    wait for server-proven account state, and channel replies survive the own-JOIN race. Connection
    status and command gating already follow papo's post-001 `Connected` event; composer sends made
    during a failed reconnect now leave their optimistic row in an explicit failed state.
  - [x] Update papo to `d2c0db8`: live and replayed actor facts now share one projection, unknown
    bot/account facts remain distinct from proven negatives, browser-only endpoint rejection is
    human-readable, server-specific JOIN refusals finish without leaving a channel buffer, and
    post-registration SASL failures remain nonfatal warnings.
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
  - [x] Generate light and dark iOS startup images for current iPhone and iPad viewport families
    from the inline splash's colors, chair, and geometry. Exact device, scale, orientation, and
    appearance media queries bridge the home-screen icon to the stationary splash.
  - [x] Precache the versioned web app shell, engine Wasm, fonts, and icons with a small same-origin
    service worker after the first interactive frame goes idle. iOS fetches only its matching
    startup image; deployment config stays network-first with offline fallback; API, OAuth,
    session-token, and WebSocket traffic bypasses the worker; updates activate on a later launch.
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
  - [x] Keep the mobile chat list mounted across back navigation without recreating rows on retained
    buffer updates or requesting history. Scroll restoration follows user input, ignores focus and
    visibility adjustments, and iOS document-pan correction never handles inner scrollers.
  - [x] Resubscribe desktop member windows when the active channel changes.
  - [x] Keep the mobile member drawer subscribed to its owning channel across list navigation,
    deep-link reloads, DMs, swipe-back, and retained-screen transitions (#77).
  - [x] Keep every touch text field at 16px or larger so focusing never zooms the page.
  - [x] Disable shell-level pinch and double-tap zoom while preserving root text scaling.
  - [x] Linkify safe message URLs and channel names on desktop and mobile.
  - [x] Keep a theme-correct loading splash until fonts and the engine snapshot are ready.
  - [x] Paint the themed splash from the inline head before blocking resources, keep its chair
    stationary through standalone safe-area discovery, and preload content-hashed Inter and engine
    Wasm assets. The mobile header chair is bundled, the worker prewarms during hosted discovery,
    and startup reveals channel and recent-DM previews only after their latest history settles or
    the fixed 400ms cap expires. Filmstrip, local-Ergo first-reveal, and stalled-history coverage
    protect the complete path.
  - [x] Center the standalone splash against its own full-screen `100lvh` box so WebKit's transient
    status-bar-short layout viewport cannot move the chair before the document-height workaround
    settles; WebKit coverage also matches the complete chair rect to the generated launch image.
  - [x] Keep the startup font and chair assets Vite-managed in development and production, with
    content hashes in production and working dev-server URLs.
  - [x] Start mobile push-motion measurement after the startup splash has fully left, so the
    hydration gate cannot consume the recorder's pre-action frame window in CI.
  - [x] Compare sampled mobile transition curve bounds at device-pixel precision, so fractional
    compositor geometry cannot report a sub-pixel curve overshoot as a visible jump.
  - [x] Compare offline-hint conversation widths at device-pixel precision while still catching
    visible mobile column growth.
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
  - [x] Fill the dimmed logo and title with one real-colour connection band while a cached chat
    list hydrates, then finish the current cycle and one final filling pass when the complete live
    list replaces the cache. Reduced motion stays static; connected and hidden states do no work.
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
  - [x] Fix `#root` to the platform-owned app geometry: add back the iOS standalone status-bar
    shortfall of the layout viewport, and size to and offset by the visual viewport while the
    keyboard is open so iOS's pan cannot lift the composer or scroll the page (#53, awaiting device).
  - [x] Replace the status-bar shortfall with WebKit's own full-screen viewport (standalone `html`
    at least screen tall), undo iOS keyboard pans instead of following them, re-measure on the
    frames after viewport events, and add the `?debug=viewport` overlay (awaiting device).
  - [x] Keep late iOS keyboard geometry polling around pointer-activated text focus only, and stop
    as soon as the expected open or closed state is stable so programmatic focus returns to idle.
  - [x] Prevent iOS composer taps and keyboard-open drags from panning the document while leaving
    composer swipes and long-presses gesture-owned; never publish a stale visual-viewport top, and
    re-anchor the live-edge transcript with the app-height change before paint (#69 and #70,
    awaiting on-device motion confirmation).
  - [x] Keep the tapped composer outside WebKit's delayed reveal until measured keyboard geometry,
    cache open heights per orientation, and own open/close motion with platform-matched transform
    curves on the transcript/composer surface. `/debug keyboard` records a copyable frame trace;
    WebKit coverage proves monotonic motion through late geometry retargets by clearing canceled
    compositor transforms, a fixed root, and an adjacent live-edge transcript
    (#69 follow-up, awaiting on-device motion confirmation). The mobile shell clips instead of
    hiding overflow so WebKit's focus reveal cannot scroll it under the keyboard motion. Keyboard
    traces ignore focus leaving unrelated mobile chrome, so a late push transition cannot replace
    the tap capture.
  - [x] Keep the transcript's touch-action boundary vertical so WebKit cannot cancel an in-app
    edge swipe while preserving long-press message selection.
  - [x] Synchronize desktop buffer routes in Firefox and restore the addressed channel on reload.
  - [x] Keep joined-buffer snapshots from overriding committed desktop selection before command
    focus arrives.
  - [x] Keep unresolved buffer routes above provisional startup fallbacks while explicit engine
    focus and user navigation remain authoritative.
  - [x] Present connection state once per shell: the brand mark carries transient progress,
    actionable failures use one strip, and queued sends appear only as pending transcript rows;
    composers add no connection copy or width-changing state.
  - [x] Restore a versioned engine-owned chat-list snapshot from the web Cache store before live
    synchronization. Cached rows navigate, queue identity-safe sends, and defer explicit read
    intent; the first complete online list replaces them wholesale and preserves vanished routes
    as unavailable without retargeting queued work. Row activity preserves mobile timestamps and
    recent-DM order without a visible change at the cached-to-live swap. The Vite dev E2E harness
    uses its own port-correct debug endpoint, so the same startup swap runs in both build modes.
  - [x] Show the pointer cursor for clickable URL and channel tokens in messages.
  - [x] Keep composer suggestions mounted while Backspace shrinks a pending engine query.
  - [x] Apply engine-owned nick addressing to explicit Tab completion and preserve it while cycling.
  - [x] Animate mobile button, keyboard, and Android Back through the same pop transition while swipe completion remains gesture-owned.
  - [x] Keep the chats list still while a pushed chat slides over it on push, pop, and swipe-back;
    a released swipe continues from the finger to closed or back open with velocity-sized timing
    (#59, awaiting Luiz's on-device check). Motion coverage verifies the computed token
    configuration, monotonic intermediate movement, transition-end positions, and elapsed-time
    curve bounds without assuming a runner frame rate.
  - [x] Give tap-Back and released swipe-back one 280ms pop speed and curve. Swipe settlement scales
    by remaining distance, with release velocity allowed only to shorten it (#61, awaiting Luiz's
    on-device check).
  - [x] Close the narrow-desktop member panel through the shared drawer exit motion.
  - [x] Extend transcript mention, hover, and selected-row surfaces edge to edge without moving their content.
  - [x] Keep the full-bleed highlight browser assertion scoped to the active transcript and retry-safe across virtual-row replacement.
  - [x] Keep every incoming DM in the mention badge count without highlighting ordinary DM rows;
    transcript highlights now follow the engine's nick-word rule independently (#62, awaiting
    Luiz's on-device check).
  - [x] Toggle the remembered viewport diagnostics overlay from installed apps with the hidden
    `/debug viewport` and `/debug off` UI commands.
  - [x] Render exact channel sigils and bare DM nicks in one aligned desktop sidebar name column,
    without separate `#` or `@` icons (#63).
  - [x] Scale mobile chat avatar glyphs with list density and colour DM initials with the engine's
    stable nick palette index (#64).
  - [x] Preserve valid hosted buffer deep links through OAuth callbacks and plain reloads on desktop
    and mobile (#65).
  - [x] Keep newly opened conversations at the live edge through delayed history, stale offset
    delivery, and row remeasurement; preserve touch-pan intent through native pointer cancellation;
    and request mobile history only once per buffer (#66).
  - [x] Drive transcript scroll-away journeys with user-owned wheel input so live-edge coverage
    follows the same intent boundary as the app.
  - [x] Keep iOS swipe-back claimed through diagonal finger drift with the shared non-passive
    touch policy; use a 0.25px/ms release threshold and a claim-relative origin, allow full-screen
    starts and mid-return retries, and expose gesture decisions through `/debug gestures` (#71,
    awaiting Luiz's on-device confirmation).
  - [x] Align desktop channel sigils and member mode prefixes in content-sized columns, with bare
    names sharing one left edge and normal in-word, theme-independent spacing (#68).
  - [x] Keep resilience scroll-preservation journeys between both transcript edges with one
    user-owned wheel input, and assert the visual row anchor across reconnects.
  - [x] Open direct messages from transcript authors and known nick mentions without making the
    own nick or server-buffer text interactive. Desktop mouse and keyboard activation restores
    composer focus; mobile taps preserve the closed keyboard and nickname-originated swipes keep
    Back gesture ownership.
  - [x] Keep claimed mobile Back and member-drawer pans moving through WebKit's bubbling implicit
    capture-loss event without transferring pointer capture away from the touched child (#73).
  - [x] Let a past-halfway mobile pan commit through iOS's tiny lift-off rollback while a deliberate
    backward flick still cancels (#73).
  - [x] Start full-width mobile Back swipes on ordinary selectable message text while yielding to
    an active text selection, fields, and horizontal child scrollers (#73).
  - [x] Preserve the lost-pointer-capture target's tag and data-attribute name in `/debug gestures`
    without exposing attribute values or message content (#73).
  - [x] Keep long debug-overlay readings inside the mobile viewport by wrapping them within the
    available inline width (#73).
  - [x] Preserve failed Playwright traces and print bounded action timelines and error contexts
    from both Nix e2e checks before their sandboxes disappear.
  - [x] Name every bounded IRC bot wait and phase the long mobile-shell journey so a timeout
    identifies both the external event and the active user flow.
    user-owned wheel input, and preserve the visual row anchor across reconnects and late
    font-driven virtualizer remeasurement. Leaving the live edge freezes the unread line where the
    reader sees it, so the virtualizer never writes scroll over the reader's wheel scroll.
  - [x] Keep composer typeahead taps focused and motionless while the software keyboard stays open;
    defer the closed layout until focus remains outside keyboard fields for a frame, and cancel a
    false close when a keyboard field refocuses (#75, awaiting Luiz's on-device confirmation).
  - [x] Remove app-owned keyboard animation after on-device frame analysis found whole-app slides,
    desktop-grid clone overlays, clipping, and late composer motion. Open now applies cached or
    first-measured geometry in one step; close applies the final layout one frame after focusout.
    The transcript anchors before paint, the document workaround follows only `data-keyboard`, and
    swipe-back still reveals the full chat list without a composer fill (#74 and #76, awaiting
    Luiz's on-device confirmation).
  - [x] Commit cached keyboard geometry only after a composer tap actually focuses, roll cancelled
    taps and drags back by the next frame, and reconcile warm opens to stable measured viewport
    geometry while refreshing the orientation cache. `/debug keyboard` identifies cached,
    measured, and rollback commits and traces composer touch start/end/cancel, tap classification,
    focusin, and post-focus active state (beta feedback on `40ee783`, awaiting on-device
    confirmation).
  - [x] Let native keyboard focus recover from a rejected composer tap: focused-field ownership
    survives the closed-layout rollback, and the first measured open viewport commits its exact
    height for that owner. Composer tap slop is axis-bounded so ordinary diagonal jitter remains a
    tap, and rejected interactions include their movement, duration, or touch-state reason in
    `/debug keyboard`. Warm-cycle coverage opens the keyboard, sends the debug command without
    losing focus, follows the iPhone accessory Done blur through close, and taps open again without
    retaining tracker, rollback, expected-state, or cached-height interference (beta feedback on
    `57531c6`, awaiting on-device confirmation).
  - [x] Preserve prototype-backed browser touch coordinates and identifiers when classifying
    composer taps, and report both identifiers for a changed touch. Keyboard rollback callbacks
    now cancel on focus or measured-open geometry and otherwise reconcile live field ownership
    with the visual viewport, so stale callbacks cannot close an open keyboard layout (beta
    feedback on `cc1a339`, awaiting on-device confirmation).
  - [x] Route global keyboard geometry only to the surface owning the focused field. The mobile
    member drawer follows measured keyboard inset while the scrimmed chat retains its root height,
    safe-area padding, composer position, transcript offset, and visible row; owner-scoped geometry
    events no longer re-anchor unrelated message lists (#78, awaiting on-device confirmation).
    Luiz's on-device confirmation). Pixel coverage samples a visible chat row directly because the
    closed composer no longer defines a lower-row region.
  - [x] Update papo to `0070f15`: typed IRC names now select display spelling or folded storage
    keys explicitly. DM storage uses the folded account when known and the folded nick otherwise,
    preserving one buffer, draft, read position, and closed-buffer record through account discovery;
    connection-local `DirectRef` values are used only as live send handles and refreshed after reconnect.
  - [x] Update papo to `e774925` and replace account-keyed DMs with one thread per folded nick plus
    an independently persisted account `PeerKey` pin. Incoming and outgoing identity checks now
    upgrade matching pins, block mismatches without sending, mark unverified rows, and offer Trust
    new identity or a read-only Not now state in both shells. Legacy account draft keys and schema-2
    chat-list rows migrate to nick threads without inventing pins; two nicks on one account remain
    separate, and verified rename continuity adds a note without merging their histories.
  - [x] Bake the Nix revision and UTC source timestamp into production builds, with `dev` in the
    development server. `/version`, every `/debug` overlay section, and `window.weblounge.version`
    expose the same line; `/version` also reports a waiting service-worker update.
- **Polish pass before beta:** screen by screen (desktop and mobile, light and dark) against the prototype source: spacing, button styles, typography, time formats, badges, icons, everything in `docs/polish-notes.md`, and the desktop focus policy from doc 15 with Playwright tests. Before/after screenshots for every fix. (The mobile focus rules and keyboard behaviour belong to 7d.)
  - [x] Apply the desktop focus policy after navigation, transient surfaces, sends, and member DMs; route printable chrome keys to the composer without taking navigation keys, dialog input, or text selection.
  - [x] Keep the initial splash visible through hosted OAuth exchange and engine connection; reveal only the ready shell or a human error, without an intermediate sign-in screen.
  - [x] Make startup and render failures retryable in place; standalone retries create a fresh worker and engine, while hosted retries restart authorization.
  - [x] Ellipsize long desktop message nicks within their fixed column while preserving a stable mode-symbol slot.
  - [x] Give distinct nickname-link browser fixtures distinct accounts so durable DM identity does not merge their conversations.
- **Milestone 4 at beta.weblounge.org:**
  - B1. [x] Hosted-mode build configuration and the concierge OAuth handover (design 03).
  - B1b. [x] Hosted sign-in hardening: explicit production config, redacted request secrets,
    immediate callback cleanup, and issuer-origin endpoint validation.
  - B1c. [x] Match beta's strict CSP in dev and built-app browser tests. Startup styles, brand
    images, fonts, workers, and Wasm are same-origin files; startup and console journeys reject
    policy violations in Chromium, Firefox, and WebKit.
  - B1d. [x] Exchange the member cookie for an attempt-scoped IRC token before hosted startup and
    every reconnect. Login-required and missing-endpoint responses fall back to PKCE; rate limits
    and network failures remain retryable without reusing a bearer token.
  - B1e. [x] Keep hosted token fetches callable in WebKit windows and workers. Signed-out members
    promptly enter PKCE, signed-in members reach `#lounge` on-origin, transient failures back off
    behind a visible retry state, and invalid responses or a bounded startup stall stay human.
    Production worker URLs and the offline precache contain JavaScript only, never TypeScript. The
    anonymous startup font preload precedes the stylesheet; mobile WebKit coverage verifies the
    loaded face without depending on its delayed preload diagnostic.
  - B1f. [x] Start hosted deployment and member-session discovery during window bootstrap, in
    parallel with engine prewarm. A `401 login_required` reaches PKCE without waiting for a stalled
    worker or Wasm; Chromium at 6x CPU and WebKit cover the two worker kinds, while later 401s
    remain immediate after rate-limit and network failures.
  - B1g. [x] Keep every member-session token request in a live page, including reconnect refreshes;
    workers only route token demand and retain a visible failed network when no page is available.
    Network and TLS failures expose Retry, then enter PKCE after three seconds. Chromium and WebKit
    abort a fresh session request at the network layer and verify the bounded redirect.
  - B1h. [x] Exercise the signed-out redirect against stalled real worker assets in both Vite
    development and production builds without relying on production-only hashed URLs.
  - B1i. [x] Surface invalid, missing, and unavailable deployment configuration with the exact bad
    field on the retryable startup error and in one operator console error. Hosted configuration,
    discovery, session-token acquisition, and engine startup now have bounded visible failures in
    development and production.
  - B2. [ ] NixOS deployment changes prepared in `~/weblounge` as a branch for Luiz to review: the static site at beta.weblounge.org and `https://beta.weblounge.org` in Ergo's `allowed-origins`. Never pushed or deployed by agents.
- **Milestone 2.5 (after dogfooding):** split view with per-pane member lists, and the core keyboard shortcuts.
- **Milestone 4b:** replace gamja at irc.weblounge.org once the beta has proven itself.

## External dependencies

- **papo:** papo 0.1 pinned at `e774925`. Persistable TLS-host-scoped peer identity pins,
  per-send `direct_pinned` verification, post-registration SASL account-state hardening, explicit
  display spelling and folded storage keys, split-send reconciliation, exact live
  and nested-history multiline concatenation, server name rules, lag diagnostics,
  channel-recreation warnings, hardened typed inputs, correlated history responses, exact live
  actor facts, tri-state account/bot evidence, and completed JOIN refusals are integrated.
