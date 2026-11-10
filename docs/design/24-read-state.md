# 24 — Read state

Status: accepted for staged migration. Luiz approved decisions 1A–8A on 2026-11-07.

## 0. The invariant

For every conversation `c`:

```text
unread(c)   = { s ∈ c.stubs : s.time > c.mark }          // stubs never contain own messages
count(c)    = |unread(c)|, shown as "99+" when > 99 or when c.gap_until > c.mark
mentions(c) = |{ s ∈ unread(c) : s.mention }|             // 0 when muted
closed(n)   = n.conv = c ∧ n.time ≤ c.mark                 // OS notification close
```

Every stored fact merges with `max` or union-by-msgid, so arrival order, retries, other tabs and the
service worker cannot change the answer. Nothing in counting reads provenance (push, snapshot,
history, live) or lifecycle (`cached`, `HistoryState`, promotion).

This is what Telegram `read_inbox_max_id`, Discord `last_message_id`, Slack `last_read`, Matrix
receipts, and goguma, gamja and halloy converge on: one monotonic high-water mark per conversation;
counts are computed rather than stored beside a live count; and "no mark" means "read up to when
this device started following the conversation", applied at the same place as a server mark.

## 1. Problem and rejected alternatives

Unread and read state currently derive from server `MARKREAD`, an IndexedDB snapshot, push state,
history cursors, a JOIN floor and TARGETS. The answer can therefore depend on which source arrived
first. Two candidate designs agreed on one monotonic mark, persisted facts and pure derivation, but
left these gaps.

The server-first candidate set the floor at first TARGETS appearance or JOIN, which hides traffic
received while an always-on account was offline and recreates the pushed-channel regression. It did
not reset that floor after part and rejoin, fetched the oldest rather than newest page after a
cursor, did not cover the push/history millisecond straddle, left no service-worker owner for a
closed-page marker, and moved UI dwell state into the engine.

The pure-derivation candidate used account age for a direct-message floor and observed JOIN time for
a channel floor, so it could recreate whole-history unread and pushed-channel loss. It also made
the service worker a second writer of engine rows, made every TARGETS bump visibly inexact, retained
more stubs than the badge can display, and did not define how an own send moves the divider.

Both missed the network sync cursor as the correct "what this device has already received" anchor,
and neither restricted own-message advances to server-time-tagged echoes. Timestamp ties at a real
read mark are read because IRC markers have millisecond precision. A seed is an exclusive ingestion
boundary, so its preceding-millisecond representation keeps traffic received at the cursor's exact
millisecond unread. The service-worker snapshot must also carry server CASEMAPPING so every context
constructs the same conversation key.

## 2. Stored facts

`ConvKey` is `(network_id, casefold(target))`, using the server's CASEMAPPING. The engine exports it
for engine rows, snapshots, service-worker entries, notification tags and the app badge. It replaces
identity based on labels or lowercased display titles.

Each conversation has one snapshot row, which is the only instant-launch state:

| Fact | Type | Merge | Meaning |
|---|---|---|---|
| `mark` | `Option<ServerTimeMs>` | `max` | Read up to here. Raised by server reports, user reads, server-time-tagged own messages and the seed. |
| `pending` | `Option<ServerTimeMs>` | `max`; clear after a server report at or beyond it | A user or own-message advance that the server has not acknowledged. The seed never sets it. |
| `stubs` | at most 100 `{msgid, time, provisional_time?, mention}` values | union by msgid; authoritative history time replaces push time | The unread index. A reconciled stub retains its provisional push time until read, so carry survives eviction from the rendering timeline and restart. Own messages are never stubs. Drop entries at or before `mark` and keep the newest 100. |
| `gap_until` | `Option<ServerTimeMs>` | `max` | Messages after `mark` and before this time may be missing because a catch-up page was full or the cap evicted a stub. It is irrelevant once `mark >= gap_until`. |
| `latest` | `{msgid, time, preview}` | `max` by time | Chat-list preview, sort order and TARGETS comparison. It is not read state. |

Each network stores a monotonic `cursor: ServerTimeMs`: this device has every message for its
tracked conversations up to that time. The cursor advances only after catch-up deltas settle, then
on every live server-time-tagged line while connected. It replaces `last_sync` and
`synced_through`, and is also the TARGETS lower bound. The network stores CASEMAPPING beside it.

The service worker owns an append-only `push_log`, replacing the pushed-message store and
`NotificationState`. Entries are `{conv, kind: message {msgid, time, mention, body…} | mark {time}}`.
The engine folds entries into rows with the same merges and deletes them after the row is persisted.
The engine alone writes rows; the service worker alone writes the log; both may read both stores.

The 500-row rendering timeline and each pane's divider state remain memory-only and are never used
for counting.

### 2.1 Seed

When a device starts tracking a conversation by creating its row—the first JOIN, live, pushed or
TARGETS sighting, or a rejoin after PART deleted the old row—it applies:

```text
mark := max(mark, predecessor(network.cursor_at_that_moment))
```

`predecessor` is the preceding representable server-time millisecond. It encodes the seed as an
exclusive boundary while preserving the strict `message.time > mark` rule: a distinct message
ingested at the cursor's millisecond remains unread, while a real read mark at that millisecond is
inclusive.

On the very first connection, the cursor is "now". The seed replaces `local_unread_floor_ms`,
`restored_from_push` and the provenance-based floor bypass:

- A pushed message before IRC creates the row at the previous session's cursor, so the push remains
  unread. A later replayed JOIN with `*` finds the row and does nothing.
- A fresh account or newly joined channel seeds near JOIN, so older history is read.
- An offline gap in an unmarked channel occurs after the persisted mark and is unread.
- A stranger's offline direct message seeds at the last session cursor and is unread.
- A missing or evicted server marker cannot lower the persisted mark.
- A server marker older than the seed loses to the seed, regardless of whether marker retrieval or
  row creation happened first.

The seed is device-local and is never sent to the server because the read-marker specification
requires a real message time.

### 2.2 Ingest and advance

One ingest function handles live lines, history pages, push-log entries and restored snapshot rows:

1. Dedupe by msgid. An authoritative history or live time replaces a push time.
2. If the message is own and server-time-tagged, advance to its time. An optimistic row cannot move
   the mark.
3. Otherwise, if the message time is after the mark, add `{msgid, time, mention}`. The one Rust
   classifier marks every direct peer message as a mention and channel messages only when the own
   nick occurs as a word.
4. Reconciliation carries read forward: if the push copy was at or before the mark but its
   authoritative copy is later by at most one second, advance to the authoritative time. The pure
   fact merge follows chains of such replacements. This replaces deferred reads, survives restart
   and handles the push/history millisecond straddle without carrying a pathological mismatch far
   ahead.
5. Evicting the oldest stub past 100 raises `gap_until` to its time plus one.

`advance(c, t)` takes the maximum mark, takes the maximum pending value when the network supports
read markers, prunes covered stubs, persists the row immediately and schedules a flush. The dwell,
own messages, mark-all-read and reconcile-carries-read all use this one path. Message insertion does
not edit read state independently.

A server report from channel JOIN, a direct-message get, a live broadcast or a MARKREAD push takes
the maximum mark, clears pending when the report covers it, and prunes. A `*` report never lowers
local state. Re-sending an acknowledged real mark after server eviction is optional.

## 3. Derivations

- Count and mentions follow the invariant. Muting changes the projected mention count to zero but
  does not erase stub facts. Display `99+` when the exact count exceeds 99 or `gap_until > mark`.
- The OS app badge is the sum of direct-message unread counts and channel mention counts. Page and
  service worker derive it from the same rows plus push log.
- A notification is closed exactly when its conversation matches and its message time is at or
  before the mark. The page evaluates this after every mark change; the service worker evaluates it
  after appending a MARKREAD entry and before presenting a message push.
- One `BufferUpdated` projects `{unread, mentions, gap, mark, latest…}`. `UnreadChanged`,
  `ReadMarkerMoved` and `read_through` are removed during migration.
- A small TypeScript mirror of these functions is checked against shared JSON golden fixtures in
  Rust and Vitest. Pushed channel messages trust the relay's highlight decision; the engine
  reclassifies them on authoritative ingest.

## 4. App behavior

The engine renders snapshot rows through the same derivation and updates them in place. The cached
list mode, staged promotion events and optimistic cached-count zeroing go away.

One foreground signal—with visible iOS standalone applications treated as foreground—is shared by
the dwell, divider, push lease and snapshot flush. Each visible pane owns one dwell driven by
`visible ∧ live_edge ∧ foreground`. After 500 ms, and on every later arrival while reading, it
marks through the greatest held server time. The engine receives read commands, not viewport state.

Each pane owns one `divider_mark`. It is set to the current mark on open and own send. While reading
and no peer message follows it, it tracks the mark so watched arrivals never display `New`;
otherwise it is frozen. The divider renders before the first non-own message after it, or at the top
when the loaded window or `gap_until` starts later. Badge suppression covers every visible pane.

## 5. Launch sync

Channel markers arrive with JOIN. TARGETS begins at the network cursor. For each target whose latest
time exceeds the row's latest time, fetch `CHATHISTORY LATEST <target>
timestamp=max(mark, row.latest) 100`, retaining the newest 100 messages after the bound. A full page
sets `gap_until` to its oldest time. Unchanged targets keep their persisted stubs and need no fetch.

Fetch direct-message markers only for conversations that changed or still have stubs. Advance the
network cursor only after all scheduled deltas settle.

## 6. Edge cases

| Scenario | Result |
|---|---|
| Cold launch without a snapshot | Seeds use now; old history is read and later live traffic counts. |
| Snapshot plus a newer server marker | Maximum mark prunes stubs and lowers the badge. |
| Snapshot plus an older or unset server marker | The persisted mark remains. |
| Push followed by the same history msgid at another millisecond | History replaces push time; reconciliation carries an intervening read. |
| Read on another device while MARKREAD push is dropped | JOIN or direct marker retrieval raises the mark; foreground cleanup closes notifications and fixes the badge. |
| Read offline, then replace the hosted client | Pending stores stable time and identity; target resolution happens when flushing through the new client. |
| Live traffic overtakes catch-up | The dwell and mark both use the greatest server time. |
| TARGETS is capped, refused or loses a row | Existing facts remain; a capped page sets a gap and the cursor does not advance. |
| Fresh account in an unmarked channel | The seed makes pre-join history read and own lines are never stubs. |
| Unmarked channel push before reconnect JOIN | Push creates and seeds the row; the later JOIN cannot replace it. |
| Server marker before first history page | Mark and stubs are independent of the rendering window. |
| Own action on this or another device | The server-time-tagged own echo advances the mark and resets the divider. |
| Snapshot write failure or immediate page hide | Mark changes persist per row immediately and retry without a readiness gate. |
| Redelivered msgid or same notification tag after a read | Union by msgid prevents a duplicate; time comparison does not let an old mark close a newer message. |
| Relaunch during a delta | The cursor has not advanced, so the delta is fetched again. |
| More unread messages than the render window | Stubs, never timeline retention, determine the count. |
| Partial remote read inside a gap | Remaining known stubs count and the badge stays `99+` while the mark precedes `gap_until`. |
| Concurrent tab writers | Maximum and union merges converge. |
| Network without read-marker support | Pending remains unset; the local mark and all derivations behave identically. |
| Message tied with a real mark at millisecond precision | It is read; this is an IRC protocol limit. |
| Message tied with the cursor-derived seed | It is unread because the device ingested it after taking the seed. |

## 7. Boundaries and migration

The read model owns monotonic per-conversation facts, input merges and the pure count, mention,
divider, badge and notification-close derivations. History scheduling owns page selection and cursor
settlement. Papo owns MARKREAD encoding, capability support, server marker state and typed IRC
identity. The UI owns visibility, live-edge dwell and the frozen per-pane divider snapshot. Storage
owns transactional persistence, not read policy.

Migration is deliberately staged and each step must remain shippable:

1. Add unwired pure Rust facts, merges, derivations, order-independence property tests and shared
   JSON fixtures.
2. Persist and advance the network cursor, then use it as the TARGETS bound.
3. Seed new rows from the cursor and remove JOIN-floor and push-provenance exceptions.
4. Persist bounded stubs and gaps, derive counts, and discard schema-5 saved badge counts.
5. Use newest-page bounded catch-up and the changed-or-stubbed direct-marker rule.
6. Replace deferred reads with pending times, one advance path and reconcile-carries-read.
7. Persist each changed row immediately through an in-transaction merge.
8. Replace cached/live list promotion with one projected list and one `BufferUpdated` event.
9. Consolidate foreground state, per-pane dwell and the single-variable divider.
10. Move the service worker to `ConvKey`, `push_log`, the shared formula and one close predicate.
11. Rewrite the obsolete unread sections of design 05 and record completion in the plan.

The old unread implementation remains untouched until its corresponding migration step.

## 8. Testing

- Pure unit tests cover each merge and derivation, inclusive marker boundaries, muting, gap display,
  direct versus channel app-badge policy and notification conversation identity.
- Property tests permute equivalent push/history pairs, including a two-link carry chain, with live,
  server-marker, read and own-message inputs; every order must produce the same facts and
  projection. A second invariant checks that the count equals the number of known peer msgids whose
  authoritative time is after the mark.
- Shared JSON fixtures cover exact, capped, muted, direct-message, channel-mention, divider and
  notification-close projections in both Rust and the later TypeScript mirror.
- Later wiring steps retain the existing engine and Playwright bug scenarios for cross-device read,
  launch catch-up, push-before-JOIN, push/history straddles, Apple recovery, offline queued reads,
  per-pane dwell and frozen dividers.

## 9. Risks

- Reconcile-carries-read requires the relay to preserve msgid and exact time. Without msgid, a push
  time sent to the server can leave a one-millisecond straddle unread elsewhere.
- A new device intentionally treats pre-install direct-message history as read when the server has
  no marker, matching linked-device behavior but differing per device.
- The TypeScript formula can drift; shared golden fixtures are mandatory.
- IndexedDB rows have one engine writer per instance and merge commutatively across instances; the
  service worker writes only the push log.
- Mention classification is fixed at arrival and does not change after nick or rule changes.
- A gap's exact count is deliberately unknown and displayed as `99+` rather than fetching without
  bound.
- Users may notice the intended changes: offline traffic in unmarked channels counts, and those
  channels can display a `New` divider.
- Schema migration discards stored badge counts once, making the first changed-conversation launch
  slower while facts are rebuilt.

## Decisions

- 1A: Reading a push-only message advances the server marker immediately; authoritative reconciliation repairs a later time mismatch.
- 2A: A conversation with more unread messages than the bounded page displays `99+` instead of fetching everything or showing only a dot.
- 3A: When the server has no marker, history from before this device started following the conversation is read.
- 4A: The device-local seed is never sent to the server because it is not a real read of a real message.
- 5A: Messages missed while offline in an unmarked channel count as unread.
- 6A: A conversation currently being read never flashes its badge; tests that require the flash are removed when that step is wired.
- 7A: Launch tests enforce ceilings on round trips and time-to-usable rather than an exact command count.
- 8A: Schema migration drops old saved badge counts once and rebuilds facts instead of preserving old count logic.
