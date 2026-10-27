# weblounge client — build brief

A handoff for building **weblounge**: a modern IRCv3 client for the web, desktop, iOS and Android, built on top of **papo** (our Rust IRCv3 client library). weblounge is also the name of a small invite-only friends-and-family IRC network (weblounge.org), but the app is a general client: anyone can use it to connect to any IRCv3 server or bouncer (Ergo, soju, Libera.Chat, …).

**Interactive prototype (source of truth for layout, look and behaviour):**
https://claude.ai/artifact/PXzq4fDvG8MuFsTCpmDhA9

**Project facts**
- **Repo:** a new repository, e.g. `weblounge-client`.
- **License:** open source, MIT OR Apache-2.0 (dual), the Rust convention.
- **papo:** https://github.com/luizribeiro/papo. A Rust IRCv3 client library that runs natively and in wasm, and supports every IRCv3 feature on https://ircv3.net/software/libraries.

The canvas has four boards: desktop onboarding, mobile onboarding, the desktop/web app and the mobile app. Everything is clickable (open a board and press Play). It was built with throwaway technology to explore design; **do not port its code**. Port its *behaviour, tokens and structure*. The theme token values are copied into the appendix so you don't need to read the prototype source.

---

## 0. How to approach this

This is a big project and it must stay easy to maintain, extend and customise (themes, densities, new IRCv3 features, new platforms). Before writing code:

1. **Design first, in small pieces.** Write a short design doc (in `docs/design/`) for each subsystem listed in §7 before implementing it. Each doc should state the problem, the types, the boundaries, what's out of scope, and how it will be tested. Prefer several small documents over one big one. Get a design reviewed (ask Luiz) before building anything large on top of it.
2. **Make invalid states unrepresentable.** Push correctness into types and structure rather than runtime guards. Capability-gated features should be impossible to render when a capability is missing, not hidden behind scattered `if`s.
3. **One source of truth per concern.** State lives in the engine; the UI renders it. Themes are data. Settings are a typed schema. Commands and shortcuts are registries.
4. **Build vertically.** Get one thin slice working end-to-end (connect → see a channel → send a message) before widening.
5. **Use papo for all protocol work.** Read its API before designing the engine. The engine composes papo; it never re-implements IRC parsing, capability negotiation, SASL or any IRCv3 extension. If something seems missing from papo, raise it with Luiz instead of working around it in the client.
6. **Speed is a feature.** The app must feel instant on cheap hardware (§3.13). Treat performance as a design input for every subsystem, not a final polish pass.

---

## 1. Goals and non-goals

**Goals**
- One app, many shells: **web (also installable as a PWA)**, **desktop** (Tauri 2), **iOS and Android** (Tauri 2 mobile, shipped through the App Store and Play Store).
- **The web build replaces gamja at irc.weblounge.org.** There it runs in **hosted mode**: the weblounge network is preconfigured and the user is already signed in through concierge (the same way gamja is today, via its OAuth2 patch in `pkgs/gamja-oauth2.patch`), so it opens straight into the chat with **no onboarding**. Onboarding with username and password is for the desktop and mobile apps, and for adding other networks.
- Feels like a **native application**, not a web page (see §2). It runs on web technology, but nobody should be able to tell.
- Fast: instant startup from cache, smooth scrolling through long histories, no jank on cheap phones.
- **Push notifications are table stakes**, at least for weblounge (Ergo already has web push enabled).
- Full modern IRCv3 support, with the UI adapting to whatever each server supports.
- Deeply themeable and adjustable (themes, densities, layout toggles), all driven by data.

**Explicitly later (designs still to come):** WHOIS/user profiles, context menus, search UI, file uploads (IRCv3 FILEHOST is still on the roadmap), a separate thread pane, moderation UI, channel browser (`/list`). Leave clean extension points for these.

**Never:** DCC (impossible in a browser).

---

## 2. Native feel: hard requirements

Treat these as acceptance criteria for every screen.

- **Text selection only where it's content.** Message text, topics, server log lines, code blocks and link previews are selectable. Chrome isn't: the sidebar, channel rows, tab bar, headers, buttons, badges, member list rows, settings labels and the composer's buttons. Use `user-select: none` on chrome by default and opt content *in*, not the other way round. Selection inside a message must not spill into neighbouring UI.
- **Copy should copy something sensible.** Copying a range of messages should produce IRC-style text (`[22:01] <luiz> text`), not a pile of DOM fragments. Design this explicitly.
- **Right click and long-press.** Never show the browser's default context menu on app chrome. Context menus are a later design, but build the hook now: a single context-menu system that every surface registers into, falling back to the native menu only inside selectable text and inputs. On Tauri desktop, use native menus.
- **No web-isms:** no tap highlight, no text-cursor (I-beam) over chrome, no blue focus flashes on mouse click (keep `:focus-visible` rings for keyboard users), no image or link dragging from chrome, no page-level rubber-band scrolling or pull-to-refresh on the app shell, no accidental zoom on input focus (inputs ≥16px on mobile), no layout shift when fonts load.
- **Platform conventions.**
  - Desktop: keyboard-first (⌘K/Ctrl+K switcher, ⌘, for settings, Alt+↑/↓ between buffers, Esc closes overlays); window drag regions in Tauri; native-feeling scrollbars.
  - Mobile: stack navigation with an iOS-style push/pop transition; swipe-back gesture; safe-area insets via `env(safe-area-inset-*)` (the prototype hard-codes ~62pt top and 34pt bottom for an iPhone 16 Pro, but the real app must read the system values); bottom tab bar; 44pt minimum touch targets; haptics where the platform offers them.
- **Respect system settings:** light/dark (default theme follows the system), reduced motion (disable slides and fades), text size (Dynamic Type / browser zoom should scale gracefully), high contrast where feasible.
- **Accessibility as drawn:** real buttons, links and inputs; labelled icon buttons; landmarks (`nav`, `main`, `aside`); a live region for new messages that's polite and throttled; full keyboard operability.
- **Truncation is structural.** Every single-line slot (names, times, status lines, topics, labels) must ellipsize rather than wrap. A bug in the prototype (a status line wrapping in the monospace theme) proved this needs to be a reusable primitive (e.g. `<Line>`) instead of per-element CSS, so it can't be forgotten.

---

## 3. Architecture

### 3.1 Overview

```
┌──────────────────────────── UI (TypeScript + SolidJS) ────────────────────────────┐
│  Desktop shell (panes)   Mobile shell (stack + tabs)   Onboarding   Settings       │
│  shared components · theme tokens · density presets · commands · shortcuts         │
└───────────────▲───────────────────────────────────────────────┬───────────────────┘
                │ typed events / state patches                  │ typed commands
┌───────────────┴──────────── EngineClient adapter ──────────────▼───────────────────┐
│   Web/PWA: SharedWorker (fallback: dedicated Worker) via postMessage               │
│   Tauri desktop/mobile: Tauri commands + events (IPC)                              │
└───────────────▲───────────────────────────────────────────────┬───────────────────┘
┌───────────────┴──────────── weblounge-engine (Rust) ───────────▼───────────────────┐
│  networks · buffers · messages · members · read markers · activity index           │
│  capability model · history/backfill · persistence trait · push registration       │
│                                   papo (IRCv3)                                     │
│  transport:  WebSocket (wasm, web-sys)   |   TCP/TLS + WebSocket (native)          │
│  storage:    IndexedDB / OPFS (wasm)     |   SQLite (native)                       │
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1a Platform matrix (read this first)

| | Web / PWA | Desktop (Tauri) | iOS / Android (Tauri) |
|---|---|---|---|
| Where the engine runs | **wasm** in a SharedWorker (dedicated Worker fallback) | **native Rust** in the Tauri backend | **native Rust** in the Tauri backend |
| Where the UI runs | browser tab | system webview | WKWebView / Android WebView |
| UI ↔ engine | `postMessage` | Tauri IPC | Tauri IPC |
| Transports available | WebSocket (`wss://`) only | TCP+TLS and WebSocket | TCP+TLS and WebSocket |
| Storage | IndexedDB / OPFS | SQLite | SQLite (iOS: in an app group shared with the notification extension) |
| Push | Web Push via service worker (iOS: installed PWA only) | OS notifications while running; Web Push optional | APNs / FCM through the push relay (§3.6) |

**wasm is only for the web build.** Desktop and mobile run the same engine crate compiled natively; there is no reason to run wasm inside the native apps, since that would lose raw TCP. The UI code is identical everywhere and only the `EngineClient` adapter differs.

**Two transports everywhere in the code.** A network's connection is a typed endpoint, e.g. `Endpoint::Tcp { host, port, tls }` or `Endpoint::WebSocket { url }`. A network can list several endpoints in order of preference (weblounge: `ircs://irc.weblounge.org:6697` natively and `wss://irc.weblounge.org` on the web). Which endpoints a platform can use is a compile-time property of the platform build, so the web build can't even construct a TCP connection. Onboarding and network settings must reflect this: on the web, TLS/TCP is unavailable and explained, and if a server has no WebSocket endpoint the web build says so instead of failing to connect.

### 3.2 Engine: Rust, on top of papo
- A `weblounge-engine` crate owns **all** client state and IRC logic: connection lifecycle, capability negotiation results, the buffer list, message storage, membership, read markers, typing state, the Activity index and history backfill. The UI holds no IRC logic.
- It compiles to **wasm** (web/PWA) and **native** (Tauri). Platform specifics sit behind traits: `Transport`, `Storage`, `Clock`, `PushRegistrar`, `Notifier`.
- **Web:** the engine runs in a **SharedWorker**, so all tabs share one connection and one state, and protocol parsing never blocks the main thread. Fall back to a dedicated Worker where SharedWorker is missing (check mobile browsers).
- **Native (Tauri):** the engine runs in the Rust backend with real TCP/TLS, so the desktop and mobile apps can reach networks without WebSocket support (e.g. Libera.Chat). The browser build can only reach WebSocket servers; the UI must say so clearly (onboarding already does).

### 3.3 Engine ↔ UI protocol
- A versioned, **strongly typed** command/event protocol. Commands go in (`SendMessage`, `JoinChannel`, `MarkRead`, `SetSetting`, …); events and state patches come out (`BufferAdded`, `MessagesAppended`, `MemberUpdated`, `ReadMarkerMoved`, …).
- Generate the TypeScript types from Rust (e.g. `ts-rs`, `specta` or `tsify`) so the boundary can't drift.
- Batch and coalesce events (one patch per animation frame) so a netsplit or a history load doesn't cause thousands of renders.
- The same `EngineClient` interface wraps both transports (worker `postMessage` and Tauri IPC). The UI must not know which one it's using.

### 3.4 UI: TypeScript + SolidJS
- Chosen for fine-grained reactivity. Chat is a constant stream of tiny updates (messages, unread counts, typing, presence), and Solid updates only the DOM nodes that read a value, with no virtual DOM and no `useMemo`/`useCallback` wrangling.
- Pattern: engine events become actions, actions update a central `createStore`, and `reconcile` applies patches. Components read slices of the store.
- Gotcha: components run once, so **never destructure props** (read `props.name`).
- A DOM UI, not canvas, so text selection, IME, find-in-page, accessibility, autofill and native scrolling all work.
- Virtualise the message list (e.g. TanStack Virtual), with stable row heights per density where possible and measured heights for rich rows.
- Leptos is a possible later Rust port (same reactivity model); keep the UI layer thin enough that this stays possible but don't plan for it.

### 3.5 Shells and layout
- **Two shells over shared state and components.** Desktop/web uses a multi-pane layout; phone uses a stack plus tabs. Switch on **container width**, not user agent.
- **Web/PWA:** a service worker caches the app shell for instant startup and handles Web Push.
- **Desktop:** Tauri 2 wrapping the same build, with native papo transport and native menus.
- **Mobile:** Tauri 2 iOS/Android with the same UI and the mobile shell. App Store guideline 4.2 rejects thin website wrappers; native push, offline cache, share and notification actions should clear it.

### 3.6 Push notifications
- **Server side:** the IRCv3 `draft/webpush` extension. Ergo has supported it since 2.15 (experimental, off by default, enabled with `webpush.enabled`); weblounge already has it on in `services/ergo.nix`. soju also supports it.
- **Web/PWA:** the service worker uses the Push API and calls `showNotification`. On iOS, web push works only for a PWA installed to the home screen (iOS 16.4+).
- **Store apps:** a store app's webview doesn't get Web Push, so build a **small push relay**:
  1. The app registers a Web Push endpoint on the relay with the server (`WEBPUSH REGISTER`).
  2. The server encrypts each push and posts it to the relay.
  3. The relay forwards the ciphertext unchanged to APNs (iOS) or FCM (Android). **It never sees plaintext.**
  4. The device decrypts it with the keys it registered:
     - **iOS:** a Notification Service Extension, which must be Swift and runs as a separate process.
     - **Android:** an FCM data-message handler (Kotlin, or Rust via JNI).
- Candidate Tauri plugins: `tauri-plugin-mobile-push` and `tauri-plugin-notifications` (supports FCM/APNs). Both are young; expect to read and patch them.
- Prior art: the goguma Android client with soju.
- **Background:** iOS kills the WebSocket in the background, so push is the only way to wake the app. On resume, resync with `chathistory`.
- The notification extension should also **write each push into the shared local store** (an app group container on iOS), so the Activity tab is up to date when the app opens (see §3.8).

### 3.7 Persistence and history
- Behind a `Storage` trait: IndexedDB/OPFS on the web, SQLite natively.
- Cache recent history per buffer; page further back on demand with `CHATHISTORY BEFORE/AFTER` using `msgid` cursors.
- On reconnect: `CHATHISTORY TARGETS` lists which buffers changed since you were last connected; fetch from each buffer's read marker forward, capped (~500 per target), and lazy-load the rest when the buffer is opened.

### 3.8 Activity (mobile tab; desktop later)
IRCv3 has no inbox, so Activity is an **index computed on the device**. It probably belongs as a papo or engine module, not the UI.
- **Sources:**
  - push payloads written by the notification extension;
  - the live message stream;
  - the gap-fill window from §3.7.
- **Item kinds:**
  - **Mentions:** heuristic. Nick plus highlight words, word-boundary matching, and handle nick changes. **Use the same matching rule the server uses for push**, otherwise pushes and Activity disagree.
  - **Replies to you:** reliable. `+reply` points at a `msgid`, and `echo-message` tells you which messages are yours. Fetch a missing parent with `CHATHISTORY AROUND`.
  - **Reactions to your messages:** `TAGMSG` with `+draft/react` and `+draft/unreact`. Ergo stores these in history via its `tagmsg-storage` whitelist.
  - **Bot and service notices.**
- **Read state is derived from `draft/read-marker`.** An item is read if its time is before its buffer's marker, so it syncs across devices for free. "Mark all read" moves the markers. Per-item dismissal would need extra state; skip it at first.
- **Deletions:** when a message is deleted (`draft/message-redaction`), remove its Activity item.
- **weblounge quirk:** `history.persistent.direct-messages = "disabled"`. DMs live only in Ergo's in-memory history and are lost on restart, so DM-derived Activity items can disappear.

### 3.9 Capability-driven UI
- Model server capabilities as typed data per network. Features are available or not based on that model.
- If a network lacks a capability, the feature is absent from the UI: no reactions without message-tags, no reply UI without msgid, no read sync without read-marker, no push toggle without webpush, no backfill without chathistory. **Never show a broken control.**
- The onboarding "Connecting…" screen already shows the negotiated features ("This network supports …"). Keep that: it also helps with debugging.

---

### 3.10 Risks and trade-offs of this architecture

Known costs, so they're designed for rather than discovered:

- **Two runtimes for the engine** (wasm in a worker; native in Tauri). That means two transport backends, two storage backends and two adapters. Keep all of that behind the traits in §3.2 and run the same engine test suite against both builds.
- **iOS doesn't allow background connections.** iOS suspends the app soon after it leaves the screen. A chat app can't keep an IRC socket open in the background, and abusing background modes gets rejected in review. So on iOS:
  - **Push only works for servers with `draft/webpush`** (Ergo, soju). A network that doesn't support it (e.g. connecting straight to Libera.Chat) gets no notifications while the app is closed.
  - The recommended path for those networks is to connect through a bouncer that supports push (soju); the UI should say so in that network's settings.
  - Every resume must resync quickly with `chathistory`.
- **Raw TCP on iOS is fine.** Rust sockets with rustls work in the Tauri backend; Apple's App Transport Security only applies to its HTTP APIs, not raw sockets.
- **The push relay is infrastructure you run for every user**, including users of third-party servers, because their servers post encrypted pushes to it.
  - It never sees message content, but it does see metadata: which server is pushing, when, and to which device.
  - It needs rate limiting and abuse protection, an APNs key and an FCM project.
- **The iOS Notification Service Extension** is a separate Xcode target (Swift) with its own memory limits. It needs:
  - the Web Push decryption code (in Swift, or the engine's Rust compiled as a static library);
  - the shared app-group store.
  Tauri doesn't set this up for you, so expect custom Xcode project work.
- **Tauri mobile is young** and the push plugins are community-maintained. Budget time for patching them, and for webview quirks:
  - on iOS, keyboard handling, safe areas and scrolling momentum;
  - on Android, WebView performance on cheap phones.
- **Native feel takes deliberate work.** There's no native navigation controller, so swipe-back, transitions, overscroll and text selection are all ours to get right (§2), and small mistakes read as "web app".
- **The web build reaches fewer networks.** Many IRC networks don't offer WebSocket.
  - One option is a WebSocket↔TCP gateway (like KiwiIRC's webircgateway) run by weblounge. That gateway would see plaintext traffic, so it's a privacy decision for Luiz, not a default.
- **Browser storage can be evicted.**
  - Safari can clear script-written storage for sites that aren't installed and haven't been used in a while.
  - Treat browser storage as a cache, with the server's history as the source of truth.
  - Prompt web users to install the PWA.
- **SharedWorker support varies on mobile browsers.** The dedicated-Worker fallback must be a first-class path, not an afterthought.

### 3.11 Modularity: every layer must be replaceable

Do the simple thing first (one web UI everywhere), but keep the seams clean so big pieces could be swapped later without a rewrite:

- **The UI must be swappable.** In the long term Luiz might want fully native UIs (e.g. SwiftUI and Jetpack Compose). This is not planned, but it shouldn't need an engine rewrite. Concretely:
  - Keep the UI thin. Anything a second UI would also need lives in the engine (Rust): unread and mention counts, mention and highlight detection, the Activity index, IRC formatting parsed into a renderable AST, nick-colour assignment (a stable hash index; the colour itself comes from the theme), message grouping decisions, completion candidates, the command parser and validation of settings.
  - The engine API is a plain, typed command/event interface (§3.3) with no web types in it. Design it so it could later be exposed through UniFFI to Swift and Kotlin. Don't add UniFFI now.
  - Themes and density presets are platform-neutral data (JSON or TOML) that the web UI turns into CSS variables, and that a native UI could read just as well.
- **Every platform service sits behind an interface:** transport, storage, push registration, notifications, clipboard, haptics, menus. Each platform supplies its own implementations.
- **The push relay is its own service** with a small, documented API. It could be swapped, self-hosted by others, or turned into a premium feature (see below) without touching the app.
- **No reaching across layers.** UI code never parses IRC; engine code never knows about the DOM; shells contain only wiring. Enforce the boundaries with tooling (dependency rules in the TS build, crate dependencies in Rust), not just convention.

### 3.12a Hosted mode vs. app mode

The same web build runs in two modes, chosen by deploy-time configuration (not by sniffing the hostname in random places):
- **Hosted (irc.weblounge.org):**
  - one preconfigured network;
  - authentication handed over from concierge (OAuth or session token, the same mechanism gamja uses);
  - no onboarding;
  - "Add network" may stay available.
- **App (desktop, mobile, generic web):** onboarding, user-managed networks.

### 3.12 Push as a possible premium feature

Luiz will run the relay, and push on the store apps may become a paid feature. Plan for it without building payments yet:
- The relay gets an **entitlement check** hook: per-account or per-device tokens, issued by a small entitlements service. For now it allows everyone.
- **Web Push** on the web/PWA doesn't use the relay (the browser's push service does the delivery), so it stays free.
- **App Store rules:** on iOS, a paid digital feature must be sold through in-app purchase. Keep the app's purchase flow behind an interface so StoreKit and Play Billing can be added later.
- **Free tier:** decide whether push is free for weblounge.org members (open question).

### 3.13 Performance and UX quality (a top priority)

The app must feel snappy on cheap hardware. Web technology means this takes deliberate effort, and this is a solo project with **no device lab**, so quality has to come from automated, emulated benchmarks plus Luiz's own phone and laptop.

**Bad experiences to design out (these are product rules, not just perf goals):**
- **Never a blank screen.** On launch, render the last known state from the local cache immediately (buffer list, the last open conversation), then sync in the background. Skeletons appear only for content the app has never seen. Startup sync is incremental and never blocks interaction.
- **No waiting on the network to act.** Sending is optimistic: the message appears instantly as pending and is confirmed when it echoes back (`echo-message`), with a clear failed state and retry. Switching buffers shows cached messages instantly.
- **No layout jumps.** Reserve space for link previews and images. Keep the scroll position anchored when older history loads above. The unread line doesn't shift under the reader.
- **No jank.** Scrolling and transitions hold 60fps. Bursts (a netsplit, a big history page) are processed off the main thread and applied in batches.
- **No pointless spinners.** Nothing shows for operations under ~300ms. Longer ones show progress in place, never a blocking overlay.
- **Graceful offline.** A quiet "reconnecting" state; the app stays readable and the composer queues messages.

**Benchmark the key UX moments automatically.** Build a small performance harness early (it's subsystem 21):
- **Real servers, scripted traffic:** papo already has conformance tests against most IRC server implementations. Reuse that setup (servers run locally via Nix) instead of building a fake server. A small traffic driver (scripted bot clients, built on papo) produces repeatable load against them: bursts, netsplits, history, reactions, reconnects. Since everything runs locally, runs are stable enough to compare. Only add a fake server if a scenario truly can't be produced with a real one (e.g. malformed input or precise timing faults). Scenarios:
  - cold start and warm start;
  - switching buffers;
  - typing in the composer;
  - scrolling through 10k messages;
  - a 2,000-message burst (netsplit or history load);
  - reconnect and resume;
  - opening and closing a pushed screen (mobile);
  - opening ⌘K and settings;
  - idle, hidden and long-session soak runs (§3.13a).
- **Emulated slow hardware:** run the scenarios with Playwright + Chrome DevTools Protocol with CPU throttling (4× and 6×) and network throttling, in both a desktop viewport and a mobile viewport (iPhone 16 Pro size, touch emulation). Lighthouse CI covers the mobile load profile.
- **Instrument the app** with `performance.mark`/`measure` at the moments that matter, so the harness reads real numbers instead of guessing:
  - input event → first paint after it;
  - launch → cached content visible;
  - buffer switch → messages painted.
- **Browser metrics:**
  - the Event Timing API for input latency (INP);
  - the Long Animation Frames / Long Tasks APIs for main-thread blocking;
  - frame timing during scripted scrolls and transitions;
  - layout shift (CLS);
  - heap size after a long scripted session (a leak check).
- **Budgets in CI:** store a baseline in the repo, run each scenario several times, and fail the build when a key metric regresses beyond a threshold. Also track bundle size (JS, CSS, wasm) and fail on unexpected growth. Starting budgets, at 4× CPU throttling (refine in the design phase):
  - cached content visible within ~1s of launch;
  - buffer switch under ~100ms;
  - composer keystroke-to-paint within one frame;
  - p95 frame time under 16ms while scrolling;
  - no main-thread task over 50ms during a burst;
  - layout shift ≈ 0.
- **Native shells:** the same scenarios run in the Tauri webviews where automation allows. The iOS Simulator checks correctness, not speed; Luiz's phone is the real-device sanity check before releases.
- **Dev builds** get a toggleable performance overlay (frame time, long tasks, engine queue depth, last buffer-switch time), so problems are visible during normal use.

**Platform minimums:** propose these in the design phase. Start from iOS 16.4+ (needed for PWA push), Android 10+ with a current System WebView, and the last two versions of evergreen browsers.

**Practices:**
- All IRC work stays off the main thread (worker or native).
- Batch state patches once per frame; virtualise every long list.
- Use CSS `contain` and `content-visibility` where they help; avoid layout thrashing; animate only `transform` and `opacity`.
- Subset and preload fonts.
- Persist and restore the last-viewed state for instant resume.
- Code-split rarely used features (settings, onboarding).
- Keep the wasm lean (`wasm-opt`, no heavy dependencies), and justify each runtime dependency.

### 3.13a Battery and memory (an always-open app)

People keep a chat client open all day, on laptops and phones. Low battery and memory use matter as much as speed, and they come from design decisions, not tuning at the end.

**Idle means idle:**
- With no new messages, the app does essentially no work: no polling, no `setInterval` heartbeats, no `requestAnimationFrame` loops, no animations running off-screen.
- Keepalive relies on the server's PINGs (respond to them; don't add client-side pinging beyond what papo needs to detect dead connections).
- Anything decorative pauses when it isn't visible: spinners, the onboarding chat preview, typing indicators.
- Throttle outgoing `+typing` notifications as the spec suggests (about one every few seconds while typing, not per keystroke).

**Hidden or backgrounded:**
- **Hidden tab or minimised window:** use the Page Visibility API. The engine keeps the connection and keeps updating state and counts, but the UI does no rendering work until it's visible again, then applies one batched catch-up.
- **Desktop:** staying connected in the background is fine, but don't wake the UI for every message.
- **Mobile:** don't fight the OS. On iOS the app is suspended; on Android, don't keep a foreground service just to hold the socket. Disconnect cleanly, rely on push, and resync quickly on resume (§3.6, §3.7).

**Network:**
- Fetch history only as needed (§3.7).
- Fetch link previews lazily, only for messages on screen, and cache them. Fetching a preview also reveals your IP to the linked site, so it gets its own setting.
- Batch writes to storage, and never re-download what's already cached.

**Memory stays bounded however long the app runs:**
- **Messages:** the engine keeps a bounded in-memory window per buffer (recent messages plus whatever is on screen). Older messages are evicted to storage and paged back in when you scroll up.
- **DOM:** virtualised lists keep the number of DOM nodes constant regardless of history size.
- **Big channels:** member lists for channels with thousands of members are stored compactly in the engine and virtualised in the UI. Repeated strings like nicks are interned.
- **JS state:** the UI store holds only what's rendered or about to be; it never mirrors the engine's whole state.
- **wasm:** linear memory can grow but never shrink, so the engine must avoid allocation spikes (e.g. stream large history pages instead of loading them whole).
- **Images and previews** are released when they scroll far out of view.

**Avoid costly visual effects:**
- No animated `backdrop-filter` blur or large animated shadows.
- Transitions only animate `transform` and `opacity`, and stop when finished.

**Measure it, in the same harness as §3.13:**
- **Idle test:** with the app open and no traffic for 60s, the trace shows essentially no main-thread or worker activity beyond handling network events.
- **Hidden test:** while the tab is hidden and messages arrive, there's no rendering work (no style recalculation, layout or paint).
- **Soak test:** a simulated long session (e.g. 20 channels, tens of thousands of messages over a few simulated hours, driven against the real local servers). The JS heap, wasm memory and DOM node count must reach a plateau, not grow steadily.
- **Budgets:** propose memory budgets in the design phase (for the web tab and for the desktop app's total memory) and fail CI on regressions.
- **Manual spot checks before releases:** on the real devices Luiz has, macOS Activity Monitor's Energy tab on the desktop app, and Xcode's energy gauge on the iOS app.

### 3.13b Tooling: keep it simple and agent-friendly

Prefer tools with a CLI and numeric or JSON output that an agent can run and read, over trace files that need manual analysis:
- **Playwright + CDP `Performance.getMetrics`:** heap size, DOM node count, layout and style-recalculation counts, task duration. Diff these before and after a scenario; that covers the idle, hidden and soak checks without parsing traces. CPU and network throttling also go through CDP.
- **In-app `PerformanceObserver`** (`event`, `long-animation-frame`, `layout-shift`) collecting results into a small object the test reads at the end. This gives input latency, jank and layout shift as plain numbers.
- **memlab** (Meta's open-source tool, run from the CLI) for leak detection: write a scenario (open buffer → navigate away → back) and it reports objects that leaked.
- **size-limit** for JS and CSS bundle budgets; **twiggy** and `wasm-opt` for wasm size.
- **Rust:**
  - `divan` or `criterion` for engine hot-path benchmarks (applying a burst, paging history);
  - `dhat` for heap profiling, which can also assert peak memory in tests;
  - `tracing` with `tracing-chrome` to get Chrome-format traces from the native engine.
- **Lighthouse CI** with a JSON budget file for load performance on the web build.
- **Chrome DevTools MCP** for the agent's own investigations: it can drive Chrome, record a performance trace and get the main findings summarised. Use it for debugging, not as a CI gate.
- **Battery is measured by proxy** in CI: CPU time and the number of wake-ups during idle and hidden windows, from the metrics above.
- **Real energy readings on Luiz's Mac,** run by an agent from the terminal: `powermetrics` (needs sudo), or `top -stats pid,command,cpu,power`. On iOS, Instruments through `xcrun xctrace`, as an occasional manual check.

### 3.14 Seams for later: translations and telemetry

Neither is built now, but neither should be hard to add:
- **Translations (English only for now):** adding languages later is mostly mechanical, and LLMs make the translation itself easy. The expensive part is retrofitting code that builds sentences by concatenation, hard-codes plurals and dates, or has layouts that break with longer text. So from day one:
  - user-facing strings live in one place per feature (a tiny `t()` helper or message files);
  - never assemble sentences from fragments;
  - use `Intl` for dates, times, numbers and plurals;
  - let layouts handle ~30% longer text;
  - use CSS logical properties (`margin-inline-start`, etc.) so right-to-left languages are possible.
- **Telemetry (none for now):** don't structure the code around it, but keep the engine's typed events and a single diagnostics/logging sink as the obvious place to attach opt-in analytics or crash reporting later. No third-party SDKs.

## 4. IRCv3 coverage

Status labels as of early 2026; re-check the IRCv3 registry when building.

| Area | Specs | Notes |
|---|---|---|
| Base | `cap-notify`, `sasl` (PLAIN at minimum), `message-tags`, `server-time`, `echo-message`, `batch`, `labeled-response`, `standard-replies`, `multi-prefix`, `userhost-in-names`, `extended-join`, `account-notify`, `account-tag`, `away-notify`, `chghost`, `setname`, `invite-notify`, `monitor` / `extended-monitor` | Required for the basic experience. |
| Transport | IRCv3 WebSocket (`text.ircv3.net` / `binary.ircv3.net`) | Ratified Feb 2026. Ergo has native WebSocket listeners; weblounge puts `wss://` behind nginx. |
| History | `draft/chathistory`, `draft/event-playback` | Ergo and soju. |
| Read state | `draft/read-marker` | The "New" line, synced across devices. |
| Replies | `+reply` client tag | Ratified Feb 2026. **Threads are just inline replies; there's no thread object in the protocol.** Render a quote line above the reply. |
| Reactions | `+draft/react`, `+draft/unreact` | Aggregate into chips. |
| Typing | `+typing` | "ana is typing…". |
| Multiline | `draft/multiline` | Pasted code. |
| Deletion | `draft/message-redaction` | No edit spec exists yet. |
| Avatars | `draft/metadata-2` | Not every network provides avatars; there's an Avatars setting to turn them off. |
| Network icon | `draft/ICON` ISUPPORT token (work in progress) | **One image URL, with no light/dark variants.** See §5.7. |
| Presence | `away-notify`, `draft/pre-away`, `monitor` | DM presence dots. |
| Bots | Bot mode (ISUPPORT `BOT`, user mode `+B`, `bot` message tag) | BOT badge. |
| Accounts | `draft/account-registration` | Not used by weblounge (accounts come from concierge invites); other servers may use it. |
| Misc | `draft/channel-rename`, `draft/extended-isupport`, `+channel-context` | |
| Push | `draft/webpush` | §3.6. |
| Bouncers | `soju.im/bouncer-networks` (and possibly `soju.im/search`; verify) | Onboarding to a soju bouncer should import its networks. |

Classic IRC basics are also required: `/me` actions, NOTICEs, mIRC formatting (bold, colours, etc.) parsed into a safe AST before rendering, nick tab-completion, highlight words, ignore list, and a slash-command system.

---

## 5. Product spec (from the prototype)

### 5.1 Onboarding (desktop and mobile)
- **Desktop:** a full-window two-column layout.
  - **Left panel:** dark green, **fixed (never scrolls)**. It holds the logo and wordmark, the chair network illustration from weblounge.org (shrinks to fit), a one-line tagline, and an **animated chat preview**.
    - The preview is a dark card of four one-line messages that loops through a short scripted conversation, a new message fading up about every 1.9s, with a "… is typing" line naming whoever speaks next.
  - **Right side:** the steps; only this side scrolls.
  - **Narrow windows:** the left panel is hidden below ~760px.
- **Mobile:** each step has a dark green header.
  - **Welcome:** a tall header with logo, wordmark, tagline and the same animated preview.
  - **Other steps:** a compact header bar with logo and wordmark.
  - **Transitions:** steps push and pop with the same transition as the app.
- **Steps:**
  1. **Welcome:** "Pull up a chair." with two choices, **Join weblounge** (invite-only friends-and-family network, sign in with a weblounge account) and **Connect to another network** (any IRCv3 server or bouncer). Note: "You can add more networks later in Settings."
  2. **Join weblounge:** username and password, **Sign in**. A "No account yet?" note explains it's invite-only: ask a member for an invite link and open it to create an account.
  3. **Connect to another network:**
     - server and port (default 6697 for TLS, 443 for WebSocket);
     - connection type, TLS or WebSocket. In the **web build**, TLS is disabled with a short explanation (browsers can only reach `wss://`), and WebSocket takes a host or a full `wss://` URL, since some servers serve it on a path. In the **native apps** both are available;
     - nickname;
     - "Sign in with": SASL account (account and password), server password (bouncers), or none;
     - collapsible advanced options: real name, ident/username, channels to join;
     - **Connect**, plus a note that soju bouncers' networks are added automatically.
  4. **Connecting:**
     - a live checklist (reach host → TLS/WebSocket → negotiate features → sign in → sync, or "found a soju bouncer with N networks"), with done, in-progress and pending states;
     - a "This network supports" list of negotiated features;
     - when finished: "You're in." with a summary and a single **Open weblounge** button. There's deliberately **no** "add another network" here; that lives in Settings.
- Supports system light/dark (palettes in the appendix). The prototype's "Preview" switch is for the prototype only.
- **Decided:** the native apps sign in to weblounge with **username and password**, over SASL. The hosted web build at irc.weblounge.org skips onboarding entirely (§1).
- **Make the onboarding flow and "hosted mode" configuration data**, not separate code paths. A hosted build ships a preset (network, auth method, skip onboarding); the native apps ship the default flow.

### 5.2 Desktop / web app
- **Sidebar (256px)**
  - **Header:** the weblounge logo, the name and "N networks · connected", plus a `+` button (join a channel or start a DM).
  - **"Jump to… ⌘K"** button.
  - **One section per network**, each headed by the network's icon (or letter tile), its name and a status dot. Clicking the header opens that network's **server buffer**.
  - **Rows:** channels and DMs; DM rows show a presence dot. Unread counts are subtle; mentions get an accent badge; muted channels are dimmed; the active row is highlighted.
  - **"Add network"** at the end of the list opens onboarding.
  - **Footer:** your avatar (or a presence dot if avatars are off), nick, status, and a Settings button.
- **Main header:** sidebar toggle, title (`#channel` or nick), topic (truncated), search, ⌘K, member list toggle.
- **Chromeless mode:** with both side panels hidden, the conversation centres in an ~880px column.
- **Message list:** day dividers, the unread "New" line, collapsed join/part/quit lines, the typing indicator above the composer, and the composer (attach button, text field, send button).
- **Member list (232px):**
  - groups: Operators, Voiced, Online, Away (dimmed), Bots;
  - each row has a mode symbol (`@`, `+`), an optional avatar and the nick in that user's colour;
  - bots get a BOT badge.
- **⌘K switcher:** jump to channels and people, plus actions (open settings, network settings, toggle member list, …) and slash commands. Back it with the command registry (§7).
- **Server buffer:** a monospace log (time · source · text) with colours for numerics, MOTD, notices and errors. The composer becomes a command line ("/whois mel"), and the member list hides.
- **Settings:** a modal with a section sidebar (Appearance, Networks, Notifications); see §5.4.

### 5.3 Mobile app (reference device: iPhone 16 Pro, 402×874pt)
- **Tabs: Chats · Activity · Settings.** Activity is an inbox of things aimed at you; the Chats filters are about which conversations to show. (A "Mentions" tab clashed with a Mentions filter, so the filter was removed.)
- **Chats:**
  - header with the app logo and "weblounge", connection status and a `+` button;
  - search;
  - filters: All, Unread, Channels, Direct;
  - rows: icon or avatar, name, network label (for networks other than the default), time, preview, and an unread or mention badge.
  - **List density:** compact drops the previews.
- **Chat screen:** pushed with an iOS-style animation. The new screen slides in from the right (280ms, `cubic-bezier(0.2,0.8,0.2,1)`) while the list behind it shifts left 28% and dims; Back slides it out to the right (230ms). Back returns you to whichever tab you came from.
  - **Header:** back, title and subtitle, members button.
  - **Members panel:** slides in from the right, about 300px (at most 82% of the width), over a dimmed backdrop. It has a filter box and the same member groups as desktop. Tapping a member opens your DM with them.
- **Activity:** mention, reply, reaction and notice items, each with an icon, nick (coloured), action, where, time, a two-line excerpt, an unread dot, and a BOT badge for bots. "Mark all read". Tapping an item opens the conversation.
- **Settings:** a root list (Appearance, Networks, Notifications, each showing its current value) → a pushed page for each.
  - **Networks** shows one card per network (icon, status, server and port, connection type, nickname, account, push support, a "Connect automatically" switch, Server messages and Disconnect/Connect buttons) and an "Add network" link to onboarding.
  - Server messages opens one level deeper; that's the only two-level push.
- **Safe areas:** content clears the Dynamic Island at the top and the home indicator at the bottom.

### 5.4 Settings
**Appearance**
- **Theme:** Lounge, Lounge Night, Modern, Terminal, Retro.
  - Shown as preview cards drawn *from each theme's own tokens*, not screenshots.
  - The default follows the system: Lounge in light mode, Lounge Night in dark mode.
  - Possible follow-up: a "Match system" option.
- **Message layout:** One-line (default) or Grouped.
- **Message density:** Compact / Cozy (default) / Comfortable.
- **Sidebar density** (desktop) and **List density** (mobile): Compact (desktop default) / Cozy (mobile default) / Comfortable. These are separate from message density on purpose.
- **Switches:** Avatars (on), Mode symbols (on), Joins/parts/quits (on).

**Networks**
- As described in §5.2 and §5.3.
- Connect/Disconnect state is reflected in the sidebar's status dot.

**Notifications**
- Push notifications (on).
- Notify me about: Everything / **Mentions & DMs** / Nothing. Muted channels never notify.
- Highlight words: chips; type and press Enter to add; × to remove.
- Mentions from bots (off).

All settings are typed. They're stored locally for now; whether they sync later (e.g. via metadata) is a design decision.

### 5.5 Message rendering details
- **One-line layout:** time · `@nick` (right-aligned nick column; the mode symbol is muted, the nick coloured) · text.
- **Grouped layout:** an avatar, plus a header with nick and time; consecutive messages from the same person collapse under one header.
- **Nick colours:**
  - Each theme has a nick palette (appendix), assigned by a stable hash.
  - **Mentions of a nick inside message text use that nick's colour.**
  - Your own nick uses the theme accent.
- **Mentions of you:** the whole message row gets a highlight background.
- `/me` actions are rendered in italics: `* tomo is grabbing coffee`.
- **Replies:** a reply icon and a one-line quote of the parent (with nicks coloured) above the reply.
- **Reactions:** chips with a count; your own reactions are highlighted.
- **Link previews:** a card with host and title. **Code:** a monospace block.
- **BOT badge:** a small outlined monospace "BOT" pill after the nick.
- **Mode symbols** (`@` ops, `+` voice) appear before nicks in messages and the member list, and can be switched off.

### 5.6 Motion
- **Push/pop:** 280ms in, 230ms out (curves above).
- **Members panel:** slides in over 220ms.
- **Onboarding:** desktop uses a short slide-and-fade; mobile uses push/pop.
- **Chat preview:** each new line fades up over 420ms.
- All motion turns off with reduced motion.

### 5.7 Theming
- **Themes are data:** a flat token set per theme (appendix). Adding a theme should mean adding one token file and nothing else; the settings picker and preview cards come from the registry.
- **Densities are data too:** presets for message density and sidebar/list density.
- **Tokens become CSS custom properties.** Components only use tokens (no raw colours), so a theme swap is a variable swap with no re-render storm.
- **Network icons are images and can't be themed.**
  - `draft/ICON` gives one URL, with no dark variant.
  - Render the image as-is. On dark themes, add a subtle 1px light inner ring so dark icons don't vanish.
  - Planned safeguards:
    - icons with transparent backgrounds get a light backing plate (check once, when the icon is downloaded);
    - icons that fail to load fall back to a letter tile.
  - Client-drawn letter tiles *are* themed.
  - The app's own logo (onboarding headers, sidebar header) is our asset and may follow light/dark.

---

## 6. Brand assets

- The weblounge.org repo (`~/weblounge`) has the source: `web/styles/tokens.css` (the palette, including dark mode), `web/images/favicon.svg` (the chair mark), `web/images/chair.svg` (the network-of-nodes chair illustration) and `web/images/wordmark.svg`.
- **Typography:** Inter (the website uses "Inter Display" and Inter) for the UI. Monospace: `ui-monospace, SFMono-Regular, Consolas, Liberation Mono`. Section labels are small uppercase monospace with 0.12em tracking.
- **Corners:** 3px for controls, 6px for cards.

**The weblounge server, from its repo** (useful defaults and test target):
- Ergo 2.19.1 with SQLite. A WebSocket listener sits behind nginx (TLS terminated there), with `allowed-origins` restricted.
- Account login (SASL) required; accounts are created through the concierge service's invites (registration disabled in Ergo).
- Always-on connections and auto-away are on unless a user opts out. Everyone auto-joins `#lounge`.
- Channel history is persisted; **DM history isn't** (`direct-messages = "disabled"`). Users can delete their own messages (`retention.allow-individual-delete`).
- `webpush.enabled = true` with `subscriber = https://<domain>`, and Ergo's HTTP API is enabled.
- gamja is already deployed as a web chat with an OAuth2 patch, so concierge OAuth exists.
- The repo has NixOS VM tests and a `test-ergo` helper (`lib/test-ergo.nix`) that the client's integration tests can reuse.

---

## 7. Subsystems that each need their own design doc

Design these individually, roughly in this order. Keep each one small and well bounded.

1. **Engine state model:** networks, buffers (channel, DM, server), messages (with msgid, tags, batches), membership, presence, capabilities. Identifiers and ordering. What's in memory and what's in storage.
2. **Engine ↔ UI protocol:** commands, events, patches, versioning, batching, error model, type generation.
3. **Transport and connection lifecycle:** typed endpoints (§3.1a); WebSocket in wasm, TCP+TLS and WebSocket natively; choosing an endpoint per platform; reconnect/backoff; iOS suspend/resume; CAP and SASL flow; multi-network; bouncer-networks import.
4. **Storage:** schema, IndexedDB/OPFS vs SQLite behind one trait, eviction, migrations.
5. **History and sync:** chathistory paging, gap fill on reconnect, read markers, unread counts.
6. **Activity index** (§3.8).
7. **Push pipeline:** web push, the relay, the iOS Notification Service Extension, Android FCM, key management, and the push → local store → Activity path.
8. **Theming and tokens:** token schema, CSS variable mapping, theme registry, preview cards, system light/dark, icon handling.
9. **Density and layout system:** presets, the two shells, width breakpoints, chromeless mode, safe areas.
10. **Navigation:** the desktop pane model and the mobile stack-plus-tabs model (with animation), deep links, back behaviour, overlays (switcher, settings, drawers).
11. **Message rendering pipeline:** IRC formatting parser → safe AST → components; mention and link detection; nick colouring; grouping; replies, reactions and previews; copy-as-text.
12. **Virtualised message list:** scroll anchoring at the bottom, jump to the unread line, loading older history, variable row heights.
13. **Composer:** nick and channel completion, slash commands, multiline, typing notifications, drafts per buffer, IME.
14. **Command and shortcut registry:** one registry feeding slash commands, the ⌘K switcher, keyboard shortcuts and, later, context menus.
15. **Selection and context-menu system** (§2): which surfaces are selectable, and the menu registration API (menus themselves come later).
16. **Settings schema:** typed settings, defaults, storage, future sync.
17. **Capability model** (§3.9).
18. **Onboarding flow:** a state machine shared by both shells; the connection checklist built from real handshake events; soju import.
19. **Packaging:** PWA manifest and service worker, Tauri desktop, Tauri iOS/Android, signing, store requirements.
20. **Deployment configuration and hosted mode** (§3.12a): presets, the concierge auth handover, replacing gamja in the weblounge NixOS config.
21. **Performance and end-to-end harness** (§3.13): real local servers via papo's conformance setup, the scripted traffic driver, emulated throttling, app instrumentation, budgets and CI gates, the dev performance overlay.

**Code standards (apply everywhere; neatness is a requirement, not a nice-to-have):**
- **TypeScript:**
  - `strict` mode, no `any`, no unchecked casts.
  - Discriminated unions for state; exhaustive `switch` with a `never` check.
- **One component per file**, named after the component (`MessageRow.tsx`), with its styles and tests beside it.
- **Feature-sliced folders.** For example `app/src/features/chat/`, `features/sidebar/`, `features/settings/`, `features/onboarding/`, `features/activity/`, plus `app/src/ui/` for shared primitives (`Button`, `Line`, `Switch`, `Segmented`, `Sheet`, `Icon`) and `app/src/shells/{desktop,mobile}`. Features never import from each other's internals, only from their public `index.ts`.
- **Styling:**
  - Every visual value comes from theme tokens; no raw colours or ad-hoc spacing in components.
  - Small, local styles (CSS modules or a typed styling layer; pick one in the design phase and use it everywhere).
- **Rust:**
  - One crate or module per subsystem, with a small public API documented in its own top-level docs.
  - `clippy` (pedantic where reasonable) and `rustfmt`; errors via `thiserror`; no `unwrap` outside tests.
- **Formatting and linting:** Biome for TS (the weblounge repo already uses it), rustfmt and clippy for Rust. Pre-commit hooks via Nix, as in the weblounge repo. CI fails on warnings.
- **Small files and small functions.** A file growing past a few hundred lines is a signal to split it.
- **Every subsystem** gets its own README or design doc, stating what it owns and what it must not do.

**Testing:**
- engine unit tests for pure logic (state, Activity index, formatting);
- integration and end-to-end tests against **real IRC servers**, reusing papo's multi-server conformance setup (Ergo, soju and the others papo covers) and the weblounge NixOS tests for weblounge-specific behaviour (concierge, push);
- UI component tests;
- Playwright end-to-end tests for both shells against those servers;
- visual checks for every theme × density. Use Nix for the dev shell and CI, as in Luiz's other projects.

**Suggested repo layout** (adjust in the design phase):
```
crates/engine         # weblounge-engine (Rust, wasm + native)
crates/engine-wasm    # wasm bindings + worker entry
crates/push-relay     # Web Push → APNs/FCM relay (standalone service, entitlement hook)
app/                  # TypeScript + SolidJS UI (shared components, shells, themes)
app/themes/           # one token file per theme
apps/tauri/           # desktop + mobile shells (incl. iOS NSE, Android FCM service)
docs/design/          # one design doc per subsystem
```

---

## 8. Suggested milestones

Desktop and mobile are built **together**: every milestone lands in both the desktop/web shell and the mobile shell (as a PWA at first). The native Tauri shells come later, and nothing done earlier may make them harder (keep the platform interfaces from §3.11 honest by giving each one at least a stub native implementation early).

1. **Design docs** for subsystems 1–3, 8–10, 17 and 21 (the performance harness comes early so every later milestone is measured). Then the first vertical slice.
2. **Vertical slice, both shells:** connect to weblounge over WebSocket, list buffers, read, send. One-line layout, Lounge and Lounge Night themes, system light/dark.
3. **History and state:** chathistory paging, read markers, unread and mention counts, persistence, multiple networks, server buffers.
4. **Hosted mode** at irc.weblounge.org, replacing gamja (concierge auth handover, no onboarding).
5. **The rest of the product:** all of Settings (§5.4), all five themes, densities, chromeless mode, ⌘K on desktop; tabs, stack navigation, members panel and Activity on mobile; Web Push.
6. **Onboarding** on both shells: the real connection checklist, username/password sign-in for weblounge, custom servers, soju import.
7. **Tauri desktop:** native TCP/TLS, native menus.
8. **Tauri mobile:** iOS first (Luiz has an Apple developer account), then Android. The push relay, the iOS notification extension and the Android handler, then store submission.

---

## 9. Open questions for Luiz

- Should weblounge run a WebSocket↔TCP gateway so the web build can reach networks without WebSocket? It would see plaintext.
- Push as a premium feature: free for weblounge.org members? Sold through in-app purchase, or as a subscription?
- Should settings sync across devices (e.g. through metadata), or stay per device?
- Should desktop get an Activity view too (as a sidebar entry or a pane)?
- Thread pane later, or inline replies only for good?
- To design later: WHOIS/profiles, context menus, search, file uploads, moderation, channel browser.

---

## Appendix A: theme tokens (from the prototype)

All themes share these token names. `base` is the base font size in px (mobile uses base + 1). `nicks` is the nick colour palette. Fonts: Lounge themes use Inter plus the system monospace stack; Modern uses Geist/Geist Mono; Terminal uses IBM Plex Mono throughout; Retro uses Work Sans (UI), Fraunces (titles and section labels) and Courier Prime (mono).

| token | Lounge | Lounge Night | Modern | Terminal | Retro |
|---|---|---|---|---|---|
| bg | #f3f1e9 | #18221e | #ffffff | #101112 | #f6efe1 |
| surface | #f3f1e9 | #18221e | #ffffff | #121314 | #f6efe1 |
| panel (sidebar) | #eaede3 | #131b18 | #f4f4f6 | #0b0c0d | #2e2119 |
| panelFg | #1d2825 | #edefe5 | #1c1c1e | #c9c5ba | #f1e6d0 |
| panelMuted | #5c655d | #a9b3a8 | #64646c | #8a867d | #b8a58a |
| panelBorder | #d5d8ce | #2a352e | #e4e4e9 | #1d1f21 | #4a3527 |
| panelAlt (members, settings nav) | #faf9f4 | #1b2621 | #fafafb | #0f1011 | #efe5d2 |
| fg | #1d2825 | #edefe5 | #1c1c1e | #d9d5ca | #2b1f17 |
| muted | #5c655d | #a9b3a8 | #64646c | #8a867d | #6e5a45 |
| border | #d5d8ce | #39463b | #e4e4e9 | #26282a | #d9c8aa |
| accent | #4e6244 | #bdd9a7 | #2f5bea | #e6b450 | #b5471d |
| accentFg | #f3f1e9 | #18221e | #ffffff | #121314 | #fff8ee |
| sel / selFg | #bdd9a7 / #1d2825 | #2c3a2f / #edefe5 | #e3e9fd / #1a3bb0 | #22252a / #f4efe2 | #4a3527 / #fff3dc |
| mentionBg | #e3ebd6 | #25321f | #fff5dc | #262113 | #f1dcb9 |
| unread (New line) | #9a3b2e | #eba293 | #c2410c | #e6b450 | #b5471d |
| inputBg | #faf9f4 | #202c24 | #ffffff | #0e0f10 | #fffaf0 |
| chip | #e3e6dc | #253227 | #f0f0f3 | #1a1c1e | #efe3cc |
| codeBg | #eaede3 | #131b18 | #f6f6f8 | #0b0c0d | #efe3cc |
| online | #4e6244 | #bdd9a7 | #2f9e44 | #7cc47a | #9bc26b |
| selfNick | #4e6244 | #bdd9a7 | #2f5bea | #e6b450 | #b5471d |
| error | #9a3b2e | #eba293 | #c0264b | #f28779 | #9a2b45 |
| radius / avatar / composer / palette / pill | 3 / 6 / 6 / 6 / 3px | 3 / 6 / 6 / 6 / 3px | 8 / 50% / 12 / 14 / 12px | 2 / 2 / 2 / 2 / 2px | 4 / 4 / 4 / 4 / 4px |
| shadow (overlays) | 0 20px 60px rgba(29,40,37,.18) | 0 20px 60px rgba(0,0,0,.45) | 0 24px 64px rgba(20,20,40,.18) | none | 6px 6px 0 #2e2119 |
| iconRing | none | inset 0 0 0 1px rgba(237,239,229,.16) | none | inset 0 0 0 1px rgba(255,255,255,.14) | inset 0 0 0 1px rgba(255,255,255,.12) |
| section labels | mono, uppercase, 0.12em | mono, uppercase, 0.12em | sans, uppercase, 0.06em | mono, none | Fraunces 15px |
| base | 14 | 14 | 14 | 13 | 14 |

Nick palettes:
- **Lounge:** #2f6b5e #8a5a12 #3f5f8a #9a3b2e #6a4f86 #7a4a62
- **Lounge Night:** #8fd3c1 #e8c07a #9cb8e8 #eba293 #c6aee8 #d9d48a
- **Modern:** #0b7a75 #b5520a #a3367c #c0264b #7048c8 #4d7c0f
- **Terminal:** #7fd1b9 #e08fbf #9ab8f2 #f28779 #c3a6ff #b8cc52
- **Retro:** #2f6b5e #7a5d0f #3c5a9a #9a2b45 #6d4a8c #5d6b16

Onboarding palette (also the website's):
- **Light:** paper #f3f1e9, ink #1d2825, muted #5c655d, line #d5d8ce, panel #faf9f4, soft #eaede3, accent #4e6244, signal #bdd9a7, header #1d2825.
- **Dark:** paper #18221e, ink #edefe5, muted #a9b3a8, line #39463b, panel #202c24, accent #bdd9a7, header #0f1613.
- Primary buttons are ink-on-paper inverted, like the website's `.button-primary`.

## Appendix B: density presets

| | Compact | Cozy | Comfortable |
|---|---|---|---|
| Message avatar | 26px | 36px | 40px |
| Group top padding / continuation | 5 / 0px | 10 / 2px | 15 / 4px |
| One-line row padding | 1px | 3px | 5px |
| Line height / font delta | 1.4 / −1px | 1.5 / 0 | 1.6 / +1px |
| Sidebar row height / font | 26px / 12.5px | 32px / 13px | 38px / 14px |
| Member row / avatar | 24 / 18px | 32 / 24px | 38 / 28px |
| Mobile list row / avatar / previews | 52 / 32px / no | 70 / 44px / yes | 80 / 48px / yes |
