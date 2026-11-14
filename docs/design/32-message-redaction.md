# 32 — Message redaction

Status: product decisions from Luiz on 2026-11-14. This addendum to designs 14, 17, 24, 25 and 26
covers deleting your own messages and showing deletions that others make, over IRCv3
`draft/message-redaction` (`REDACT <target> <msgid> [:reason]`).

## Problem

People want to take back a message they sent, and a deleted message must disappear on every device
and every surface where its text appeared: the transcript, the chat-list preview, the persisted
snapshot, unread counts and notifications. Removing a row outright would move the transcript under
the reader and hide that anything happened, so the row stays and its text is visibly gone.

papo at the pinned revision already negotiates the capability by default (`Feature::Redaction`),
sends `REDACT` through `Client::redact(MessageRef, reason)` and delivers `Event::Redacted` live and
inside history pages. papo needs nothing.

### Ergo's behaviour

Ergo 2.19 (the local fixture and weblounge) deletes the message from its history buffer, then sends
`REDACT` to every session of every member that negotiated the cap, the sender's included. It never
stores the `REDACT` line, so `CHATHISTORY` neither replays a redaction nor returns the deleted
message. Channel redaction needs `history.retention.allow-individual-delete` (weblounge sets it; the
local fixture now does too); a DM redaction is always allowed for your own messages. Failures are
`FAIL REDACT REDACT_FORBIDDEN | UNKNOWN_MSGID | INVALID_TARGET`. A redaction you make reaches your
own client as an echo.

This answers design 26's open question about Ergo's history; the papo wire tests still cover a
redaction inside a history page, which other servers may send.

### What this amends

- Design 26 §5 "Tombstone": the content is `MessageKind::Redacted(Redaction { by })` rather than
  `Deleted { by }`; the preview falls back to the previous message (R8) rather than always saying
  "Message deleted"; the redacted message's unread stub is removed (R9) rather than kept; and the
  "redaction before message" memory is its own small set, because the reaction index keys reaction
  facts per actor and has no slot for a redactor. The push-log body rule is unchanged and stays in
  the Backlog with the other notification work (R10).
- Design 17: `NetworkProjection.message_redaction` is the network input that the per-message
  `MessageActions.redact` will be built from once message actions exist; until then the UI combines
  it with the message's own facts in one predicate, so there is still one source of truth.

## Decisions

- **R1, the row.** A redacted message keeps its id, order, sender and time, so the time and nick
  gutter stay. Its text is replaced by black redaction bars, a "classified document" line, and its
  inline image and reaction chips are removed. The body is one line high, so a redaction can only
  shrink a row's body.
- **R2, the bars.** They are generated from the row's first server msgid, never from the original
  text, whose length would leak. Every device draws the same pattern for the same message
  (algorithm below). Rows without a server msgid are never redacted.
- **R3, the colour.** Bars use a new per-theme `redactionBar` colour token (the foreground in
  light themes, the muted colour in dark ones) with a radius of `min(2px, control radius)`.
- **R4, accessibility and copy.** The row's accessible text is "Message deleted", or "Message
  deleted by `<nick>`" when the redactor is not the sender. The bars are `aria-hidden`. Copying the
  row copies that same text.
- **R5, stability.** A redaction above the viewport keeps what the reader sees still, through the
  list's existing visual anchor for in-place row changes. A redaction inside the viewport shrinks
  that row in place; the rows below follow without animation, because the list positions rows by
  measurement and a height transition would make every later row drift for its duration. The bars
  fade in over `--wl-motion-fade`, and not at all under reduced motion.
- **R6, your own messages.** "Delete message" appears only on your own committed messages that
  have a server msgid, while the network is online and negotiated the cap. It always asks first
  ("Delete this message? It will be deleted for everyone.") through `ConfirmationDialog`. We send no
  reason. Nothing is applied optimistically. Success means `Client::redact` returned Ok for every
  one of the row's msgids; the engine then redacts the row itself, and the server's echo that
  follows is a no-op. On failure (`FAIL REDACT`, timeout, disconnect) an error toast says "Couldn't
  delete the message" and the row stays as it is, unless the server already echoed the redaction of
  an earlier line of a multi-line message, which redacts the whole row.
- **R7, entry points.** No message action surface existed, so this adds the smallest consistent
  ones:
  - Desktop: right-clicking an own message's chrome (time, nick, the row's padding) opens the
    shared `ContextMenu` with the destructive "Delete message". Right-clicking the text keeps the
    browser's menu (design 15). With the message selected by Up in an empty composer, Delete opens
    the confirmation (design 14's `message.redact`), and the Menu key or Shift+F10 opens the menu.
  - Phone: a long press (500ms, inside the movement threshold, as on chat rows) on an own message
    opens an action sheet with "Delete message" and Cancel; the sheet names the message's text. Long
    press on other people's messages keeps the native text selection; on your own messages the
    sheet wins and the press does not start a text selection. Design 25's full phone sheet
    (reactions, Reply, Copy text) later adds its items to this sheet.
- **R8, the chat-list preview.** When the latest message is redacted, the preview shows the
  previous loaded message, or "Message deleted" when there is none. The redacted row still counts
  for activity time and the history cursor, so the row's time and position do not change. A
  redacted message that is not the latest needs no preview change.
- **R9, unread and mentions.** A redacted unread message stops counting, toward the unread count,
  the mention count and the app badge. This supersedes design 26 §5's "read facts unchanged".
- **R10, notifications.** When a shown page or push notification is for the redacted message, the
  page closes it. A redaction that arrives while no page is open cannot close a notification
  (Backlog).
- **R11, replies.** Reply quotes are not built yet (design 25 batch 2). When they are, a reply
  whose parent is redacted shows a "Deleted message" quote; the parent's projection already says
  so. Reactions on a redacted message are dropped and later ones are ignored.

## Bar generation

`redactionBars(msgid: string): readonly number[]` returns bar widths in `ch`.

1. Seed: 32-bit FNV-1a over the msgid's UTF-16 code units (offset basis `0x811c9dc5`, prime
   `0x01000193`, `Math.imul`).
2. Generator: mulberry32 seeded with that hash; each call returns a float in `[0, 1)`.
3. Count: `3 + floor(next() * 6)`, so 3 to 8 bars.
4. Each width: `2 + floor((next() + next()) * 4)`, so 2 to 9 characters, peaking at 5 to 6 like
   English words.

The widths are a pure function of the msgid; the row never reads the original text. Bars are
`0.9em` tall, separated by a `0.5ch` gap, in a flex row that wraps into a one-line box with
`overflow: hidden`, so bars that do not fit on a narrow phone drop out whole instead of wrapping.

## Types and boundaries

- Protocol: `MessageKind::Redacted(Redaction { by: Option<String> })`, where `by` is the redactor's
  nick when it is not the sender. A redacted projection has empty `text`, no reactions and no
  highlight; the original text and retry text are dropped from the engine, so nothing downstream
  can show it. The text can still sit in a snapshot preview or a restored provisional preview
  until the next derivation (R8 and Edge cases) and in the push log (Backlog).
- `NetworkProjection.message_redaction: bool`: true while the network is online and papo supports
  `Feature::Redaction`. With the message's own authorship, committed delivery and server msgid it
  decides whether "Delete message" exists (design 17's `MessageActions.redact`).
- Request: `EngineRequest::RedactMessage { buffer_id, message_id }`. The engine re-checks the row
  (own, committed, has msgids, not yet redacted), resolves the channel or DM target as sends do,
  and calls `Client::redact` for each of the row's server msgids in order. It replies with
  `CommandResult`, or `CommandRejected` with `engine.redact_failed` plus an error `Notice` toast.
- Receive: `NetworkModel::receive_redaction` finds the row through the msgid map, live or from a
  history page, in channels and DMs. A redaction whose message is not loaded is remembered in a
  bounded set (256 msgids), so that message arrives already redacted if a later page or push
  delivers it.
- Read facts: `ReadFacts` gains bounded stub tombstones `{ msgid, time }`. Redacting removes the
  stub and records its tombstone; merges union tombstones and drop matching stubs, so a stale
  snapshot or another tab cannot bring the unread count back. Tombstones at or below the mark are
  pruned with the stubs, and at most `MAX_STUBS` (100) are kept, oldest dropped first. The snapshot
  row persists them in a new `#[serde(default, skip_serializing_if = "Vec::is_empty")]` field, so
  older builds still read it and no schema bump is needed.
- Preview: `latest_real_message` stays the activity source; the preview skips redacted rows.
- Notifications: the engine emits `EngineToUi::MessageRedacted { network_id, buffer_id, msgid }`.
  The page notifier closes its notification for that msgid, and the page closes service-worker
  notifications whose data names it.

## Edge cases

- Redacting a multi-line message redacts every line's msgid; a received redaction of any one of a
  row's msgids redacts the whole row.
- A second redaction of the same row is a no-op, including the server's echo after the engine
  applied your own redaction. A redaction for an unknown msgid changes nothing visible.
- A stub already evicted past `MAX_STUBS` sits behind `gap_until`, so the unread badge (99+) does
  not drop for it.
- The stability rule uses the list's in-place revision path: a changed row revision remeasures
  through `remeasureRows`, which keeps the first visible row still with
  `preserveVisualScrollAnchor` unless the reader is at the live edge.
- A pending, optimistic or failed own row has no server msgid and offers no Delete.
- After a relaunch, Ergo's history no longer contains the message, so the row is simply absent.
  A message redacted while this device was offline stays in a restored preview until history
  reloads (Backlog), and its stub may count until a later mark covers it.
- A redaction by an operator of someone else's message shows "by `<nick>`".

## Testing

- Unit (TS): `redactionBars` is deterministic per msgid, always 3 to 8 bars of 2 to 9 characters,
  differs across msgids, and never depends on anything but the msgid. Component tests: the bars are
  `aria-hidden`, the accessible text, copy text, size estimate one line.
- Engine (papo-testing wire): live channel and DM `REDACT`, redaction in a history page, early
  redaction, another user's redaction, own redaction request (wire line, validation failures,
  `FAIL REDACT` toast), preview fallback, unread and mention drop, tombstones surviving snapshot
  merges, and the `message_redaction` flag across connect and disconnect.
- Playwright against local Ergo, desktop and phone: a peer redacts in a channel and a DM and the
  row shows bars; a redaction above the viewport does not move the visible rows and one inside the
  viewport shrinks in place (geometry assertions plus `nativeFeelAudit`); you delete your own
  message through the menu and the sheet with confirmation; the chat-list preview updates; the
  unread count drops.

## Out of scope

Deleting other people's messages as an operator (the action is gated to own messages), a reason
field, undo, message editing, server-side search removal, and closing notifications while no page
is open.
