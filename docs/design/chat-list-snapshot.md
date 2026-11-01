# Startup chat-list snapshot

Status: proposed; awaiting Luiz's implementation sign-off.

## Problem

The current splash waits for live buffer discovery and latest-history hydration, so a returning
user sees branding while the app already knows what the Chats screen looked like. Approach A keeps
one deliberately narrow, display-only snapshot of that screen. It gives launch an immediate
recognizable frame without making cached IRC state authoritative or expanding doc 05 into durable
history.

## Record

The engine stores one versioned `ChatListSnapshot` record in the device-local `Cache` space of the
approved `KvBackend`. On the web that space is the `cache` object store in the single IndexedDB
database reached through `idb`; native backends use the same typed layer.

The record contains a schema version, the configured-network identity fingerprint, and ordered
rows. Each row contains only:

- the stable engine-owned buffer identity, including channel/direct kind and network identity;
- display name and explicit list order;
- the visible badge projection: none, unread dot, or mention count; and
- an optional, single-line latest-message preview, already truncated by the UI's visible excerpt
  rule (currently 80 characters plus an ellipsis). Direct-message previews are included under the
  same bound.

There is no transient `BufferId`, timestamp, topic, membership, read marker, message identifier,
message body beyond the truncated preview, conversation transcript, or paging cursor. The record
is not a history cache. Mobile Chats is the required consumer; desktop may render the same rows in
its sidebar only if that reuses this record and the existing row geometry without a second schema.

## Write, read, and replacement

Changes to the projected chat-list fields schedule a trailing, throttled rewrite of the whole
record. The engine may write only after it has an online, complete list: buffer discovery and
latest-message hydration have finished for the relevant networks. Reaching the startup time cap,
reconnecting, or holding a partial/error projection never overwrites the last complete record.
Repeated changes coalesce, and the one-record commit is atomic.

At launch the engine reads and validates the record before live synchronization completes. A valid
record renders through the normal chat-list geometry as a distinct cached state with a clear
“Connecting…” status. Cached rows are inert: they cannot navigate, mark read, select a live buffer,
or supply data to any engine command. Interaction begins only from live projections.

The engine's first complete live chat-list snapshot replaces the cached record in the UI in one
batch. Cached and live rows are never merged or diffed, and cached data is never consulted for
identity, unread state, navigation, notifications, history, or recovery. Matching cached and live
fixtures retain the same row boxes, so the swap has no blank frame or layout shift; real changes
may update content and ordering only at that wholesale boundary.

## Splash, invalidation, and privacy

With a valid cached snapshot, the splash reveals the cached Chats frame as soon as the shell and
fonts can paint it; it no longer waits for live readiness. The existing live-ready behavior remains
the fallback when the cache is absent or ignored, including its bounded wait. Live synchronization
continues behind the connecting cached frame.

Sign-out clears the snapshot as part of clearing device-local cache. A schema/version mismatch or
decode failure is ignored rather than migrated. A configured-network identity mismatch is also
ignored, preventing one account or network configuration from appearing under another; the next
complete online projection may replace it.

The snapshot is ordinary device-local cache, not encrypted secret storage. A person or process
with access to the browser profile or native app data can read chat names, badge state, and the
latest truncated preview, including DMs. It contains no credentials and no full history, may be
evicted at any time, and must never be required for a correct cold launch.

## Testing

- Serialization and engine tests cover the exact bounded shape, DM preview truncation, atomic
  whole-record writes, throttling with an injected clock, and refusal to write partial, capped, or
  offline projections.
- Validation tests ignore corrupt, unknown-version, and wrong-network records; sign-out clears the
  record and a following launch cannot paint it.
- A Chromium and WebKit Playwright filmstrip starts with a seeded cache and delayed engine. Its
  first revealed app frame contains the cached rows and previews in a connecting, non-interactive
  state, then swaps once to live rows with no blank frame or layout shift.
- The existing no-cache startup, splash geometry, live-ready cap, native-feel idle, and hidden-tab
  checks remain green.

## Out of scope

Cached conversations, offline reading or actions, incremental reconciliation, retention policy,
cross-device sync, and any replacement for the broader storage and history designs.
