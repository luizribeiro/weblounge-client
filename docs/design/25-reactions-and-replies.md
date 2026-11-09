# 25 — Reactions and replies

Status: approved product decisions; batch 1 implements received reactions only.

## Problem

Reactions and inline replies must survive live/history overlap, remain useful when a network later
loses a capability, and fit desktop and phone message rows without moving existing columns. Papo
owns IRCv3 parsing, feature detection, sending, and history queries; the engine owns durable chat
meaning; the UI only presents typed projections and available actions.

## Types

Each confirmed message keeps `reactions: BTreeMap<ReactionKey, ReactionSummary>` as sketched in
[01](01-engine-state-model.md). A summary contains the exact reaction text, a first-seen ordinal,
and actors keyed by their casemapped nick so live and history remain identical when one omits the
account tag. Each actor retains its display nick and whether it is this client. A nick change makes
later reaction facts a new actor; it does not rewrite the identity recorded on older server lines.
The ordinal, not map order, gives chips first-reaction-first order.

Each `(target msgid, reaction text, actor)` fact is last-writer-wins by `(server time, reaction
msgid)`. Removals are retained as tombstones so an older add or duplicate replay cannot resurrect a
chip. The target-msgid index retains bounded per-buffer facts that precede their message, attaches
them when that message enters a window, and releases them with timeline eviction, part, or close.

The Engine/UI projection exposes exact text, ordered actors, count, and `mine`. Text reactions are
presented in monospace and truncated visually to 16 characters; the who-reacted surface retains the
full text. Reaction actions remain the optional `MessageActions.react` from [17](17-capability-model.md).
Reply state is a selected parent message in the composer plus the parent's msgid on the outgoing
message; it is not a thread object.

## Engine and protocol boundaries

- Papo supplies live and historical `Reacted` values, `Feature::Reactions`, `Feature::Replies`,
  `Client::react`, `Client::unreact`, `Client::reply`, and `CHATHISTORY AROUND`.
- The engine aggregates additions/removals across history and live delivery, deduplicates overlap,
  projects actors and ownership, hides a channel reply's compatibility `"<parent nick>: "` prefix,
  and resolves or fetches reply parents. DMs never receive that prefix.
- The protocol sends complete reaction summaries in message projections and complete message
  updates after a reaction changes. Controls are projected only when their typed action exists;
  received reactions remain visible as non-interactive labels without capability.
- The UI lays chips under message text in the text column. Desktop hover shows who reacted. Later
  batches add chip toggling, toolbars, drawers, the phone sheet, sending state, and reply controls.

## Presentation decisions

Own reactions use the selection background and accent border. Chips wrap and keep first-seen order.
Desktop's floating row toolbar contains 👍 ❤️ 😂, add reaction, and Reply. Phone long-press opens a
sheet with 👍 ❤️ 😂 🎉 👀 ✅, add reaction, Reply, and Copy text. The full picker is searchable and
scrollable by category. We send emoji only, but render received text reactions as described above.

Replies show a one-line parent quote above the reply in the text column. Activating it scrolls to
and briefly highlights the parent; a missing parent is fetched around its msgid, and a deleted
parent says so. The composer bar says `Replying to <nick> <text>` and × or Escape cancels. Channels
prepend `<parent nick>: ` on the wire for plain IRC clients; our quote view hides that prefix.
There is no swipe-to-reply in the first version.

An optimistic own reaction appears immediately with a dashed border. Echo confirms it; failure
uses the error colour and activation retries. Without reaction/reply capability, the corresponding
control is absent rather than disabled.

## Testing

- Pure engine tests cover add, remove, duplicate and out-of-order replay, history/live overlap,
  account-tag disagreement, bounded reaction-before-message ordering, ownership after reconnect,
  and target cleanup with timeline and buffer lifetimes.
- Protocol/component tests cover ordered projections, ownership, text truncation/full tooltip,
  wrapping in the text column, and capability-absent labels.
- Playwright drives the built app against local Ergo with a second papo client: a received reaction
  appears without moving the live edge, survives reload through history, disappears on unreact,
  and stays gone after another reload. Every UI batch also runs the native-feel idle/hidden audit.

## Out of scope

Batch 1 does not send reactions, open pickers or phone sheets, or implement replies. Activity
indexing, redaction interactions, moderation, and reaction persistence outside server history are
later work.
