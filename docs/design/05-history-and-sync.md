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
}
```

The cursor comes from the chronologically oldest referenced event before the page is consumed. It
therefore uses a msgid whenever the server supplied one, includes non-message history items in the
boundary, tolerates servers that reverse page delivery, and survives timeline eviction. A
non-empty `BEFORE` page always advances to another requestable cursor. Only an empty older page
sets `at_start`; page length and a server end hint do not. An empty initial page is terminal because
it establishes that the conversation has no available entries.

History events are sorted before delivery to the UI and merged through the engine's existing msgid
deduplication. The UI may retain more rendered rows than the engine window; cursor ownership stays
in the engine and never depends on a retained row.

When read markers are supported, creation or restoration of a channel or direct buffer schedules
`Client::fetch_read_marker` for its typed papo conversation. The result is applied to the buffer's
projection after history merges; live `ReadMarkerChanged` events use the same path. A marker only
moves forward. Without server support, `MarkRead` advances the local marker.

Visible conversation instances remain the source of read intent. A foreground instance at the
live edge for the signed-off 500ms dwell sends the latest committed row. The engine translates that
row to a server time and calls `Client::mark_read`; it does not poll. For badge counts, DMs classify
every incoming message as a mention, while channels classify only messages matching the highlight
rules. Row highlighting is independent of that DM badge policy: in every conversation, a row is
highlighted only when its text matches the rules. The initial rule is the current nick as an
IRC-casemapped word; later user-defined keywords extend the engine matcher without changing the UI
projection. The shells project unread-only state as a subtle dot and mentions as an accent count
badge.

## Boundaries

This subsystem owns history request state, page cursors, history merge delivery, marker fetch/send,
and unread/mention projections. Papo owns CHATHISTORY and MARKREAD encoding, request correlation,
conversation identity, capability negotiation, cached marker state, and live marker events.

It does not own durable history storage, retention tuning, message-list anchoring, Activity ranking,
notification policy, or background push delivery.

## Testing

- Pure engine tests cover empty/non-empty terminal pages, cursor survival across bounded eviction,
  and the badge/highlight matrix for direct messages and channels with and without a nick match.
- Scripted papo transcripts page through more than 1,000 same-time messages and assert every msgid
  is delivered once in chronological order. Separate transcripts cover initial marker fetch,
  marker sends, and live remote advances.
- The production-shaped Ergo integration repeats the long paging scenario against the server's
  configured limits.
- Production-profile Playwright reconnects after own multiline and bot split/multiline sends,
  asserting exact text, authorship, sender, server-time ordering, and a stable live-edge viewport
  on every animation frame during the first second after history appears.
- Playwright uses two independent browser contexts signed in to the same account: reading at the
  live edge in one clears the unread and mention indicators in the other. Native-feel idle and
  hidden-tab audits remain green. A direct message without a nick match keeps its mention badge but
  has no transcript highlight background.

## Out of scope

Persistent local timelines and cursors, offline read-marker queues, search, around-message jumps,
newer-direction paging, and unread counts for rows outside the fetched window are later work.
