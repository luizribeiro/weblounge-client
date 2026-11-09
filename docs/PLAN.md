# Plan and progress

The single place a fresh session reads to know where the project stands. Update it in the same commit that completes a task.

## Known limits

- WebKit bug 268797 can leave an iOS Home Screen app on the chat list after a notification tap; we
  deliberately do not guess which conversation to open.
- The dwell, divider, and snapshot flush now share one foreground signal. The push lease still uses
  its existing lifecycle wiring while the iOS push investigation is active; moving it onto the
  shared signal is deferred to the push migration step.
- The 16-buffer stock-fakelag launch stays within its 36-command ceiling (36 measured), but the two
  changed-buffer
  history replies still arrive about 1.5 seconds after their requests. They wait behind
  papo's post-JOIN burst of seven `NAMES`, seven `MODE`, and seven `WHO` commands. Removing that
  delay requires papo to drop redundant `NAMES` after `JOIN` and resolve channel peers with lazy
  `WHO`. Once that lands, restore this zero-fakelag-queue assertion to the launch test:

  ```ts
  expect(
    historyReplyLatencies(wire).filter(({ latency }) => latency >= 500),
  ).toEqual([]);
  ```
- A no-cache launch with seven channels and nine DMs sends 48 commands: `CAP` 3,
  `AUTHENTICATE` 2, `NICK` 1, `USER` 1, `ISUPPORT` 1, `JOIN` 7, `NAMES` 7,
  `CHATHISTORY` 17, and `MARKREAD` 9. Its 17 history commands exceed the default budget of 16 by
  one because cold discovery needs one TARGETS query plus one initial page for each of 16 buffers.
  The 30-day TARGETS discovery window can also omit older DMs on a first launch without a snapshot.

## Progress

- [x] Keep hosted sign-in cancellation inside the mounted app's engine ownership. A session that
  requires authorization now unmounts the app before redirecting, so cleanup removes foreground
  snapshot work and closes the client in that order; the abandoned startup also recognizes the
  cancellation instead of starting a second authorization path through the closed client. Engine
  requests made after close reject their promises instead of throwing synchronously, so a late
  pagehide or visibility flush follows the same handled failure contract. A full signed-out, PKCE
  callback, `#lounge` and page-teardown journey now covers WebKit and Chromium without a closed
  client error or a transient unexpected-failure screen.
- [x] Reset each pane's qualified read dwell when the retained foreground-exit epoch changes, so a
  coalesced hidden-to-visible transition cannot mark a delayed peer arrival read before its New
  divider freezes.
- [x] Make the mobile keyboard-motion harness wait for the browser state it samples. Transition
  collection now starts only after both composer and transcript animations mount, and the paused
  paint audit waits for stable virtual-row geometry before cloning the transcript snapshot.
- [x] Make the member-drawer handoff audit independent of WebKit's unsynchronized compositor
  geometry and JavaScript clock. Released returns and closes now compare the generated transition
  start keyframe with the transform held under the finger at device-pixel precision, while the real
  transition-end elapsed time proves the declared motion ran even when no intermediate frame is
  sampled.
- [x] Keep locked iPhones able to decrypt push routes. Web route records now contain exported
  PKCS#8 bytes instead of structured-cloned `CryptoKey`s, and the service worker imports a
  non-extractable key per delivery. On the first unlocked launch, a legacy key record is scrubbed
  to key-free metadata and the existing relay/home lifecycle rotates it once through probing,
  exact unregister, REGISTER and activation. Unit guards walk persisted values for `CryptoKey`s,
  while the full push VM seeds a legacy route and proves its one replacement decrypts the next DM;
  iOS lock-state itself remains device-only verification.
- [x] Preserve read-state transition evidence across delayed browser delivery. The shared
  foreground signal now retains an exit epoch so a hidden-to-visible batch cannot let a later peer
  message move the pane's frozen New divider, and each message list publishes its initial live edge
  on mount so a delayed WebKit intersection callback cannot leave the 500 ms dwell unarmed.
- [x] Make the ten-minute cross-tab push budget wait for its exact boundary lease renewal to reach
  the relay fixture. The fake clock can start the asynchronous renewal before Playwright observes
  its request, so the journey now waits on the unchanged 21-renewal, 25-request budget.
- [x] Keep an on-device, privacy-safe log of the newest 50 service-worker push deliveries for blank
  iPhone notification diagnosis. Each entry records only the worker/shell version, closed outcome,
  fallback and total timing, deferred-write state, code-defined stage timings, and a safe error
  name/reason; bounded log writes run after delivery and cannot affect presentation or receipt
  ordering. Protected-storage diagnosis distinguishes database open and transaction failures plus
  parser Cache API and Wasm loading. Failed database writes remain in the worker's memory for the
  next push or unlocked app event. `/debug push` reads and copies the persisted lines inside an
  installed Home Screen app, and built-app coverage proves a real delivered push appears without its
  text, nick, channel or msgid.
- [x] Land read-state migration step 9. One app foreground signal now treats a visible iOS
  standalone app as foreground and drives snapshot flushes plus every mounted pane's divider and
  500ms live-edge dwell. Pane dwells qualify independently, use only committed server times, and
  send read commands through the greatest held message without exposing viewport state to the
  engine. Each pane keeps one divider mark: watched arrivals stay behind it, leaving the reading
  state freezes it, and an own committed echo resets it. The old component-local foreground
  listeners and three-value divider boundary are gone; visible-pane badge suppression remains the
  sidebar's set-based policy.
- [x] Remove a deadline generic after a slow push is successfully classified as a silent
  `MARKREAD` or `PING`. The coordinator now waits for any in-flight fallback presentation, closes
  only that receipt's notification, and retains final generics for route, decryption and parse
  failures. Unit coverage pins both controls and the intended error fallback; a condition-gated
  Chromium push journey holds real preparation past 1.5 seconds and proves no notification remains.
- [x] Land read-state migration step 8. Snapshot rows now enter the same projected buffer list as
  live rows and retain stable buffer identities while `BufferUpdated` replaces their preview,
  sync, read and activity fields in place. Cached-list staging, promotion, optimistic count
  clearing, `UnreadChanged`, `ReadMarkerMoved` and `read_through` are gone. Direct markers settle
  before launch catch-up can expose unread facts, and every visible desktop conversation suppresses
  its count throughout live-edge delivery.
- [x] Recognize tagged IRC departures while the resilience harness claims the always-on nickname.
  Ergo attaches server-time, account and msgid tags to the holder's QUIT, so the harness now accepts
  the tagged source prefix and retries its NICK only after that observed departure.
- [x] Land read-state migration step 7. Snapshot persistence now queues only changed conversation
  rows and explicit PART removals, starts each write immediately, and merges every row inside its
  storage transaction. Concurrent tabs and late replaced-client writes can no longer lower marks or
  pending advances, discard unread stubs, or overwrite a newer preview; a failed or interrupted
  multi-row update leaves each row wholly old or wholly new, and cursor advances remain conservative.
  A built-app journey proves a remote read is durable before an immediate reload.
- [x] Land read-state migration step 5 on papo's bounded `LATEST` API. Catch-up keeps the newest
  100 messages after a cursor, treats only `page.end` as proof of completeness, persists the oldest
  returned edge for a bounded gap, and projects that gap as `99+` while retaining the newest preview.
  TARGETS reconciliation follows goguma by fetching markers for changed DMs and every DM with
  retained unread facts. The 16-buffer launch remains under 36 commands, preserves unqueued client
  requests, and makes a cached conversation interactive within a 500 ms ceiling while offline.
- [x] Make Chromium push injection wait for service-worker delivery. The shared E2E helper now
  keeps one controller-bound CDP session and waits for a test-build-only receipt emitted after the
  push event's `waitUntil` work settles, so constrained runs cannot inspect notifications before
  presentation or silent control handling completes. Direct-push history reconciliation is pinned
  to remain unread unless the user explicitly advances it. VM run IDs provide fresh machines for
  repeated stateful lifecycle checks.
- [x] Make always-on control nick claims survive the app disconnect race. A 433 now waits for the
  previous holder's observed departure before sending NICK once more, and a scripted harness test
  pins the failing 433, QUIT, confirmation ordering without a timed retry.
- [x] Keep the transcript DOM unchanged when a page becomes hidden. Freezing the New-divider
  boundary now changes only its non-reactive state, so queued engine traffic still appears in one
  visible catch-up. The aggregate native-feel regression and a deterministic message-list fixture
  cover the own-message boundary that exposed the write.
- [x] Scope the mobile-shell screenshot's member assertion to the open Members dialog. The modal
  intentionally retains the scrimmed conversation, so its transcript nick action can coexist with
  the member-row action without making the Playwright locator ambiguous.
- [x] Include the repository's shared read-state fixtures in the filtered Rust source so Nix
  clippy and cargo-test builds can compile the engine's golden tests from the same JSON file the
  TypeScript mirror will consume.
- [x] Define the accepted one-source read-state model in design 24 and land migration step 1 as an
  unwired pure Rust module. Per-conversation marks and gaps merge by maximum, peer stubs converge by
  msgid under a 100-entry cap, and count, mention, frozen-divider, in-app badge, OS badge and
  notification-close projections share one formula. Generated arrival-order properties cover
  push, history, live, server marks, reads and own messages; repository-level JSON fixtures pin the
  later service-worker TypeScript mirror. Existing unread wiring remains unchanged.
- [x] Bound optimistic sends across restored routes and socket replacement. TARGETS now leaves an
  unresolved snapshot DM pending so opening or sending starts its direct-recipient resolution;
  foreground reconnect cancels an in-flight papo request before replacing either local or hosted
  clients; production Ergo metadata confirms the stuck PRIVMSG never arrived before the iPhone
  foregrounded onto a new hosted connection, so that interrupted attempt becomes a visible failure
  with Retry instead of remaining Sending. The hosted token handoff cannot start until that failure
  settles. When the server accepted a message but
  its echo was lost, reconnect history reconciles the matching failed row by server msgid without
  replaying or duplicating it. Local-Ergo iPhone WebKit covers all three paths.
- [x] Land read-state migration steps 2–3. One persisted network cursor now bounds TARGETS, advances
  only after each delta commits, and resumes from the same boundary after relaunch. New conversation
  rows inherit that cursor as their persisted local mark, so pre-follow history stays read while
  later offline traffic is unread. The seed uses the cursor's preceding millisecond as an exclusive
  boundary, preventing a row-creating message at the cursor's millisecond from being swallowed;
  real read marks remain inclusive. This replaces the temporary JOIN-time floor and pushed-row
  provenance exception; production push, launch/catch-up, relaunch, and native-feel journeys cover
  the resulting New-divider and badge behavior.
- [x] Land read-state migration step 4. Schema 6 snapshots persist at most 100 unread message stubs
  and a gap edge per conversation, while the engine derives unread and mention projections from the
  shared read model independently of the 500-row rendering window. Schema 5 preserves its cursor,
  mark and latest position but discards saved badge counts once; changed conversations rebuild their
  facts from server history. This removes cached count bases, push decrements, marker recounts,
  lifecycle zeroing and stored snapshot badges.
- [x] Land read-state migration step 6. Per-conversation pending times replace deferred message ids
  and survive snapshot restore or papo client replacement; one advance path now owns user reads,
  own committed messages and push reconciliation. Reading a push-only row sends `MARKREAD`
  immediately, and an authoritative history copy one millisecond later carries the read forward and
  queues the repaired marker without reviving the badge.
- [x] Keep schema-6 read facts and closed-page notifications consistent after a remote read. A mark
  that covers a bounded unread gap now removes that dominated gap before snapshot persistence, and
  an unchanged cached direct with retained stubs still fetches its server marker during TARGETS
  reconciliation. Engine regressions and the built-app stale-snapshot and full push VM journeys
  cover both boundaries.
- [x] Stabilize push-relay launch and foreground traffic. Repeated connection requirements now
  reuse one route/dead-endpoint reconciliation, while a foreground Web Lock and shared heartbeat
  deadline keep one device lease across brief blur, visibility and tab handoffs; only real freeze
  or pagehide releases it. The cold-launch fixture falls from 13 device-API calls to 5, and its
  scripted ten-minute two-tab session falls from 127 to 25 (21 lease heartbeats, no churn
  releases). Relay preflights are cached for 600 seconds.
- [x] Keep a restored channel push unread across a later reconnect JOIN floor until a real read
  position covers it. Its authoritative history copy retains that push evidence, so the foreground
  dwell closes the existing notification instead of leaving a zero-unread row with no read marker.
- [x] Use an unmarked channel's own JOIN time as its local unread floor. A fresh account no longer
  turns pre-join history or old self-mentions into a launch badge, while an always-on account keeps
  post-join traffic unread and only current-nick matches add mention severity.
- [x] Keep an opened snapshot channel provisional until joined state proves its route live. Cached
  promotion no longer lets reconnect flush a queued send before TARGETS; a channel omitted by a
  successful reconciliation becomes the selected unavailable fallback and fails that send with the
  specific departed-conversation notice, while TARGETS fallback retains cached rows.
- [x] Isolate composer anchoring from other workers' membership traffic and settle open-triggered
  WebKit transcript rows before asserting exact geometry. Lazy history can reveal a new virtual
  window under load, so the paint test positions again after it measures and the composer test
  records only settled rows in its own channel.
- [x] Isolate the member-panel resubscription fixture from two-worker activity on the shared
  launch channel. Its exact member counts now belong to two per-test channels while retaining the
  channel-switch subscription assertions that caught the CI failure.
- [x] Replace a cached direct's provisional edge when authoritative live traffic arrives. Lazy
  TARGETS launch could retain a migrated future cursor and its cached mention base after the live
  message was read, so partial snapshot hydration rewrote the stale badge; live delivery now owns
  the current row, cursor and unread projection before local read persistence.
- [x] Make the opening unread-divider regression exercise the focused live edge, and cover switching
  to a buffer whose server marker arrives before its opening history page.
- [x] Let the launch regression hold one exact delta request while retaining the shared history
  gate's immutable payload and worker diagnostics, so killing the page mid-delta exercises the
  durable TARGETS boundary instead of relying on timing.
- [x] Keep held history-wire commands immutable across delayed release. The E2E gate now snapshots
  WASM-backed WebSocket views before engine memory reuse, while a test-only worker heartbeat, page
  errors, and page/worker release checkpoints make future constrained-run failures decisive.
- [x] Release a held history request through the worker that reported the hold, not whichever
  test worker subscribed most recently. The wire fixture now survives an unrelated worker opening
  and closing between hold and release, and verifies the acknowledgement's instance and port.
- [x] Keep the relay synchronization gate finite when an injected or platform wait resolves before
  its clock reaches the requested deadline. A waiter now sleeps once per observed deadline and
  sleeps again only when another transient failure extends that deadline; frozen-clock and
  concurrent-extension coverage retain backoff without an unbounded microtask loop.
- [x] Make a missing released-history trace identify its test worker and port lifecycle. E2E-only
  wire diagnostics now record worker-instance and port ids for registration, hold, release, and
  close events, and a failed BEFORE assertion prints those events with the tail of its wire trace.
- [x] Hold one unrelated latest-history request at the wire in cached-list hydration journeys,
  so the opened conversation and partial snapshot assertions prove their concurrency contract
  without depending on Ergo fakelag. The shared fixture releases the request only after the
  foreground assertions, while the existing older-page gate retains its behavior.
- [x] Request older Ready history from upward wheel intent even when the transcript is already at
  the top and the browser cannot emit another scroll event. The regression now drives Chromium's
  real wheel default action instead of splitting synthetic input and programmatic scrolling across
  browser round trips, while retaining the no-eager-page and no-title-shimmer checks.
- [x] Keep concurrent unknown push routes at 404 under SQLite write contention. Route lookup no
  longer takes an immediate write transaction merely to expire unrelated probes; only an expired
  matched probe enters the retirement transaction. Relay database work is bounded below the
  service task limit, busy/locked responses return retryable 503s, and every internal failure is
  logged once at warn with its safe Display text.
- [x] Bound cross-tab push synchronization without delaying the designed per-tab foreground
  leases. One Web Lock owner now reconciles the shared device and routes; unchanged targets and
  activations are idempotent; transient relay failures use capped jittered backoff and readable
  `Retry-After`, while permanent recovery and leases remain immediate. Page-lifecycle ownership
  handoff covers suspension and crashes without holding the lock across synchronization work. Two
  tabs, visibility flips and a no-CORS 429 stay within the device-API request budget measured below.
- [x] Reproduce the louro one-unread DM as a stale papo target after hosted reconnect. Firefox now
  keeps the SharedWorker conversation open while Luiz sends, the bot replies within three seconds,
  and the read dwell resolves that reply through the replacement client before a clear reload.
  Ergo's marker must advance from the own-send time to the exact reply time, with no
  `engine.mark_read_failed` diagnostic.
- [x] Cover a newly read DM across a failed snapshot commit independently of server read delivery.
  Firefox verifies the exact server marker, retries the cleared projection, and relaunches a fresh
  SharedWorker from the zero-unread snapshot.
- [x] Retain the latest chat-list snapshot across transient storage transaction failures.
  The writer now reports a failed cache commit and retries the coalesced authoritative projection,
  so a Firefox SharedWorker relaunch cannot restore stale unread badges after the live list cleared
  them.
- [x] Resolve every queued read target from the active papo client's name rules at flush time.
  Hosted foreground recovery can replace the client while retaining an offline read; the queue now
  keeps only stable buffer identity and time, so the fresh client produces the typed channel or nick
  used for `MARKREAD`. A hosted SharedWorker journey reproduces the lost cross-client marker against
  local Ergo and proves the server receives it without `engine.mark_read_failed`.
- [x] Restore a cached DM's writable snapshot row when live traffic follows TARGETS declaring the
  cached row vanished. The live message now establishes the current authoritative edge even for an
  existing buffer, so a local read can persist its cleared badge while other rows still hydrate.
- [x] Make the cross-device Apple MARKREAD fixture wait for the reading IRC session's push route
  before asserting relay drops. Ergo excludes that session's originating endpoint, so the stable
  production result is one dropped control for the other Apple route, not a race-dependent two.
- [x] Remeasure the live virtual transcript before an opening keyboard snapshot reveals it. WebKit
  can defer virtual-row placement after the one-step mobile layout commit; the frozen animation
  stayed correct while its replacement retained stale, overlapping transforms. The handoff now
  settles every rendered row and the live edge before the existing two-frame snapshot teardown. A
  component fixture withholds ResizeObserver delivery through teardown and proves the covered live
  rows are overlapping before the handoff remeasures them.
- [x] Replace launch and reconnect's eager per-buffer history sweep with one `CHATHISTORY TARGETS`
  diff against the persisted sync boundary. Unchanged cached rows remain authoritative without
  network work; changed rows fetch one capped page after their exact cursor, opened cached channels
  fetch Latest on demand, and direct identity and marker queries stay limited to opened or changed
  DMs with a nonzero cached badge. A stock-fakelag Ergo journey with seven channels and nine DMs
  cuts launch history commands from 17 to 4 with no `MONITOR` and at most seven `WHO`, while
  Chromium and iPhone WebKit verify selected-buffer priority, cached previews, badges, pushed
  channel markers, and cold launch.
- [x] Keep a locally read restored-push DM clear while its exact server marker remains deferred.
  Cached-frame hydration now clears the visible badge immediately, and the row-wise snapshot merge
  updates only that cached badge until authoritative history replaces the rest of the row.
- [x] Flush a complete pending chat-list snapshot when the page is hidden instead of leaving its
  first write behind the 750ms foreground throttle. An iPhone WebKit journey restores an unread DM
  among several channel histories, reads it, backgrounds immediately after hydration, and proves
  the next launch's cached frame is already clear.
- [x] Move the typing line into the composer (Luiz's dogfood request). The composer reserves the
  24px line above its field and draws no top border, so the transcript runs straight down to it and
  typing changes move neither. The transcript surface lost its typing grid row, and keyboard motion
  offsets the transcript by the committed open-composer height instead of fixed typing-row terms.
- [x] Keep opening an already-current conversation instant by separating latest-edge hydration from
  user-requested older paging. A ready buffer ignores the opening request, reaching the transcript
  top still sends `CHATHISTORY BEFORE`, and older loading stays out of the title shimmer state.
- [x] Make CI-loaded WebKit fixtures observe settled state instead of the first visible virtual
  row: concurrent keyboard traffic now ends with an ordered IRC barrier, transcript gestures and
  hit tests require three identical animation-frame geometry snapshots, and startup recovery closes
  its timed-out intercepted request before retrying. Stressed repetitions and all four affected
  WebKit mobile projects stay green.
- [x] Match CI regressions to the normal-flow typing row: WebKit transcript checks now require
  visible text rather than fractional clipped padding, keyboard motion distinguishes padding-box
  contact from content overlap, and slow-buffer hydration permits its concurrent marker query while
  still rejecting history, identity, or marker-write work queued ahead of the opened conversation.
- [x] Keep visible spaces around coloured nicknames in the fixed-height typing row by rendering
  its wording as one clipped inline sentence instead of separate anonymous flex items. Real-Ergo
  Chromium and iPhone WebKit coverage measures the painted gaps for one and two typers while
  retaining long-name truncation and the several-people fallback.
- [x] Put the permanent 24px typing row back in normal flow between the transcript scroller and
  composer. The scroller now ends at the row instead of extending under an overlay, so virtual
  geometry no longer owns a typing reserve or rounds fractional measurements to reach it; built-app
  iPhone WebKit coverage keeps long transcripts and keyboard motion pinned to their physical edges.
- [x] Preserve fractional WebKit row measurements while rounding the virtual transcript's scroll
  extent up to the next device-independent pixel. Integer `scrollTop` can now reach far enough for
  long-history, command, appended and New-divider rows to end at or above the permanent typing
  reserve; hit-test diagnostics identify the actual covering element if text clearance regresses.
- [x] Drive nickname-originated back-swipe continuations through the stable mobile shell after
  reacquiring a virtualized tap target. Row replacement can no longer strand synthetic move or
  release events on a detached node, while the compatibility click still has to be consumed.
- [x] Put the permanent typing reserve inside virtual transcript geometry so initial end-scroll,
  append follow, live-edge detection and anchoring all stop above the empty overlay. Desktop
  Chromium and iPhone WebKit now keep long-history `/version`, received, sent and New-divider
  unread rows visible and hit-testable without manual scrolling, while short transcripts and
  keyboard motion count the CSS-exported 24px reserve exactly once.
- [x] Derive chat-list activity, preview, ordering and snapshots from the newest committed message
  visible in the transcript. TARGETS and cached activity remain provisional only until history
  loads; local notices, reactions and typing cannot create phantom row times. Built-app local-Ergo
  coverage reproduces reaction-only TARGETS activity in desktop Chromium and iPhone WebKit.
- [x] Preserve an IRC server-time millisecond across the browser's `SystemTime` boundary instead of
  truncating sub-microsecond platform drift into the preceding millisecond. Papo-wire coverage marks
  a `.377` message at exactly `.377`; fresh-Ergo Chromium and iPhone WebKit coverage observes the
  marker from a second client before navigation, then proves the badge stays clear after live relaunch.
- [x] Retain a locally cleared push-row read after the user leaves its conversation or the
  connection drops. Once history verifies that exact msgid, send the authoritative server-time
  marker even while another conversation is selected; a local-Ergo WebKit journey holds history
  offline, verifies the marker from a second client, and relaunches with zero unread.
- [x] Reconcile a provisional pushed row with its authoritative history copy by `msgid` even when
  their server-time tags straddle a millisecond. The push parser and worker retain the pushed tag
  verbatim; history replaces that time on the same engine row, and only the authoritative time can
  produce the deferred MARKREAD.
- [x] Keep startup chat-list snapshots writable after a brand-new live direct arrives by treating
  its authoritative live cursor as a complete current row while retaining `BEFORE` paging for older
  history. A fresh-Ergo desktop Chromium and iPhone WebKit relaunch journey covers an empty channel,
  reply-tagged direct traffic, closed-app unread, server `MARKREAD` verification, and exact cached
  and final-live row convergence.
- [x] Keep the permanent typing reserve effective under the production CSP with one CSS Module
  value exported at build time to transcript geometry, so mount timing and missing computed styles
  cannot erase it. Preserve WebKit's fractional row measurements, and treat a swipe-completed
  detached nickname as already unable to receive its compatibility click.
- [x] Keep the permanent typing reserve effective under the production CSP by owning its 24px
  token in CSS and reading that token for transcript geometry after mount. Preserve WebKit's
  fractional row measurements so the newest line cannot cross the reserve, and reacquire visible
  transcript hit points after each mobile navigation before driving swipe gestures.
- [x] Mark the greatest committed chat server-time at the live edge instead of the last delivered
  UI row. A live message can overtake a reconnect `CHATHISTORY AFTER` page, leaving an older row
  appended last; choosing that row kept newer unread state and sent Ergo a non-advancing MARKREAD.
  Papo-wire coverage proves the ordering, while desktop Chromium and iPhone WebKit retain bot
  traffic clearing and reload persistence.
- [x] Preserve the engine's canonical timeline order when reconnect catch-up or unsolicited
  playback lands behind a newer live row. Interleaved `CHATHISTORY AFTER` now replaces the visible
  bounded window in engine order, while edge pages stay incremental; the built-app Chromium and
  iPhone WebKit regression asserts that the older row is visibly above the newer row.
- [x] Keep the cached chat list converged with late server read markers, and throttle whole-record
  rewrites without starving them under continuous traffic. Built-app desktop Chromium and iPhone
  WebKit coverage reads from another client, relaunches twice, and interleaves a newer live line
  with restart catch-up so cached badges and previews match the complete live projection.
- [x] Keep the 500ms read dwell attached to continuous foreground live-edge visibility instead of
  restarting it for every committed row. A local-Ergo regression interleaves four bots' messages,
  NOTICE, multiline and typing traffic at one-second per-bot intervals on desktop Chromium and
  iPhone WebKit, then reconnects after reload to prove the server marker retained the cleared badge.
- [x] Keep the unread `New` boundary out of a conversation being read at its live edge, including
  visible iOS standalone PWAs whose WebKit focus signal is false. Divider placement and both read
  dwells now share the push foreground authority; hiding proactively freezes the last visible row
  so deferred delivery still gains a boundary. Local-Ergo DM coverage retains `New` while hidden
  or scrolled up and rejects even a transient divider for focused arrivals in Chromium and WebKit.
- [x] Preserve real DM typing across engine and iOS shell boundaries: opening a direct now projects
  papo's retained pre-buffer typing snapshot, and transient toasts sit above the permanent typing
  slot. Built-app iPhone WebKit coverage uses an authenticated peer with account and server-time
  tags, a verified outgoing thread, mixed-case own nick, lowercase target, hidden-screen active
  refreshes at three seconds, and `done` immediately before the peer's reply.
- [x] Project engine-owned typing state through the mobile shell instead of dropping it between
  `MobileShell` and `MobileScreen`. Built-app local Ergo coverage now requires a peer's DM typing
  indicator to be visible, unclipped, uncovered, inside the iPhone WebKit viewport and above the
  composer before checking the transcript's permanent reserve.
- [x] Match the transcript's permanent bottom reserve to the 24px typing overlay, so its opaque
  background cannot clip the newest message when empty, active, or after a send. Built-app local
  Ergo coverage measures a desktop channel and standalone iPhone WebKit DM without moving geometry.
- [x] Keep the Chromium push fixture's CDP delivery session attached for each page lifetime, so a
  successful `deliverPushMessage` acknowledgement cannot be followed by detach discarding the
  queued event before the service worker receives it. The cold pushed-history journey stays green
  across 100 two-worker repetitions under the pressure that reproduced the loss.
- [x] Keep mobile back-swipe repaint coverage deterministic with activity-sorted Chats by opening
  the visible filled DM whose pixels it captures, instead of letting automation scroll the inactive
  channel into view behind the pushed screen.
- [x] Sort mobile Chats across channels and direct messages by newest activity for every filter and
  search, preserving engine order for ties and inactive rows. Cached and live projections share the
  same ordering path, desktop order stays unchanged, and a pressed row holds position until release.
  Local-Ergo coverage proves a DM rises first and a later channel message moves its channel above it.
- [x] Expose a privacy-safe, in-memory foreground and push-lease event log in `/debug`, including
  iOS standalone inputs, acted-on foreground transitions, typed lease results and copyable wall and
  monotonic timestamps. Unit coverage bounds the 200-entry ring and drives fake lifecycle events;
  local-Ergo Playwright observes blur, visibility and focus entries in newest-first order.
- [x] Keep the prototype-height typing indicator over the transcript's reserved bottom padding,
  so it stays outside composer geometry without adding 24px to mobile live-edge and keyboard-motion
  gaps. Composer-anchor fixtures no longer contribute `an`-matching speakers to the shared
  completion history; typing remains absent from completion ranking.
- [x] Persist authoritative chat-list rows without waiting for every background history. Each list
  update now atomically merges loaded rows into the in-memory snapshot while retaining cached rows
  that are still pending, syncing, or failed; local read clears wake the pending write immediately.
  A built-app Chromium and iPhone WebKit relaunch clears a cached DM while the rest of the list is
  still hydrating, and the engine regression preserves an unresolved channel's cached projection.
- [x] Collapse Web Push alerts to one notification per conversation even when the platform ignores
  native tags: present the latest DM or mention first, append the receipt-ordered unread ledger count,
  then close older identity-revalidated notifications within fixed scan bounds. Built-worker tag-less
  coverage delivers three Iris DMs and leaves the latest tappable notification with `3 new messages`;
  the unmocked Ergo, relay and browser-worker chain remains green.
- [x] Keep mobile transcript anchoring synchronous when resolving per-buffer send-failure notices,
  so composer resizing and cold or warm keyboard motion finish at the live edge.
- [x] Pin papo `1f87c93`, which retains shared MONITOR leases and emits `MonitorOnline` when an
  unshared peer returns. The engine refreshes its guarded handle on that event, queues sends while
  the handle resolves, and drops connection-local continuity pins when their IRC session ends.
  Built-app local-Ergo coverage confirms the reply while visible, hidden, and reconnecting without
  bypassing guarded identity; the direct-title shimmer settles in every case.
- [x] Keep an installed iOS PWA's foreground lease authoritative while its visible page reports a
  false focus signal, so a blur from the keyboard or system chrome cannot release a lease and
  present burst DMs already visible in the open conversation. The real Ergo/relay/worker journey
  holds all three DMs, presents none, and proves the interleaved reaction `TAGMSG` is not pushed.
- [x] Make notification taps durable across iOS suspension, discard, relaunch and rejected focus:
  atomically consume one short-lived route intent on startup and foreground lifecycle signals,
  retain it through cached/live buffer replacement, cancel WebKit's default click handling, and
  fall back from focus to navigation or a new window. Built-app Chromium and iPhone WebKit coverage
  opens the routed DM from open, discarded and closed states.
- [x] Keep failed-send notices with their owning conversation, reserve the direct-target-gone copy
  for direct sends, and let a failed initial history page end cached-list hydration without claiming
  the buffer is synced. Production-profile mobile coverage restores a closed-app DM from cache while
  its peer is actively typing, then proves the title settles and a reply confirms without the notice.
- [ ] Papo question for Luiz: `1f87c93` still returns `TargetGone` when a non-shared direct receives
  MONITOR `730` and an account-tagged `+typing=active` TAGMSG for the expected account, then has
  `WHO nick %na` finish with `315` but no matching `354`. Add the focused papo-testing scenario
  `direct_ref_accepts_event_identity_when_who_omits_row` and decide whether the proven event identity
  should survive the missing WHOX row. WebLounge must not work around it.
- [x] Scope failed-send notices to their owning conversation. A built-app local-Ergo regression
  queues a DM while offline, removes the peer, reconnects, observes the direct-target-gone failure,
  then proves that opening a channel does not carry the DM notice with it.
- [x] Stop an opened conversation title from waiting for whole-list cache hydration. With 20 cached
  buffers and 16 real local-Ergo DM histories, the target was `Ready` as soon as its labeled
  CHATHISTORY reply arrived while staged live-buffer updates left the visible snapshot row syncing.
  Cached staging now reconciles only the typed sync state through the durable draft key; badges,
  previews and the list swap remain staged. The title settles while background buffers still load.
- [x] Join portable Firefox notification-ledger closes to the control push lifetime, so a worker
  cannot terminate after applying MARKREAD state but before publishing the cleared notification list.
- [x] Prove released mobile swipes start from the finger through the CSS transition's generated
  keyframe, avoiding WebKit's unsynchronized accelerated-transform geometry and animation clocks.
- [x] Keep multi-push browser fixtures on one route key, and surface service-worker preparation
  errors in their assertion output so a fixture rekey cannot masquerade as a slow parser or store.
- [x] Bound upgrade-fixture push-route inspection so an IndexedDB stall reports its own failure,
  and close legacy migration connections on version changes and failed reads.
- [x] Make late push fallback replacement condition-based instead of wall-clock-polled, and keep
  failed-preparation generics distinct without making them replacement candidates.
- [x] Make late push fallback replacement atomic through a private native tag, so a dismissed or
  unobservable fallback cannot stall its push or later receipt-ordered commits; tidy an older
  private-tag replacement without letting an earlier push close the current or a newer push.
- [x] Keep Chromium's full-chain push injector attached for the serial lifecycle, so ending a CDP
  session cannot discard a queued service-worker delivery before its `waitUntil` work begins.
- [x] Replace a receipt-deadline push fallback when its detailed notification becomes presentable,
  without risking the already-visible fallback or double-counting its badge.
- [x] Gate the resilience fixture's account-settings nick takeover on authoritative MONITOR state,
  so buffered or replayed QUIT lines cannot release a still-connected app nick.
- [x] Keep independent push-reopen coverage scoped to its own route endpoint, regardless of Ergo's
  subscription ordering or retained endpoints from other scenarios.
- [x] Keep active push routes through app-open connection transients: unsupported snapshots are
  non-destructive, late own-account confirmation rechecks registration, and the full relay journey
  closes and reopens the app before proving the route and delivery remain live.
- [x] Make the relay own push route identity and converge deployed browser state: target-upserted
  devices, one home-keyed route, exact dead-endpoint cleanup, one engine ensure per connection,
  daily refresh, presentation-first bounded serialized worker delivery, read-marker-bounded
  MARKREAD/PING cleanup, and live subscription recovery.
- [x] Generate the engine's typed localization-key inventory with the protocol bindings, so the
  app strings cross-check no longer reads Rust source outside its Nix derivation.
- [x] Recover push registration after refusal and upgrade without accumulating subscriptions:
  select the current route before cleanup, unregister every exact stale Ergo endpoint before relay
  deletion, bind queued failures to the route that failed so a later successful replacement cannot
  be retired, converge duplicate active routes to one, and make every delivered worker push visible
  while duplicate `msgid`s retain one badge count.
- [x] Drive the unmocked push lifecycle through NixOS Ergo, the production-shaped relay, papo's
  HTTPS receiver, and Chromium's service worker across upgrade, reconnect, key rotation, multiple
  tabs and devices, MARKREAD filtering, missing keys, and registration refusal. Relay health now
  reports duplicate active routes, and the production build proves the test feature stays absent.
- [x] Keep production push handling live in the isolated classic service-worker bundle by sharing
  worker defines across both Vite passes and verifying its required listeners and import-free output.
- [x] Converge duplicate relay routes server-side when a replacement activates, so stale home
  subscriptions receive 404 without affecting another device or pinned home.
- [x] Harden the reviewed push redesign before deployment: bound failed service-worker update
  waits, forward urgency, scope and acknowledge bounded dead-endpoint cleanup, preserve local keys
  through relay failures, anchor fallback deadlines at receipt, and migrate deployed push state to
  a new database without blocking on old pages.
- [x] Close the full-CI push findings: keep a rejected notification attempt alive through its
  fallback retry, preserve cleanup metadata in cold-history coverage, and make relay lifecycle log
  coverage exercise a real legacy-route convergence while passing workspace rustfmt and clippy.
- [x] Keep successful push presentation distinct from slower persistence: disarm its receipt
  deadline once shown and retain every delivered badge increment.
- [x] Prevent an older read watermark from closing a newly presented same-tag notification.
- [x] Decouple concurrent push presentation from receipt-ordered persistence so slow storage cannot
  consume the next notification's deadline.
- [x] Keep every push failure path receipt-ordered, retry transient preparation and rejected
  presentation through the receipt deadline, bound all worker database operations, count generic
  fallbacks, and revalidate notification identity immediately before read-marker cleanup.
- [x] Make push CI fixtures model their intended ownership: take the engine offline before a cold
  pushed-DM restore, and assert the schema-3 worker state without granting engine markers cleanup
  authority.
- [x] Bound rejected push presentation with backoff, request fallback before the delivery budget,
  isolate commit failure from presentation, ignore marker-covered delayed pushes, and give page
  IndexedDB work a separate longer deadline.
- [x] Persist worker unread state by `msgid`, retaining explicit unknown engine baselines, so badge
  counts survive same-time messages, redelivery and delayed IndexedDB completion.

## Status

- **Milestone 1 (design):** done. Docs in `docs/design/`, signed off by Luiz on 2026-10-27. Engine edge cases from papo's maintainer: `docs/design/edge-cases.md`.
- **Milestone 2 (vertical slice, both shells):** in progress.

## Milestone 2 tasks

Each task is one fresh codex session, reviewed before the next starts. The orchestrating session pushes `main` to https://github.com/luizribeiro/weblounge-client after each reviewed task; codex sessions never push.

1. [x] Flake, Rust workspace (papo pinned by git rev), SolidJS app skeleton, and Cachix-backed
   GitHub Actions that cache shared Rust, wasm, app, and relay dependencies once, then build each
   uncached flake check in parallel behind one required status.
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
  - D3. [x] Clean resume after reconnect: engine-owned channel and DM gap fill and `Lagged` resync; one
    engine-owned lifecycle; quiet desktop/mobile indicators; visible-only worker liveness and
    transparent respawn; ordered in-memory composer sends across network reconnects. Desktop and
    iPhone 16 Pro WebKit cover background/server loss, browser offline, worker termination, Ergo
    restart, hosted-token expiry, and preservation of the established shell, draft, and message
    viewport. The in-memory send queue cannot survive worker termination.
  - [x] Keep foreground reconnect probes wasm-safe and retain each ready buffer's newest msgid and
    server time outside papo's client. Normal and fresh hosted reconnects page channel and DM gaps
    through `CHATHISTORY AFTER`; a silently stranded browser socket recovers both opened
    conversations without a reload (#93).
  - [x] Keep foreground worker liveness probes behind the initial handshake. A slow cold Wasm and
    IndexedDB start now remains governed by the startup deadline, while a real worker failure
    repeats `hello` on its replacement without rejecting the page's pending start (#95).
  - [x] Scope local Ergo always-on state to connection-resilience scenarios, preserving both
    reconnect catch-up and isolated multi-nick engine coverage.
  - [x] Start the production E2E socket forwarder from the shared workspace source root.
  - [x] Run both browser derivations in a nested test network with loopback services and a
    non-routable online interface when the sandbox permits it, preserving real browser
    online/offline events locally while falling back cleanly on restricted CI runners.
  - [x] Omit channel mode prefixes from every transcript row. IRC history cannot preserve the
    sender's status at message time, so the message protocol carries no mode symbol and live and
    optimistic rows do not guess one. The Mode symbols setting remains scoped to the member list;
    local Ergo proves an operator keeps `@` there through an unprefixed send confirmation.
  - [x] Keep `/me` semantic through optimistic display, correlated echo confirmation, shared-tab
    delivery, and history replay. Confirmed wire bodies use papo's CTCP parser instead of exposing
    the raw `ACTION` framing; local Ergo covers channel and direct actions before and after reload.
  - [x] Keep engine buffer order deterministic: server first, channels by casemapped name without
    `#`/`&`, and direct messages by latest activity with a casemapped nick tiebreaker. Desktop and
    mobile consume the same engine order; shuffled joins remain stable across three reloads.
  - [x] Wait for the reloaded engine connection before buffer-order coverage conditionally rejoins
    channels, so partial startup hydration cannot send JOIN while the network is still registering.
  - [x] Wait for the cached chat list's atomic live replacement before buffer-order coverage
    replays shuffled JOINs, so a vanishing cached row cannot consume the click at reload.
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
    casemapping.
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
  - [x] Measure mobile transition samples on the CSS transition's own timeline, so WebKit's
    backdated start under load cannot make a correct compositor step appear to overshoot its curve.
  - [x] Compare inline splash layouts at device-pixel precision so equivalent painted chair bounds
    cannot fail on browser layout-float noise.
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
  - [x] Keep live-edge publication out of native scroll handlers so Firefox async panning never
    observes app-owned transcript geometry writes. Logical scroll state remains immediate for
    arrivals while unread, row, spacer, sentinel, and clip updates coalesce into the next frame.
  - [x] Fill the dimmed logo and title with one real-colour connection band while a cached chat
    list hydrates, then finish the current cycle and one final filling pass when the complete live
    list replaces the cache. Reduced motion stays static; connected and hidden states do no work.
  - [x] Reuse that connection fill on the active desktop and mobile conversation title while its
    engine-owned buffer sync is pending. Initial history, reconnect catch-up, cached resolution,
    interruption, reduced motion, hidden pages, and the shared final pass follow one presentation
    controller without UI timers.
  - [x] Keep shared connection-fill geometry component-owned: brand titles retain the logo offset
    for one continuous band, while standalone conversation titles use width-relative endpoints.
  - [x] Render connection fills in Firefox with standard mask and background positioning instead
    of registered custom-property interpolation; strict Chromium, Firefox, and WebKit frame checks
    cover brand and conversation-title sweeps, final fill, visibility pausing, and reduced motion.
  - [x] Keep conversation-title progress to the shared moving shimmer band, then crossfade directly
    to the normal title when sync completes. Only the brand uses the sweep-then-fill mode (#99).
  - [x] Keep brand and conversation-title progress active while the browser is offline, then let
    the brand finish its fill and the title crossfade after reconnect.
  - [x] Sync read markers through papo on restore, live remote advances, and a 500ms foreground
    live-edge dwell. DMs count every peer message as a mention; unread-only rows keep the subtle
    dot while mentions use the accent count badge on both shells. Cross-context coverage targets
    the message list before invoking its End shortcut, independent of composer autofocus timing.
  - [x] Resolve an opened cached DM even when it has no fresh traffic: pre-registration history
    requests resume after connection, snapshot-only unread state yields to server history and the
    read marker, neither shell renders a transcript-covering mark-read control, and normal
    live-edge reads record locally while offline before syncing on reconnect (#90).
  - [x] Share axis-locked pan handling between mobile Back and the drag-to-close members drawer.
  - [x] Animate overlay drawers, scrims, and shadows as one progress-linked entrance and exit.
  - [x] Present an overlay drawer's fully off-screen closing endpoint before unmounting it, so
    WebKit cannot remove the panel on its penultimate composited frame.
  - [x] Start browser-Back drawer motion sampling only after `popstate` has put the drawer into its
    closing phase, excluding pre-navigation frames with the opening transition token.
  - [x] Open channel members with a protected mid-screen pan while keeping browser-edge and history gestures platform-owned.
  - [x] Apply the bottom safe inset only at the active bottom surface; root lists scroll beneath it and composer padding takes the larger of its normal spacing and the inset.
  - [x] Wait for safe-bottom changes to resize the transcript before asserting its live-edge
    correction, so stale pre-layout geometry cannot satisfy the keyboard-motion test.
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
  - [x] Keep late iOS keyboard geometry polling bounded around every keyboard-field focus and
    foreground resume, stopping as soon as the expected state settles. Pointerless, accessory-arrow,
    resumed, and pointer-activated focus retain the full one-second iOS bound independent of frame
    delivery; idle and hidden audits wait for the exposed watch state to settle before measuring.
    Focused measured-open reality still wins stale closed rollbacks and diagnostics identify the
    focus source and rollback cause.
  - [x] Defer closed rollbacks while a keyboard field remains focused, preserving the bounded watch
    for iOS's not-yet-reported shrink. Composer padding, borders, input, and Send-area pointers now
    arm that watch; touch tracking covers the painted composer and diagnostics label the landing.
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
    the tap capture. Opening and closing now layer the measured iOS Messages spring over the
    one-step geometry commit: the transcript follows opening but snaps closed, delayed closes
    reverse after two unchanged frames, and reduced motion or the platform kill switch stays
    immediate.
  - [x] Keep the transcript's touch-action boundary vertical so WebKit cannot cancel an in-app
    edge swipe while preserving long-press message selection.
  - [x] Synchronize desktop buffer routes in Firefox and restore the addressed channel on reload.
  - [x] Make the reload journey wait for the selected channel's coalesced chat-list snapshot before
    navigating, so Firefox SharedWorker teardown cannot race the state needed for restoration.
  - [x] Prove a cache-free reload against the production-shaped always-on Ergo restores the URL
    selection when the fresh engine receives the channel's live membership.
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
  - [x] Keep desktop sidebar rows keyed by stable buffer identity across the cached-to-live list
    replacement, so a press that spans the swap still opens its buffer (#103).
  - [x] Show the pointer cursor for clickable URL and channel tokens in messages.
  - [x] Keep composer suggestions mounted while Backspace shrinks a pending engine query.
  - [x] Apply engine-owned nick addressing to explicit Tab completion and preserve it while cycling.
  - [x] Animate mobile button, keyboard, and Android Back through the same pop transition while swipe completion remains gesture-owned.
  - [x] Keep the chats list still while a pushed chat slides over it on push, pop, and swipe-back;
    a released swipe continues from the finger to closed or back open with velocity-sized timing
    (#59, awaiting Luiz's on-device check). Motion coverage verifies the computed token
    configuration, monotonic movement, transition lifecycle and endpoints, and elapsed-time curve
    bounds without assuming a runner frame rate or compositor sample availability.
  - [x] Give tap-Back and released swipe-back one 280ms pop speed and curve. Swipe settlement scales
    by remaining distance, with release velocity allowed only to shorten it (#61, awaiting Luiz's
    on-device check).
  - [x] Close the narrow-desktop member panel through the shared drawer exit motion.
  - [x] Extend transcript mention, hover, and selected-row surfaces edge to edge without moving their content.
  - [x] Keep the desktop and mobile full-bleed highlight browser assertions scoped to the active
    transcript and retry-safe across virtual-row replacement.
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
  - [x] Measure reconnect scroll preservation from a fully visible message row, ignoring a row
    whose box barely intersects the transcript while its text remains clipped, then return to the
    live edge before asserting later traffic.
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
  - [x] Anchor transcript rows when the composer grows or shrinks. The live edge follows the
    composer boundary before the next frame while a scrolled-up row keeps its screen position;
    desktop and mobile cover one-to-three-line growth, deletion, and send clearing (#80).
  - [x] Keep live transcripts pinned through viewport height, width, and row-measurement changes
    while preserving the visible anchor after the reader scrolls away.
  - [x] Re-pin a root-owned live transcript synchronously on every app-geometry commit, after
    reconciling its viewport rectangle and before the keyboard transform animates the row layer.
  - [x] Size the transcript motion clip to the full virtual content height while retaining at
    least the viewport height for short channels. Desktop and mobile browser coverage hit-tests
    painted rows and checks screenshot variance at the live edge, midpoint, and top; composer and
    keyboard-motion final states carry the same paint invariant.
  - [x] Recheck the bounded keyboard watch and keyboard-motion transcript overlap at low host load.
    The full iPhone WebKit mobile-input suite passes 21/21, including twelve slow frames before a
    silent viewport step and every cold/warm motion frame; native-feel and composer-anchor coverage
    remains green, so neither prior high-load failure warrants an app or test change.
  - [x] Keep the experimental keyboard animation disabled by default while making its next device
    trial frame-complete: opening uses full-screen, hit-testable transcript and composer surfaces;
    opening and closing share commit-frame clocks without backdating; closing preserves the focused
    composer origin and one pinned transcript frame. A browser timeline removed the redundant
    post-`willCommit` layout-height read while retaining the synchronous live-edge pin; frame-by-frame
    WebKit coverage protects pixels, hit targets, clock lead, and close anchoring (awaiting a new
    on-device video before re-enabling).
  - [x] Keep the disabled keyboard-motion experiment disabled in the E2E harness too. Motion-specific
    journeys opt in explicitly; default WebKit coverage proves viewport commits never mount a
    keyboard snapshot that could intercept unrelated taps (#104).
  - [x] Update papo to `0070f15`: typed IRC names now select display spelling or folded storage
    keys explicitly. DM storage uses the folded account when known and the folded nick otherwise,
    preserving one buffer, draft, read position, and closed-buffer record through account discovery;
    connection-local `DirectRef` values are used only as live send handles and refreshed after reconnect.
  - [x] Update papo to `e774925` and replace account-keyed DMs with one thread per folded nick plus
    an independently persisted account `PeerKey` pin. Incoming and outgoing identity checks now
    upgrade matching pins, block mismatches without sending, mark unverified rows, and offer Trust
    new identity or a read-only Not now state in both shells. Legacy account draft keys and schema-2
    chat-list rows migrate to nick threads without inventing pins; two nicks on one account remain
    separate, and verified rename continuity adds a note without merging their histories. The
    identity decision stays a compact strip above the full-height scrollable transcript.
  - [x] Update papo to `3508be1` and map bounded-state request failures to product outcomes. Join
    limits use the shared human notice across explicit and automatic paths; read-marker limits log
    while preserving local read state; list-mode limits append a channel notice; metadata and
    bouncer limits stay diagnostic unless a person initiated the request.
  - [x] Bake the Nix revision and UTC source timestamp into production builds, with `dev` in the
    development server. `/version`, every `/debug` overlay section, and `window.weblounge.version`
    expose the same line; `/version` also reports a waiting service-worker update.
  - [x] Show the total unread count for every unread channel and DM in both shells. Unread-only
    badges use the accent pair; any mention, including every unread DM, switches the same count to
    the accessible red mention treatment. Versioned chat-list snapshots preserve both engine
    counters so cached launch rows do not regress to dots or mention-only counts.
  - [x] Keep outgoing and underlying mobile transition screens painted for motion but inert and
    hidden from the accessibility tree, leaving only the active screen's controls exposed.
  - [x] Keep the unread divider out of focused live-edge arrivals and every own message, including
    other-device actions. Own committed rows advance local and server read state; divider placement
    compares the projected marker timestamp with chronological message times, including a top
    divider when the known marker predates the loaded window and no divider when no marker is known.
  - [x] Remove the redundant "Following #channel" chip from desktop and mobile member lists while
    retaining the channel in each panel's accessible name (#86).
  - [x] Keep the 500ms read dwell tied to the visible buffer's unread count and newest committed
    message, so traffic elsewhere cannot starve desktop or mobile marker advancement. Mobile
    Chromium and WebKit return through both Back and swipe without restoring the unread badge (#88).
  - [x] Center mobile chat-list unread badges against the full row in preview and compact densities,
    including truncated names and one- through three-digit mention counts (#89).
  - [x] Make the mobile badge geometry journey guarantee title truncation with a maximum-length,
    wide-glyph nickname instead of depending on browser font metrics.
  - [x] Start from the last validated public deployment configuration and revalidate it in the
    background, while keeping session tokens one-shot and uncached. Hosted profiles restore the
    engine-owned chat-list snapshot before credential acquisition completes; cold reachability
    failures stay on the stationary inline splash with Retry plus online/visibility recovery, and
    only invalid configuration is reported as misconfigured (#87).
  - [x] Remove a channel buffer after a confirmed own PART from any session, preserving in-flight
    sends and navigating away in both shells. Keep own-KICK buffers read-only with their reason and
    an explicit Rejoin action; typed 403/442 refusals now name the affected channel (#85).
  - [x] Give local transcript notices typed topic or neutral-info semantics. Cached topics retain
    their setter and server time, while `/version`, verified DM renames, and list-full events render
    as plain muted rows without a topic label or synthetic setter (#92).
- **Push notifications (design 23):**
  - [x] Ship relay slice 1 as a flake package: concierge-authenticated Web Push devices,
    VAPID-pinned probing and active routes, opaque RFC 8291 forwarding, dead-target cleanup,
    body limits, push-service SSRF defenses, SQLite state and `/healthz`, covered through fake
    concierge and push-service integration tests.
  - [x] Close the relay deployment security review: disable proxy discovery, exercise the real
    pinned no-redirect TLS transport, constrain IPv4/IPv6 and transition addresses, bound upstream
    waits and stored registrations, enforce VAPID/TTL lifetimes, redact credentials, distinguish
    delivery failures, and cover authorization, malformed JWT, body-limit, deletion, DNS-rebinding
    and concierge-outage negatives. Edge endpoints, schema versioning, WAL, private state modes,
    pinned-client reuse and secret-free delivery tracing are included.
  - [x] Scope Tokio server features to the push relay so workspace feature inheritance cannot pull
    `mio` networking into the browser engine's `wasm32-unknown-unknown` build.
  - [x] Give the relay's browser-facing device and route APIs an exact, configurable CORS origin
    allowlist while keeping the server-to-server push ingress outside the CORS boundary.
  - [x] Try every validated push-service address within one delivery deadline, preferring IPv4 so
    the IPv4-only relay host can fall back from unusable AAAA answers.
  - [x] Wire page-owned relay routes through the engine to IRC Web Push: classify missing
    capability, account and VAPID prerequisites; expose typed registration outcomes; refresh on
    reconnect; replace routes after a VAPID change; and unregister on explicit removal or hosted
    sign-out. Exercise Ergo's real success, persistence-warning and refusal replies over the wire.
  - [x] Add the page-to-relay client slice: strictly validated optional deployment config; a
    granted-permission browser subscription pinned to the relay VAPID key; one cross-tab,
    engine-durable relay device; per-network non-extractable route keys in IndexedDB; probing route
    activation only after engine `Registered`; reconnect and VAPID-rotation synchronization; typed
    404 recreation and 401 reauthorization; and route cleanup on failure, unregister and hosted
    sign-out. Unit tests cover config, relay calls, subscription and state synchronization;
    Chromium covers the built and development page through a fake relay to the engine boundary.
    The real local-Ergo probe still waits for the design's TEST-NET/TLS test seam.
  - [x] Keep browser IndexedDB fixtures on the engine's generated database name, schema version,
    and store set. One shared Playwright helper upgrades the test database exactly like the engine,
    so future schema bumps cannot strand startup, routing, or cached-history journeys on an old
    hard-coded version.
  - [x] Deliver encrypted pushes in the classic service worker: RFC 8291 WebCrypto decryption,
    `papo-proto` parsing through a 46 KiB precached Wasm helper, one routed notification or generic
    fallback, Cache-space message handoff, and warm/cold notification routing. Full Chromium drives
    real encrypted CDP delivery; local Ergo proves an offline cold row appears before IRC and its
    later history copy reconciles the provisional row in place.
  - [x] Preserve sender accounts from decrypted push lines through Cache storage and engine restore.
    Restored DMs stay visibly normal but provisional until live or history delivers the same
    `msgid`; that authoritative copy replaces sender identity and verification metadata without a
    duplicate row, while real identity disagreements remain visible (#101).
  - [x] Clear local unread state when a restored push is read, but keep it out of MARKREAD until
    live delivery or history verifies that exact row's server msgid and time. Unrelated traffic
    stays unread and cannot consume or advance the deferred marker; permanent server refusals stop
    immediately, while transient failures retry five times with capped backoff. Distinct failures
    remain in `/debug` and the console without a user-facing toast (#105).
  - [x] Open the engine database from the push worker only at the generated current schema, abort
    instead of creating or upgrading it, and close each Cache write promptly and on version change.
    A push delivered on a fresh origin no longer blocks engine Settings or Durable storage (#95).
  - [x] Make the decrypt-failure browser journey corrupt significant payload bits deterministically,
    so random base64url tail padding cannot leave the encrypted envelope unchanged.
  - [x] Keep hosted startup coverage deterministic: cached-chat readiness is independent of pushed
    rows, while a seeded pushed row is restored and signals readiness in the same `PrepareHosted`
    output before credentials or a connection exist.
  - [x] Keep app-icon badges synchronized with engine-owned unread DMs and mentions while a page is
    open, on launch and whenever it returns to the foreground, then increment the same persisted
    counter for each worker-shown notification. Serialize engine snapshots so the latest read-marker
    state wins. Hold account-wide delivery behind per-tab visible-and-focused leases; renewals
    discard ciphertext already read, while last-tab beacon release or expiry delivers it without
    hidden-page timers.
  - [x] Offer the one-time notification permission prompt above desktop and mobile chat lists only
    on supported, configured platforms (installed home-screen mode on iOS). Request permission
    directly from the tap, enter the existing relay route flow on grant, hide on denial, and keep
    explicit dismissal in the engine-owned device Settings space across reloads.
  - [x] Recover installed clients from stale shells: use network-first navigations with bounded
    offline fallback, activate complete workers immediately with splash/hidden-only reloads, retain
    the previous build's assets during handoff, ignore and diagnose future config fields, publish a
    revalidated push block live, and show notification setup when its dismissal read fails or
    stalls. Expose every prompt visibility condition in `/debug`, with fresh-profile Firefox and
    Chromium coverage for the configured-push path. A fading splash no longer authorizes an
    interactive-page reload, and production push and mobile-input journeys wait for the worker's
    active controller before exercising delivery or the first shell interaction. Keyboard
    diagnostics stay click-through until their first trace frame so the expanded overlay cannot
    cover the mobile chat that starts one.
  - [x] Prove Firefox offline launch against a real origin outage. Playwright's Firefox offline
    override can satisfy reload from the ordinary HTTP cache instead of exercising the worker's
    Cache Storage fallback; the outage-backed shell and stale-shell checks now run in Firefox CI.
  - [x] Retire stale push routes without discarding their decryption keys, retry relay cleanup on
    launch, unregister replaced endpoints at the home, and keep route identity independent of the
    engine's per-run network handles. Push parser loads recover after cache failures; worker tests
    cover Ergo message, control and unknown-route shapes, and the payload fixture matches Ergo's
    510-byte length-limited line.
  - [x] Recover a dead relay route after Ergo refuses its registration: unregister the endpoint at
    the home before relay deletion, create and register one fresh probing route, and bound repeated
    replacement until reconnect or relaunch. `/debug` retains the typed refusal and page-side
    reason during recovery; the pinned previous-build upgrade keeps its active route and keys.
    The generic worker notification title is injected from the shared strings table at build time,
    keeping the production service worker a standalone classic script.
  - [x] Make a stalled push path diagnosable from both ends. The relay records redacted info-level
    device, route, lease, inbound disposition, and upstream-status events for journald, with only
    eight-character identifiers and no accounts, nicks, IPs, endpoints, credentials, or ciphertext.
    `/debug push`
    combines every prompt-visibility input with each network's typed engine outcome, page-known
    relay route state, route prefix, and last relay error; the common debug header carries the same
    per-network summary. Ergo's registration-probe failure is covered as typed
    `Failed(invalid_parameters)` through the wire and browser view.
  - [x] Apply push-service-specific urgency policy while preserving registration probing: Apple
    and Chromium services pass only high, while Mozilla also passes normal for silent `MARKREAD`;
    all lower priorities return 201 without forwarding. Production's Ergo 2.19.1 package already
    backports commit `9975d8d`, so normal-urgency maintenance controls are dropped for Apple and
    Chromium and forwarded to Mozilla. Worker correctness remains independent of the filter for a
    different or unpatched home. Record urgency outcomes in privacy-safe tracing (#100).
  - [x] Reconcile notifications read elsewhere: workers that receive `MARKREAD` persist its
    timestamp, close only notifications from that conversation at or before the marker, and
    recompute per-conversation badge state without showing a control notification. Maintenance
    `PING` repeats the bounded cleanup; visible pushes never run cleanup themselves. This branch is
    independent of urgency for any delivered or misclassified control. Page open/read/foreground
    updates apply the same marker comparison and correct stale Apple badges after intentionally
    dropped controls from engine counts. Parsed
    visible pushes call `showNotification` before message handoff or badge persistence, with route
    lookup bounded and a generic presentation deadline. Firefox and Chromium browser journeys prove
    `MARKREAD` itself stays silent while closing the covered DM notification and lowering its badge;
    WebKit covers foreground recovery. Its user-visible-only revocation/fallback risk is limited to
    a different home that misclassifies a control as high urgency.
  - [x] Cover the unmocked local-Ergo → relay → push-service → worker delivery journey, including
    the pinned previous build, route/subscription convergence, real encrypted DM and mention
    payloads, Apple MARKREAD filtering, multiple tabs and devices, missing keys, and refusal
    recovery. The isolated relay test feature trusts only the fixture CA and TEST-NET target;
    feature isolation checks keep the production binary identical with the feature disabled.
    Chromium, Firefox, and WebKit now cover provider-specific controls, Apple badge convergence,
    and blocked worker storage against the production-equivalent urgency-patched Ergo. The
    blocked-storage fallback presents at its receipt-anchored deadline and retries a failed browser
    presentation while the push stays alive. The upgrade journey waits for the replacement worker
    to control the page before exercising current-worker push storage.
  - [ ] Add rate limits and engine/platform stable network identity.
- **Polish pass before beta:** screen by screen (desktop and mobile, light and dark) against the prototype source: spacing, button styles, typography, time formats, badges, icons, everything in `docs/polish-notes.md`, and the desktop focus policy from doc 15 with Playwright tests. Before/after screenshots for every fix. (The mobile focus rules and keyboard behaviour belong to 7d.)
  - [x] Apply the desktop focus policy after navigation, transient surfaces, sends, and member DMs; route printable chrome keys to the composer without taking navigation keys, dialog input, or text selection.
  - [x] Keep the initial splash visible through hosted OAuth exchange and engine connection; reveal only the ready shell or a human error, without an intermediate sign-in screen.
  - [x] Keep the startup Retry action readable in both themes by using the established accent
    foreground/background token pair at WCAG AA contrast (#96).
  - [x] Make startup and render failures retryable in place; standalone retries create a fresh worker and engine, while hosted retries restart authorization.
  - [x] Ellipsize long desktop message nicks within their fixed column without reserving a transcript mode-symbol slot.
  - [x] Give distinct nickname-link browser fixtures distinct accounts so durable DM identity does not merge their conversations.
  - [x] Make the WebKit reconnect scroll setup use the measured midpoint between the edges and
    verify it across painted frames without depending on the browser's intermittent `scrollend`.
  - [x] Keep the opening-keyboard transcript snapshot through one settled paint before revealing
    the resized virtual rows, so measurement delivery cannot expose an overlapping final frame.
  - [x] Centralize every app-owned user-facing message in one typed, interpolation-ready strings
    table. Rust engine literals and app call sites are checked against it, missing runtime keys
    render visibly instead of falling back, and production TSX rejects hard-coded copy.
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
  - B1j. [x] Keep signed-out redirect timing report-only on shared CI runners. The functional gate
    still holds the real worker asset through the redirect and proves that Wasm never starts.
  - B1k. [x] Drive the three-second transient member-session fallback with Playwright's clock,
    proving PKCE authorization starts on the product timer and not before. Other hosted startup
    durations remain report-only diagnostics instead of shared-runner functional gates.
  - B2. [ ] NixOS deployment changes prepared in `~/weblounge` as a branch for Luiz to review: the static site at beta.weblounge.org and `https://beta.weblounge.org` in Ergo's `allowed-origins`. Never pushed or deployed by agents.
- **Update safety (2026-11-04).** A deploy left clients stuck on old builds: the service worker
  served a cached shell, new workers never activated, and the old strict config decoder rejected
  the new `push` field. The immediate fixes (fresh navigations, activation at launch,
  forward-compatible config) are in the stale-shell branch. Follow-ups:
  - U1. [x] An upgrade test in CI. Install the previously deployed build with its service worker
    (a flake input pinned to the last deployed SHA, served from Cachix), then serve the current
    build. The client must move to it without closing tabs, and the previous build must start with
    the current config.json.
    Last bumped to `9f094ac0c2b2b6e94976c96c67ca391ece57102b` on 2026-11-04.
  - U2. [x] A "Reset app" action on the startup error screen, shown only after repeated startup
    failures (two consecutive Retries). It clears the cached shell and service worker and reloads,
    keeping sign-in where possible. Its production test drives invalid configuration through the
    real server path in service-worker-controlled Chromium and WebKit profiles.
  - U3. [ ] A post-deploy upgrade check in weblounge's deploy smoke tests (owned by
    weblounge-server). Load beta with the previous build installed and assert the new build takes
    over and reaches the sign-in step. No account and no user data are needed.
  - U4. [x] A server-side emergency switch in hosted config.json: `client.min_build` orders builds
    by their compiled source timestamp and safely navigates an older tab once, while a changed
    device-local `client.reset_token` reuses Reset app cleanup once before a network-first reload.
    Fresh startup and live revalidation both apply it under the splash or after the page hides, so
    active typing and drafts survive. It only reaches builds that understand it, and it is
    hosted-deployment only; native apps and other networks need their own update paths. Missing
    and already-satisfied controls stay synchronous and add neither navigation nor a startup gate;
    the restored-push journey also proves its cold page is not replaced during reconnect.
- **Milestone 2.5 (after dogfooding):** split view with per-pane member lists, and the core keyboard shortcuts.
- **Milestone 4b:** replace gamja at irc.weblounge.org once the beta has proven itself.

## External dependencies

- **papo:** papo 0.1 pinned at `40c6722`. Bounded newest-page history after a cursor,
  persistable TLS-host-scoped peer identity pins,
  per-send `direct_pinned` verification, post-registration SASL account-state hardening, explicit
  display spelling and folded storage keys, split-send reconciliation, exact live
  and nested-history multiline concatenation, server name rules, lag diagnostics,
  channel-recreation warnings, hardened typed inputs, correlated history responses, exact live
  actor facts, tri-state account/bot evidence, completed JOIN refusals, and bounded request-state
  failures are integrated. Shared direct MONITOR leases survive peer departure and support guarded
  reacquisition when the peer returns.
