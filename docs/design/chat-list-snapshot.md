# Startup chat-list snapshot

Status: implemented 2026-11-01 from Luiz's approved revision.

## Problem

The current splash waits for live buffer discovery and latest-history hydration, so a returning
user sees branding while the app already knows what the Chats screen looked like. Approach A keeps
one deliberately narrow launch snapshot of that screen. It gives launch an immediate recognizable,
interactive frame without making cached IRC state authoritative or expanding doc 05 into durable
history. This is the first step toward offline use, not a complete offline mode.

## Record

The engine stores one versioned `ChatListSnapshot` record in the device-local `Cache` space of the
approved `KvBackend`. On the web that space is the `cache` object store in the single IndexedDB
database reached through `idb`; native backends use the same typed layer.

The record contains a schema version, the configured-network identity fingerprint, and ordered
rows. A row's durable conversation identity is one of:

```text
channel = configured network identity + Channel::key()
direct  = configured network identity + Nick::key()
```

Both keys are scoped to the configured connection profile. A DM thread never keys or merges by
account; a nickname rename names a different thread. Papo's separate peer-verification pin may
protect sends to that nick, but it is not the thread key. Each row contains only:

- that durable channel or direct identity;
- display name and explicit list order;
- one optional last-activity timestamp in milliseconds since the Unix epoch, using the same value
  that orders the live chat list;
- the visible badge projection: total unread count plus the exact mention count used to choose its
  severity treatment; and
- an optional, single-line latest-message preview, already truncated by the UI's visible excerpt
  rule (currently 80 characters plus an ellipsis). Direct-message previews are included under the
  same bound.

There is no transient `BufferId`, message timestamp beyond that single row activity value, topic,
membership, read marker, message identifier, message body beyond the truncated preview,
conversation transcript, or paging cursor. The record is not a history cache. Mobile Chats is the
required consumer; desktop may render the same rows in its sidebar only if that reuses this record
and the existing row geometry without a second schema.

## Write, read, and replacement

Every projected chat-list update schedules a trailing, throttled rewrite. The rewritten record is
assembled per row: a row whose latest history has loaded uses its current projection, including a
cleared badge, while a row that is still queued, loading, or failed keeps its previous cached row.
A new unresolved row is omitted until it becomes authoritative, and a row known to be unavailable
is removed. This lets one slow buffer retain its safe cached values without blocking authoritative
changes from every other buffer.

The merge happens in engine memory before the rewrite; storage still receives one ordered record
in one atomic commit. Repeated changes coalesce. Clearing one or all read badges starts the pending
rewrite immediately. When the page becomes hidden or fires `pagehide`, it likewise asks the engine
to start an already-pending rewrite before the browser can suspend its worker. A lifecycle flush
does not create a write when no update is pending.

At launch the engine reads and validates the record before live synchronization completes. A valid
record renders through the normal chat-list geometry. There is no “Connecting…” or “Reconnecting…”
copy and no full-screen connection state. While the engine is connecting, reconnecting, or
hydrating the snapshot, the weblounge logo in the mobile Chats header or desktop sidebar carries a
subtle token-driven shimmer. It is still when ready; reduced motion replaces animation with a
gentle static dim.

Cached rows are interactive through their durable identities. Selecting one navigates immediately
and opens the normal conversation shell. Until its live target and history resolve, the transcript
keeps its normal geometry without progress copy or a spinner. The composer remains available: a
submission creates its optimistic row and enters the engine-owned FIFO introduced in `772e05b`,
keyed to the durable conversation identity until a live send target resolves. It flushes through
the existing send path in order once the network connects and the target is sendable; the UI does
not own a second queue. Queued sends remain visible as pending transcript rows; the composer does
not add connection-state copy or change the conversation width.

Selecting a cached direct conversation also requests its latest history. A request made before
registration is queued in the engine and starts after `Connected`; it does not depend on the
30-day recent-target list or fresh traffic creating the live buffer. Starting that request promotes
the row from snapshot state, discards its cached preview and badge projection, and lets fetched
history plus the server read marker rebuild unread state. An empty successful page still completes
that promotion. The transcript has no separate cached-state mark-read control: automatic live-edge
dwell begins after live history paints and uses the normal server-sync path.

The engine's first complete live chat-list snapshot replaces the cached record in the UI in one
batch. The per-row persistence merge is internal and never exposes a mixed cached/live list to the
UI. A selected cached identity rebinds to its live buffer when present, and the quiet state gives
way to live history. A channel absent because it was left on another device is removed with its
route; desktop selects the preceding live buffer and mobile returns to Chats. The client never
silently rejoins or retargets it. Any queued send to that departed identity still finishes against
its original target and cannot reopen the buffer.

The cached values are otherwise never used as live unread state, notifications, history, or
protocol identity proof. Matching cached and live fixtures retain the same row boxes, so the swap
has no blank frame or layout shift; real changes may update content and ordering only at that
wholesale boundary.

## Splash, invalidation, and privacy

With a valid cached snapshot, the splash reveals the cached Chats frame as soon as the shell and
fonts can paint it; it no longer waits for live readiness. The existing live-ready behavior remains
the fallback when the cache is absent or ignored, including its bounded wait. Live synchronization
continues behind the normal shell, with only the logo treatment indicating transient progress.
Hosted startup supplies the public network profile to the engine before the page-owned session
token request completes, so a slow or offline credential endpoint cannot hold a matching snapshot
behind the splash. Tokens remain one-shot secrets and are never persisted.

Transient drops that recover use that same shimmer and no error copy. An actionable failure uses
the one shell-owned connection error strip instead: immediately under the top bar on every mobile
screen and at the top of the desktop sidebar. It contains a few words and one action, such as “Sign
in again” or “Retry”, disappears when resolved, and gives the logo an error-token tint while shown.
It is never duplicated in the Chats header or conversation header.

Sign-out clears the snapshot as part of clearing device-local cache. Badge counts bump the schema
version; the two earlier snapshot schemas migrate their lossy dot or mention count to the closest
representable count, while new records preserve both engine counters. Any other schema/version
mismatch or decode failure is ignored. A configured-network identity mismatch
is also ignored, preventing one account or network configuration from appearing under another;
the next complete online projection may replace it.

The snapshot is ordinary device-local cache, not encrypted secret storage. A person or process
with access to the browser profile or native app data can read chat names, badge state, and the
latest truncated preview, including DMs. It contains no credentials and no full history, may be
evicted at any time, and must never be required for a correct cold launch.

## Testing

- Serialization and engine tests cover the exact bounded shape, DM preview truncation, atomic
  whole-record writes, row activity round-tripping into the live ordering field, preserved row
  order and rendered times, channel and nick keys scoped by network identity, throttling with an
  injected clock, authoritative-row replacement, and preservation of unresolved cached rows.
- Validation tests ignore corrupt, unknown-version, and wrong-network records; sign-out clears the
  record and a following launch cannot paint it.
- A Chromium and WebKit Playwright filmstrip starts with a seeded cache and delayed engine. Its
  first revealed app frame contains cached rows and previews in the normal shell, with only the
  token-driven logo treatment, then swaps once to live rows with no blank frame or layout shift.
  When seeded and live state match, row text, order, and times do not change in the swap frame.
  Reduced-motion coverage sees a static dim and no animation.
- Before live state arrives, Playwright taps a cached row and observes the quiet conversation
  state, submits a message, observes its optimistic pending row, and verifies FIFO delivery after
  connection; the composer hint is present only while delivery is affected. Cached-DM coverage
  verifies that desktop and mobile replace the placeholder with server history and expose no
  transcript-covering mark-read control.
- A seeded row omitted from the first complete live list remains open as not available, offers a
  working route back to Chats, and never sends its queued message to another target.
- A built-app relaunch begins with a cached unread DM, clears it while another buffer is still
  hydrating, backgrounds immediately, and proves the next cached frame has the cleared DM without
  provisional changes to the unresolved row.
- Transient recovery shows no status text or strip. Actionable failure shows the single shared strip
  on Chats and conversation screens, tints the logo, and clears both when resolved.
- The existing no-cache startup, splash geometry, live-ready cap, native-feel idle, and hidden-tab
  checks remain green.

## Offline direction and out of scope

This slice makes cached discovery and navigation useful and reuses reconnect-safe, in-memory sends
and deferred read intent. Later offline work adds bounded cached conversation tails, durable send
and mark-read queues that survive worker or app termination, retry/conflict policy, target-pin
verification while disconnected, retention and eviction, and production offline journeys. None of
that broader storage or history work, incremental UI list reconciliation, or cross-device cache
sync is part of this design.
