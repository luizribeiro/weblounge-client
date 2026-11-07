# 05 — History and read sync

Status: implemented for milestone 3.

## Problem

Conversation windows must page through all server history without confusing a short page with the
beginning, losing a cursor when old rows leave memory, or duplicating rows at page boundaries. Read
state must use the IRCv3 marker shared by every signed-in client when the server offers it, while
retaining the same local behavior on networks without read-marker support.

## Types and flow

Each buffer owns a history state separate from its bounded timeline:

```rust
enum HistoryState {
    Unrequested,
    QueuedLatest,
    LoadingLatest,
    Ready { oldest: Option<papo::HistoryReference>, at_start: bool },
    LoadingOlder { oldest: papo::HistoryReference },
    Refreshing { oldest: Option<papo::HistoryReference>, at_start: bool },
    RefreshCapped,
}
```

Each buffer separately retains its oldest paging reference and newest reconnect cursor. The newest
cursor keeps both the latest server time and its msgid when present; it belongs to `NetworkModel`,
not papo's `Client`, so hosted reconnects that replace the client retain it. Both cursors survive
timeline eviction. The oldest cursor comes from the chronologically oldest referenced event before
the page is consumed. It therefore uses a msgid whenever the server supplied one, includes
non-message history items in the boundary, and tolerates servers that reverse page delivery. A
non-empty `BEFORE` page always advances to another requestable cursor. Only an empty older page
sets `at_start`; page length and a server end hint do not. An empty initial page is terminal because
it establishes that the conversation has no available entries.

Opening a conversation requests the `Latest` edge only when that edge is still unknown. The
request is a no-op for `Ready`, so opening an already-loaded buffer never turns its retained oldest
cursor into an implicit `BEFORE` page. Reaching the transcript top through user scroll intent sends
the separate `Older` request. `LoadingOlder` keeps the buffer's projected sync state `Synced`; its
loading and boundary state is reported by `history_state_changed` at the transcript edge instead of
making the conversation title shimmer. `LoadingLatest`, reconnect `CatchingUp`, and
`Refreshing` project `Syncing` because the live edge is not yet known to be current.

Launch and reconnect begin with one `Client::recent_conversations` (`CHATHISTORY TARGETS`) query
from the last completed sync boundary through the connection's current time. A restored snapshot
supplies that boundary and each row's newest and read positions; an in-memory reconnect uses the
previous connection boundary. With neither, the first launch scans the bounded recent-direct
window. The query is the only eager conversation discovery request.

TARGETS results are diffed against the known channel and direct rows before per-buffer work starts:

- a cached target absent from the result keeps its snapshot name, preview, badge and time as the
  authoritative list row, and sends no history or marker request;
- a changed target requests one `AFTER` page from its cached read position when available, so the
  page can rebuild its unread projection, or from its cached newest position otherwise, so the
  page can extend the cached projection; and
- a target without a cached row is added only together with a bounded initial page. Joined channels
  come from connection state and direct targets come from TARGETS, so a cold launch still produces
  a complete row for every visible conversation.

The selected buffer's `LATEST` request remains driven by opening the conversation and is queued
before background TARGETS reconciliation. Opening an unchanged cached row later performs that same
on-demand `LATEST`; reaching the transcript top remains the only way to request older pages. A
changed buffer's single `AFTER` page is also enough to update its list row, but it does not make an
unopened transcript a durable cache. If the server says more entries exist beyond that page, the
engine stops instead of paging eagerly, treats the count as capped, and the shells render counts of
100 or more as `99+`. Opening that buffer then requests its newest page and leaves a gap rather than
claiming the retained page is complete.

All pages use the same msgid dedupe as live delivery. TARGETS reconciliation records the greatest
server time observed in the response as the next connection boundary only after every scheduled
delta page succeeds. Killing the engine, losing the socket, or failing a delta therefore retains
the previous boundary. A failed or unsupported TARGETS query falls back to the eager bounded
per-row path so cached rows cannot shimmer forever.

The first no-snapshot query covers only the preceding 30 days. An older DM that has no fresh
activity can therefore be absent on a new device until new traffic makes it recent. Papo caps a
TARGETS result at 1,000 entries and the engine caps restored direct rows at 100. Either cap makes
the result incomplete, so the engine does not advance the durable boundary and retries from the
previous boundary next time.

History events are sorted before delivery to the UI and merged through the engine's existing msgid
deduplication. The UI may retain more rendered rows than the engine window; cursor ownership stays
in the engine and never depends on a retained row.

When read markers are supported, every cached direct with a nonzero badge schedules
`Client::fetch_read_marker`; zero-badge unchanged directs retain the snapshot projection and do not query.
Channels do not fetch a marker during launch or reconnect because Ergo pushes their marker while
joining. An explicitly opened cold buffer may fetch its marker with the on-demand latest page.
Fetched and live `ReadMarkerChanged` events use the same path and a marker only moves forward.
Without server support, `MarkRead` advances the local marker.

An unset channel marker does not make history from before the account joined unread. The own JOIN's
server time becomes a device-local unread floor, without sending or persisting a server marker;
only later rows contribute to the channel badge. This keeps retained history quiet for a new user
while preserving unread traffic received by an always-on account after it joined. A real server
marker remains the cross-device read position and takes precedence when it is newer. Direct
conversations retain their existing policy because every unread DM has mention severity. A restored
push is explicit unread evidence: it bypasses a later device-local JOIN floor, including after its
authoritative history copy replaces the provisional row, but never bypasses a real read position.

Visible conversation instances remain the source of read intent. A foreground instance at the
live edge for the signed-off 500ms dwell sends the latest committed row. The engine translates that
row to a server time and records that local read position immediately. This local advance always
clears unread state, including when the row was restored from push. Such a row remains provisional
for server sync: `Client::mark_read` waits until live delivery or a history result verifies that
exact row's server msgid and time, then marks only that row. Unrelated traffic cannot consume or
advance the deferred intent. Leaving the conversation retains that buffer's intent; when live
delivery or history later verifies the exact row, the engine sends its marker even if another
conversation is selected. A disconnect also retains in-memory deferred intent so resumed history
can verify it, while an already validated advance remains queued until `Connected`. A full engine
termination does not persist an unverified intent: relaunch rebuilds the read position from the
server and may show that row unread again if verification and MARKREAD had not completed. When read
markers are supported, the engine coalesces pending advances per conversation; an unavailable
connection leaves a validated advance queued until `Connected` instead of rejecting or losing it.
A server refusal is retried with bounded backoff and recorded in diagnostics rather than shown as a
notice. Cached conversations use this same dwell and queue after history paints; they have no
separate mark-read action or protocol request. The engine does not poll. For badge counts, DMs
classify every incoming message as a mention, while channels classify only messages matching the
highlight rules. Row highlighting is independent of that DM badge policy: in every conversation, a
row is highlighted only when its text matches the rules. The initial rule is the current nick as an
IRC-casemapped word; later user-defined keywords extend the engine matcher without changing the UI
projection. Both shells always show the engine's total unread count. Unread-only buffers use the
accent badge; a buffer with one or more mentions uses the mention-badge colours while keeping the
total unread count. DMs therefore always use the mention treatment. The count and an accessible “N
unread, including mentions” label keep severity from being colour-only.

The unread `New` boundary uses the same platform foreground authority as the read dwell and push
lease. While the open conversation is at its live edge, an arrival advances the provisional
boundary past itself so the line does not flash while the 500ms dwell catches up. A hidden page, a
different open conversation, or an instance away from its live edge freezes the boundary at the
current marker. A visible iOS standalone PWA is foreground even when WebKit reports false focus;
`pageIsForeground` is the single definition for all of these decisions.

## Boundaries

This subsystem owns history request state, page cursors, history merge delivery, marker fetch/send,
and unread/mention projections. Papo owns CHATHISTORY and MARKREAD encoding, request correlation,
conversation identity, capability negotiation, cached marker state, and live marker events.

It does not own durable history storage, retention tuning, message-list anchoring, Activity ranking,
notification policy, or background push delivery.

## Testing

- Pure engine tests cover empty/non-empty terminal pages, cursor survival across bounded eviction,
  directional latest/older requests, TARGETS diff decisions for unchanged, changed and uncached
  rows, the one-page cap, the title sync mapping, and the badge/highlight matrix for direct messages
  and channels with and without a nick match.
  UI derivation tests cover no unread, unread with and without mentions, DMs, and counts above 99.
- Scripted papo transcripts page through more than 1,000 same-time messages and assert every msgid
  is delivered once in chronological order. Reconnect transcripts cover ready direct messages,
  channels retained across a fresh hosted client, multi-page catch-up, and the catch-up cap.
  Separate transcripts cover initial marker fetch, online and queued-offline marker sends, and live
  remote advances. A restored pushed DM clears locally at once while deferring only its server
  marker until authoritative history reconciles the row; a refused marker is diagnostic-only and
  retries after bounded backoff.
- The production-shaped Ergo integration repeats the long paging scenario against the server's
  configured limits. A stock-fakelag launch with seven channels, nine direct conversations and a
  cached snapshot sends exactly 36 commands (`CHATHISTORY` 4, `MARKREAD` 2, `MONITOR` 0 and at most
  seven `WHO`), proves client reconciliation requests do not add fakelag quanta behind one another,
  and checks changed and unchanged list projections. The equivalent cold launch sends 48 commands;
  its TARGETS plus 16 initial pages total 17 CHATHISTORY commands, one above the default budget.
- Production-profile Playwright reconnects after own multiline and bot split/multiline sends,
  asserting exact text, authorship, sender, server-time ordering, and a stable live-edge viewport
  on every animation frame during the first second after history appears.
- Desktop and iPhone WebKit route the app through a controllable TCP forwarder, silently strand the
  browser socket, deliver channel and direct messages to the always-on account, foreground the app,
  and assert both opened conversations catch up without reload.
- Desktop Chromium and iPhone WebKit open a direct conversation against local Ergo and deliver a
  live message at the focused live edge, while hidden, and while scrolled up. The focused arrival
  never mounts a `New` boundary before or after the read dwell; both away cases retain one.
- Playwright uses two independent browser contexts signed in to the same account: reading at the
  live edge in one clears the unread and mention indicators in the other. Native-feel idle and
  hidden-tab audits remain green. A direct message without a nick match keeps its red total-unread
  badge but has no transcript highlight background. Desktop and mobile badge coverage checks both
  severity treatments in light and dark themes.

## Out of scope

Persistent local timelines, offline read-marker queues, search, around-message jumps, and exact
unread counts beyond the one-page launch cap are later work.
