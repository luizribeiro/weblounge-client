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
    LoadingLatest,
    Ready { oldest: Option<papo::HistoryReference>, at_start: bool },
    LoadingOlder { oldest: papo::HistoryReference },
    CatchingUp { oldest: Option<papo::HistoryReference>, at_start: bool, fetched: usize },
    CatchingUpLatest { oldest: Option<papo::HistoryReference>, at_start: bool },
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

After every `Connected` following the first, each ready channel and direct conversation requests
`Client::history(target).after(newest)`. Non-terminal pages advance the retained cursor and request
the next page until the server reports the end or returns an empty page. Catch-up is capped at 500
items per buffer; crossing the cap inserts a transcript gap notice and merges one `LATEST` page so
the live edge is still current. `CHATHISTORY TARGETS` also starts `AFTER` for a ready direct when its
reported latest server time is newer than the retained cursor. All pages use the same msgid dedupe
as live delivery.

History events are sorted before delivery to the UI and merged through the engine's existing msgid
deduplication. The UI may retain more rendered rows than the engine window; cursor ownership stays
in the engine and never depends on a retained row.

When read markers are supported, creation or restoration of a channel or direct buffer schedules
`Client::fetch_read_marker` for its typed papo conversation. The result is applied to the buffer's
projection after history merges; live `ReadMarkerChanged` events use the same path. A marker only
moves forward. Without server support, `MarkRead` advances the local marker.

Visible conversation instances remain the source of read intent. A foreground instance at the
live edge for the signed-off 500ms dwell sends the latest committed row. The engine translates that
row to a server time and records that local read position immediately. When read markers are
supported, the engine coalesces pending advances per conversation and calls `Client::mark_read`;
an unavailable connection leaves the advance queued until `Connected` instead of rejecting or
losing it. Cached conversations use this same dwell and queue after history paints; they have no
separate mark-read action or protocol request. The engine does not poll. For badge counts, DMs
classify every incoming message as a mention, while channels classify only messages matching the
highlight rules. Row highlighting is independent of that DM badge policy: in every conversation, a
row is highlighted only when its text matches the rules. The initial rule is the current nick as an
IRC-casemapped word; later user-defined keywords extend the engine matcher without changing the UI
projection. Both shells always show the engine's total unread count. Unread-only buffers use the
accent badge; a buffer with one or more mentions uses the mention-badge colours while keeping the
total unread count. DMs therefore always use the mention treatment. The count and an accessible “N
unread, including mentions” label keep severity from being colour-only.

## Boundaries

This subsystem owns history request state, page cursors, history merge delivery, marker fetch/send,
and unread/mention projections. Papo owns CHATHISTORY and MARKREAD encoding, request correlation,
conversation identity, capability negotiation, cached marker state, and live marker events.

It does not own durable history storage, retention tuning, message-list anchoring, Activity ranking,
notification policy, or background push delivery.

## Testing

- Pure engine tests cover empty/non-empty terminal pages, cursor survival across bounded eviction,
  and the badge/highlight matrix for direct messages and channels with and without a nick match.
  UI derivation tests cover no unread, unread with and without mentions, DMs, and counts above 99.
- Scripted papo transcripts page through more than 1,000 same-time messages and assert every msgid
  is delivered once in chronological order. Reconnect transcripts cover ready direct messages,
  channels retained across a fresh hosted client, multi-page catch-up, and the catch-up cap.
  Separate transcripts cover initial marker fetch, online and queued-offline marker sends, and live
  remote advances.
- The production-shaped Ergo integration repeats the long paging scenario against the server's
  configured limits.
- Production-profile Playwright reconnects after own multiline and bot split/multiline sends,
  asserting exact text, authorship, sender, server-time ordering, and a stable live-edge viewport
  on every animation frame during the first second after history appears.
- Desktop and iPhone WebKit route the app through a controllable TCP forwarder, silently strand the
  browser socket, deliver channel and direct messages to the always-on account, foreground the app,
  and assert both opened conversations catch up without reload.
- Playwright uses two independent browser contexts signed in to the same account: reading at the
  live edge in one clears the unread and mention indicators in the other. Native-feel idle and
  hidden-tab audits remain green. A direct message without a nick match keeps its red total-unread
  badge but has no transcript highlight background. Desktop and mobile badge coverage checks both
  severity treatments in light and dark themes.

## Out of scope

Persistent local timelines and cursors, offline read-marker queues, search, around-message jumps,
and unread counts for rows outside the fetched window are later work.
