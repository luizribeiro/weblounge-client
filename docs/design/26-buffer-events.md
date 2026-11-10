# 26 — Buffer events

Status: proposed for review. The visual design is signed off (Luiz, 2026-11-09: every
recommendation on the [buffer events canvas](https://claude.ai/artifact/Y1sM7f13nKF52Lka6XaTsp)).
This document is the engineering design for implementing it.

## 1. Problem and scope

Papo types notices, server notices, membership, nick, mode, topic, invite, rename, redaction, MOTD
and standard replies, live and (where the server keeps them) in history. The engine drops most of
them. It keeps messages and membership runs in two parallel arrays that the UI merges and re-sorts
(`MessageList.tsx:1020-1083`), and it collapses membership by arrival order
(`state.rs:1323-1407`), so live, history and catch-up disagree.

This design gives every buffer one engine-ordered list of typed items, collapses runs only in the
engine with a pure function of that list, and renders four row families: message, notice, system
line, divider. It implements the insert-paths audit's Batch 2 (one ordered contract) and Batch 6
(system rows), and it schedules the parts of Batches 3 and 4 that `spacing-audit` does not
cover (§8).

Out of scope:

- deleting your own messages, reply-quote updates and reaction UI around redaction;
- replies, and message edits (papo has no edit API);
- "load missing messages" for a gap;
- your own user-mode changes;
- away, account, host, real-name, MONITOR and CTCP lines (presence or nothing, never rows);
- errors from your own commands (toasts, unchanged);
- durable timeline storage;
- any netsplit detection that papo does not provide.

## 2. Type model

### 2.1 Engine records (internal)

Each buffer owns one `Vec<TimelineRecord>` sorted by `order`. It replaces `timeline`,
`memberships` and `last_membership` (`state.rs:92-109`).

```rust
struct TimelineRecord {
    id: MessageId,                 // one id space for records and items (today's allocator)
    order: OrderKey,
    day: LocalDay,
    body: RecordBody,
}

enum RecordBody {
    Chat(ChatRecord),              // today's TimelineRecord fields, unchanged
    Fold(FoldEvent),               // collapses into runs
    Line(LineEvent),               // stands alone; breaks runs
    Gap(GapProjection),
}

enum FoldEvent {
    Joined(Who),
    Parted(Who, Option<String>),
    Quit(Who, Option<String>, Option<SplitServers>),  // papo's Quit::netsplit
    Nick { old: Who, new: Who },
    Modes { actor: ActorRecord, changes: Vec<ModeRecord> },
    Invited { actor: ActorRecord, subject: Who },     // subject is someone else
}

struct Who {
    nick: String,                  // display nick from papo
    own: bool,                     // papo authorship
    msgid: Option<String>,
}
```

Projection derives `me` and the nick colour from `Who`.

- `OrderKey` is today's `(primary_ms, received_ms, sequence)` (`state.rs:3492`). `primary_ms` is
  server time for papo events. For engine-local lines it is an anchor (§5): a phone's clock never
  orders them against server-time rows.
- `LocalDay(i32)` counts local-calendar days since 1970-01-01 at `primary_ms`. TypeScript receives
  it as `number`.

### 2.2 Projection (protocol)

The types live in `crates/engine/src/timeline/projection.rs`, are re-exported by `protocol.rs`,
and are generated with `ts-rs`.

```rust
pub struct TimelineItem {
    pub id: MessageId,
    pub order: OrderKey,           // [number, number, number]; the UI compares, never computes
    pub day: LocalDay,
    pub content_version: u32,      // +1 when this id's content changes; not design 02's Revision
    pub body: ItemBody,
}

#[serde(tag = "family", rename_all = "snake_case")]
pub enum ItemBody {
    Message(MessageProjection),    // PRIVMSG, ACTION, NOTICE, tombstone
    System(SystemProjection),
    Gap(GapProjection),
}

pub struct SystemProjection { pub time_ms: i64, pub line: SystemLine } // newest member's time

#[serde(tag = "type", rename_all = "snake_case")]
pub enum SystemLine {
    Run { clauses: Vec<RunClause> },   // non-empty
    Event { event: LineEvent },
    // Netsplit and NetsplitOver are added by batch 10 only (§3.4).
}

#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunClause {
    Joined { people: Vec<Person> },
    JoinedAndLeft { people: Vec<Person> },
    Left { people: Vec<Departure> },
    Quit { people: Vec<Departure> },
    Reconnected { people: Vec<Person> },   // quit, then joined
    Rejoined { people: Vec<Person> },      // parted, then joined
    Nick { changes: Vec<NickChange> },
    Modes { actor: Actor, changes: Vec<ModeProjection> },
    Invited { actor: Actor, people: Vec<Person> },
}

#[serde(tag = "type", rename_all = "snake_case")]
pub enum LineEvent {
    Kick { actor: Actor, subject: Subject, reason: Option<String> },
    Topic { actor: Actor, topic: Option<String> },     // None: cleared
    TopicCard { topic: String, setter: Option<String>, set_at_ms: Option<i64> },
    InvitedYou { actor: Actor, channel: String },
    Renamed { old: String, new: String, actor: Actor },
    Connected { server: String, secure: bool },
    Motd { lines: Vec<String> },
    Reply { code: String, text: String, severity: ReplySeverity },  // FAIL / WARN / NOTE
    Raw { line: String },                                           // papo Event::Other
    Note { key: EngineMessageKey, values: BTreeMap<String, String>, tone: NoticeTone },
}

pub struct Person { pub nick: String, pub nick_color_index: u32, pub me: bool }
pub struct Departure { pub person: Person, pub reason: Option<String> }
pub struct NickChange { pub old: Person, pub new: Person }
pub enum Actor { User(Person), Server { name: String } }    // services are users
pub enum Subject { You, Other(Person) }
pub struct GapProjection { pub from_ms: i64, pub to_ms: i64 }

pub struct ModeProjection { pub added: bool, pub meaning: ModeMeaning, pub raw: String }
pub enum ModeMeaning {                                       // raw: the desktop suffix for every mode
    Rank { rank: MemberRank, member: Person },               // papo ModeArg::Member + PREFIX
    Ban { mask: String }, BanException { mask: String },
    InviteException { mask: String }, Quiet { mask: String },
    Moderated, TopicLocked, NoExternal, InviteOnly, Secret, Private,
    Key,                                                     // the key is never projected
    Limit { limit: Option<String> },
    Other,                                                   // words fall back to `raw`
}
```

`MessageProjection` changes, each in its own batch (§8):

- `id` moves to `TimelineItem.id`.
- `kind` becomes `Text | Action | Notice(NoticeSource)`, with
  `NoticeSource = User | Service | Server`. This extends `irc-notice`'s `IrcNotice`. Local
  `Notice(NoticeKind)` is removed: those rows become `LineEvent::Note` or `TopicCard`.
- `text` and `reactions` become `content: MessageContent`, which is `Text { text, reactions }` or
  `Deleted { by: Option<String> }`. `by` is set only when someone other than the author deleted the
  message, so a tombstone cannot carry text or reactions.

Tone is never a field. `Kick { subject: You }`, `Reply { severity: Fail }` and
`Note { tone: Error }` warn, and everything else is neutral. A server notice's muted name follows
from `NoticeSource::Server`.

### 2.3 The patch

```rust
EngineToUi::TimelineChanged {
    buffer_id: BufferId,
    reset: bool,                   // true only when a shell attaches to a running engine
    upserted: Vec<TimelineItem>,   // in order
    removed: Vec<MessageId>,
}
```

It replaces `MessagesAppended`, `MessageUpdated`, `MessagesPrepended`, the rows of
`BufferSnapshot`, `MembershipChanged`, `MessageConfirmed` and `MessageRetrying`
(`protocol.rs:1185-1278`). `MessageFailed` stays only for its toast. Design 02's
`TimelinePrepended`/`TimelineAppended`/`TimelineEntriesUpserted`/`TimelineEntriesRemoved` are
superseded by this one patch. Upserts and removals must apply atomically, and append versus
prepend is derivable. Batch 1b updates design 02's sketch in the same commit.

**Reducer.** `app/src/engine/timeline-store.ts` is pure.

- With `reset`, it replaces the buffer's list. A shell attach starts with empty panes, so nothing
  retained is lost.
- Otherwise it drops the `removed` ids, then upserts each item. An id with an unchanged `order` is
  replaced in place; any other item is removed and binary-inserted by `order`.
- It returns a geometry class derived from the diff: `suffix` (every insert sorts after the old
  last row and nothing earlier changed), `prefix`, `in-place` (same rows, some replaced) or
  `mixed`.

`MessageList` receives ordered items and never sorts.

- A `suffix` class takes the virtualizer's append path. Every other class takes `spacing-audit`'s
  anchor-preserving remeasure.
- The jump button counts new peer Message-family items in a `suffix` insert while the reader is
  away from the live edge. That covers live arrivals and messages that are genuinely new from
  catch-up. Older pages (`prefix`), updates and own rows never count.
- `EngineClient` keeps flushing immediately when an upsert carries an optimistic row
  (`EngineClient.ts:303-345`).

### 2.4 Invariants

- The engine's record vector is the only source of order.
- Items are a pure function of the records (§3). The only path-dependent fields are ids,
  `content_version` and receipt times, plus the exemptions in §3.5.
- Read, preview, stub and mark-read code considers only `Chat` records. The one exception is the
  invite to you (§4).

## 3. Collapsing (engine only)

### 3.1 Classes and breaks

| Record | Class |
|---|---|
| `Fold` (join, part, quit, nick, modes, invite of someone else) | joins the open run |
| `Chat` (message, action, notice, tombstone, optimistic or failed send) | breaks |
| `Line` (kick, topic, topic card, invite to you, rename, connected, MOTD, reply, raw, note), `Gap` | breaks |
| a change of `day` | breaks |

There is no time window; the desktop time column shows the newest member's time.

The New divider never needs to break a run. Design 24 places it before a chat item, and chat items
already end runs.

`LocalCalendar` (`fn day(&self, unix_ms: i64) -> LocalDay`) is a platform service. `engine-wasm`
implements it with `js_sys::Date`, so it shares the device time zone with pages. Native Tauri will
use the OS local offset when that shell lands. Tests use a fixed offset. A time-zone change takes
effect at the next engine start.

### 3.2 One fold per turn

`timeline::fold(&[TimelineRecord]) -> Vec<FoldedItem>` walks the sorted records once. A breaker
closes the open run and becomes its own item. A `Fold` event joins the open run on the same day or
opens a new run.

The engine marks touched buffers dirty during a turn: all papo events ready without awaiting, one
history page, or one command. Before it flushes the turn's output, it folds each dirty buffer once
and diffs by id plus content against the items it last emitted. A netsplit's or history page's
hundreds of events therefore cost one fold and one patch. A run's full people lists are sent,
because the expanded view needs them; the turn bound keeps that linear.

### 3.3 Inside a run

Members are ordered by `(primary_ms, msgid)`, so the order does not depend on the path. Each
person, keyed by casemapped nick at the time of the event (renames are not followed), gets one
clause from their first and last membership event in the run:

| First \ last | join | part | quit |
|---|---|---|---|
| **join** | `Joined` | `JoinedAndLeft` | `JoinedAndLeft` |
| **part** | `Rejoined` | `Left` (last reason) | `Quit` (last reason) |
| **quit** | `Reconnected` | `Left` (last reason) | `Quit` (last reason) |

So join, part, join reads `Joined`.

- Nick changes chain: a→b→c becomes a→c, and a→b→a disappears.
- `Modes` and `Invited` have one clause per actor. An actor sequence A, B, A gives two clauses,
  with A's changes in order and no cancelling.
- A clause sits at the position of its first member. Emptied clauses disappear, and a run with no
  clauses emits no item.

Wording stays in the UI: three names, then an "N others" button, and a reason only when the clause
has one person (§6).

### 3.4 Netsplits: papo's flag only

There is no heuristic anywhere. A quit with `Quit::netsplit` (from a server `netsplit` BATCH) is a
split quit; every other mass quit is an ordinary `Quit` clause. In batch 10:

- consecutive split quits with the same `SplitServers` on the same day fold into
  `SystemLine::Netsplit { servers, people }`, which breaks runs;
- consecutive joins carrying `Joined::netjoin` for the same servers fold into
  `NetsplitOver { rejoined, of }`, where `of` is that split's size.

Papo sets both flags only live, so history renders the same events as ordinary quit and join
runs. Luiz accepted this difference (2026-11-09). The variants are not added before batch 10.

### 3.5 Ids, eviction and parity

**Run id = the smallest member record id.**

- New records always get larger ids, so growth at either end, including out-of-order history
  joining the front of a run, never changes the id.
- A chat record landing inside a run splits it. The part holding the smallest id keeps it, and the
  other part is a new item with its own smallest id. It mounts fresh, collapsed.
- A confirmation that moves the only breaker between two runs merges them. The patch upserts the
  survivor and removes the other id.

**Eviction cuts a prefix at an item boundary.** Each buffer keeps today's two budgets
(`state.rs:3026`, `:1369`): at most `window_limit` chat records and at most `window_limit` system
items. A join flood is one item, so it cannot evict chat history.

- When either budget is exceeded, the engine removes whole leading items until both fit. No run
  loses part of its members, so no surviving id changes.
- The diff and the patch are computed before eviction. Eviction then emits nothing, so an older
  page beyond the window still reaches the UI, which retains the rows (design 05).
- Dedup references are released as today, and the audit's Batch 5 owns that lifetime.

**Dedup.** Chat keeps the network-global msgid map. System records use a separate set keyed by
`(BufferId, msgid)`, because one QUIT or NICK fans out to several buffers with one msgid. They
never register reaction targets (`release_dedup`, `state.rs:3037`). Without a msgid, the key is
`(BufferId, server_time, kind, nick, subject)`. Events without server time are never deduped.

**Parity.** Every ingest path calls one function per papo event type (`timeline/ingest.rs`). The
parity property (§7) covers what history can carry: messages, notices, joins, parts, quits, nick
changes in channels and channel modes by others, kicks of others, and topic changes. It exempts:

- split quits and netjoins (§3.4);
- items with no history twin: your own nick fan-out, your own kick, `InvitedYou`, invites of
  others, `AutoJoinFailed`, `Connected`, `Motd`, `Reply`, `Raw`, notes, topic cards and gaps;
- chat and system records tied at the same millisecond, which keep arrival order.

## 4. Routing and unread

| Event | Buffer | Unread |
|---|---|---|
| `Message` | channel or DM (unchanged) | unchanged |
| `Notice` to a channel | channel | like a message, highlight included |
| `Notice` from a person, private | their DM thread (the `irc-notice` rule) | like a DM message |
| `Notice` from a proven service | server buffer, never a DM | server-buffer rule |
| `ServerNotice` (`Me`, `Broadcast`, WALLOPS) | server buffer; `Audience::Channel` goes to the channel | server-buffer rule; in a channel, like a notice |
| `Joined`/`Parted` (others) | channel | never |
| own `Joined`/`Parted` | no row; a join may add the topic card (§5); a part removes the buffer (unchanged) | — |
| `Quit` | each channel in `channels` | never |
| `Kicked` | channel; warning when the subject is you (status `Kicked`, unchanged) | never |
| `NickChanged` (others) | each channel in `channels`, plus the old-nick DM thread when its pin matches (replaces `note_direct_rename`, `state.rs:889`) | never |
| `NickChanged` (own) | server buffer and each channel in `channels` | never |
| `ModeChanged`, channel subject | channel (user subject: not shown) | never |
| `TopicChanged` | channel | never |
| `Invited`, you | server buffer, with a Join action | one stub, like a server-buffer notice |
| `Invited`, someone else | that channel, when we have it | never |
| `ChannelRenamed` | the renamed buffer | never |
| `Redacted` | the target's buffer, which becomes a tombstone (§5) | read facts unchanged |
| `AutoJoinFailed` | that channel's buffer, else the server buffer (warning `Note`) | never |
| `Connected`, `Motd`, unsolicited `StandardReply`, `Other` | server buffer | never |
| catch-up shortfall, `Lagged` gap | the affected conversation | never (counts keep `gap_until`) |
| DM identity mismatch or restore | that DM (`Note`) | never |

The server-buffer rule is unchanged: a row adds a stub to the server buffer's own row and never to
the app badge (`irc-notice`). The invite to you is the only system item with a stub, because the
canvas shows it unread. It uses its msgid, or a `local:` id. System lines are never highlighted.

## 5. Engine state additions

**Anchors for local lines.** Engine-local lines (notes, cards, `Connected`, `Motd`) take
`primary_ms` from server time, never from the device clock:

- by default, the greatest primary time already in the buffer or the network cursor, whichever is
  later, so they sort after everything already present;
- the topic card uses its own JOIN's order key;
- an identity note uses the primary time of the row before the first mismatched row, so its larger
  sequence sorts it between them;
- with no server time known, they fall back to receipt time.

`day` follows `primary_ms`.

**Topic card on join only.** A channel buffer holds `topic_card: Option<OrderKey>`. An own
`Joined` sets it only when the join creates the buffer or ends a `Kicked` status.

- A reconnect rejoin finds the buffer already `Joined`, since a disconnect is not a departure.
  Buffers restored from the chat-list snapshot also count as existing. Neither gets a card.
- On `ChannelSynced`, a pending card becomes a `TopicCard` record when `Channel::topic()` is
  non-empty, with `topic_set_by` and `topic_set_at`. The field then clears.
- `/topic` without text inserts a card at once, replacing `append_notice(NoticeKind::Topic)`
  (`runtime.rs:1857`).

**Gap ("Messages may be missing").** `record_gap(buffer, from_ms, to_ms)` is the one entry point.
It merges into any gap in the buffer that overlaps or touches the span; otherwise it inserts a
`Gap` record anchored at `from_ms`. It also calls `read_facts.merge_gap_until(to_ms)`, so a lagged
event followed by a reconnect yields one marker and one badge fact. It runs when:

1. a launch or reconnect catch-up page ends with `end == false` (today's `completion.gap`,
   `state.rs:1766-1773`). The span runs from the previous newest cursor to the page's oldest
   time. This replaces `append_history_gap` (`state.rs:1156`).
2. `Lagged` reports a `MessageGap`, and the refetched latest page does not reach
   `first_server_time`.
3. the network reconnects without CHATHISTORY, or catch-up fails. Each joined channel, and each DM
   with rows, gets a gap from the disconnect to `Connected`.

A filled gap makes no row. A gap clears when a later page's range covers it (in v1, only an older
page reaching a gap at the top), and it leaves with eviction, PART or close. The marker is
memory-only. After a relaunch the transcript restarts from history, and only a new shortfall
records a marker. A persisted `gap_until` keeps driving `99+` (design 24) but never recreates the
row.

**Tombstone.** `Redacted`, live or from history, finds its target through the msgid map
(`state.rs:2785`).

- It sets `content = Deleted { by }` and drops the target's reaction facts. The row keeps its id,
  order, author and time.
- A redaction that arrives before its message waits in the bounded target index used by reactions
  (design 25).
- The deleted text is removed everywhere. If the row is `latest`, the chat-list preview and the
  persisted snapshot row become "Message deleted". The page closes any OS notification tagged with
  that msgid, and the push-log entry's body is dropped. Stubs carry no text and stay.
- If the server omits redacted messages from later history, the tombstone lives only while the row
  is retained. The Playwright test records Ergo's behaviour.

**Identity notes.** `record_direct_mismatch` (`state.rs:2279`) inserts
`Note(identity_changed, Error)`. The first verified row after a mismatch, or "Trust new identity",
inserts `Note(identity_restored)`. The banner and read-only composer stay as in design 01.

## 6. UI

### Families

`timeline-rows.ts` derives display rows from the ordered items:

- day dividers from `item.day`, replacing `MessageList`'s `Date`-derived days;
- the New divider (design 24);
- `spacing-audit`'s history start and loading row;
- the empty-buffer row;
- each row's predecessor family and phone group start.

`familyOf(item)` is the only mapping from item to family:

| Item | Family | Component (`features/conversation/timeline/`) |
|---|---|---|
| `Message` with `Text` or `Action`, tombstones included | Message | `MessageRow.tsx` (moved) |
| `Message` with `Notice(_)` | Notice | `NoticeRow.tsx` |
| `System` | System line | `SystemLine.tsx`; `SystemCard.tsx` for `TopicCard` and `Motd` |
| `Gap`, day, New, history start or loading, empty | Divider | `Divider.tsx` |

`system-line-words.ts` turns a `SystemLine` into typed segments (text, nick, mono, button) in the
canvas wording ("gave op to", "took voice from", "banned", "lifted the ban on", "made the channel
moderated", "set a key"). It never includes a key. The same segments produce the rendered line, the
copy text (`copy-rows.ts`), the accessible name and the size estimate.

- **Runs:** clauses are joined by " · ", each with three names, then "N others". Expanding is
  per-pane state keyed by item id. It shows "N people joined · Show less" and one line per person,
  4 px apart, with reasons.
- **Buttons:** Rejoin on the newest `Kick { You }` while the buffer is `Kicked`, and Join on
  `InvitedYou`.
- **MOTD:** four monospace lines, then "Show all N lines".
- **Start caption:** "Server history starts {date}", from the oldest loaded item's day; omitted when
  there are no items.
- **Gap label:** "Messages may be missing · {from} to {to}".

### Phone and desktop

| | Phone | Desktop |
|---|---|---|
| System line | 16 px icon, 10 px gap, 14/20 muted text, nicks 600 in nick colour; **no time** | grid `6ch 120px 1fr auto`; time = `time_ms`; 15 px icon right-aligned in the nick column; 13/21 text; modes add `raw`, muted 11.5 px mono |
| Notice | megaphone (user or service) or server stack; sender 650; 14/20 `fg`; time 12 muted at the end | icon and sender in the nick column; a server name is muted and truncated |
| Card | `panel-alt` box, `panel-border`, 10/12 padding | same, in the text column |
| Divider | lines 11/650; start, loading and empty centred 13/600, 12 caption, 18 px icon | same |

### Spacing

`spacing-audit`'s table stays the contract: one owner per row, padding from density tokens, never
margins, and the jump control is an overlay. The signed canvas replaces two of its rows (cozy
values):

| Row or transition | Phone | Desktop | Owner |
|---|---|---|---|
| Line row (system, notice, card) after a message or card | 12 px above | 3/3 px | line row top padding, chosen by predecessor |
| Line row after a line row | 4 px above | 3/3 px | the same |
| Any row after a divider | 0 above | 0 above | the divider owns both sides |
| Divider (day, New, gap, history, empty) | 20/8 px | 14/6 px | divider top/bottom padding |

Message rows, highlight-band splitting (notices use it), the first and last row and typing are
unchanged. `row-spacing.ts` exports the single `topPadding(previousFamily, row, presentation)`
used by CSS (as `data-spacing`) and by the estimate.

Batch 3 adds these tokens to `app/densities/presets.json` (compact / cozy / comfortable):

| Token | Compact | Cozy | Comfortable |
|---|---|---|---|
| `mobileLineTopPadding` | 8 | 12 | 16 |
| `mobileLineGapPadding` | 2 | 4 | 6 |
| `mobileDividerTopPadding` | 16 | 20 | 24 |
| `mobileDividerBottomPadding` | 6 | 8 | 10 |
| `dividerTopPadding` | 10 | 14 | 18 |
| `dividerBottomPadding` | 4 | 6 | 8 |

No colour tokens are added.

### Estimate, measurement, accessibility

`item-size-estimate.ts` dispatches on family:

- a system line is `ceil(segment length / characters per line) × 20` plus its top padding;
- a card is its header, its wrapped lines (MOTD folded to four) and its button;
- a divider is its top and bottom padding plus 18.

The size revision is `(id, content_version, expanded, previousFamily, groupStart, presentation)`.
Rows wrap and never have a fixed height.

- Icons are fixed Lucide SVGs in `app/src/ui/icons/`, rendered through one `EventIcon`. They are
  `aria-hidden` because the words carry the meaning. The exceptions are the labelled warning
  ("Warning"), notice ("Notice", "Server notice") and unverified icons; the shield is always
  followed by the word "Unverified".
- Expanders use `aria-expanded` and "Show N others". Dividers use `role="separator"`. Tombstones
  read "Message deleted" or "Deleted by {nick}".
- Nothing is carried by colour alone.

## 7. Testing

**Engine unit tests** use `timeline/*`, the ingest functions and `papo_testing::wire()`:

- §4, row by row, live and from history.
- The canvas "Collapsing" scenarios 1–8 and 10 (9 is batch 10).
- Every cell of §3.3's table.
- A–B–A modes and nick chains.
- Day breaks with a fixed-offset calendar.
- One QUIT on #a and #b gives a row in both; one NICK fans out to channels and the DM.
- Budgets: a join flood never evicts chat.
- Topic card: first join, rejoin after kick, reconnect, snapshot restore, `/topic`.
- Gap: each trigger, the lagged-then-reconnect merge, clearing, and a filled reconnect giving none.
- Tombstone: live, history, early redaction, another user's redaction, preview rewrite.

**Properties** (`proptest`). Each run generates events with distinct server times and msgids,
within the §3.5 parity set, and delivers them through each of:

- (a) live, in order;
- (b) one shuffled history page;
- (c) random latest, older and catch-up pages, in random order and overlapping;
- (d) live interleaved with duplicate history;
- (e) any of the above under a small window that forces eviction.

The properties are:

1. **Same rows:** (a)–(d) are equal after normalising (drop ids, `content_version`,
   `received_ms`, `sequence`; map run ids to their index).
2. **Mirror:** applying every emitted patch to the Rust mirror of the TS reducer equals the
   engine's items plus the evicted items the UI retains, with equal `content_version`.
3. **Stable ids:** across (a)–(e), every surviving item id still names the item holding its
   smallest record. No record belongs to two items in the mirror. Growth at either end, older
   history and eviction never change a surviving id, and only splits and merges create or remove
   one.

**Shared fixtures.** `fixtures/timeline/*.json` (beside `fixtures/read-state/`) drive the Rust
mirror and Vitest for `applyTimelineChange`. They cover in-place update, reorder, removal, reset
and every geometry class.

**Component tests** cover:

- `system-line-words` for every variant;
- three names and the expander;
- no time on phone, raw modes on desktop;
- `familyOf`;
- `topPadding` for every family pair;
- estimates per family.

**Playwright** runs the built app against the flake's Ergo, with a second client from
`irc-client.ts`, on desktop Chromium and iPhone WebKit. `nativeFeelAudit` idle and hidden checks
stay green.

- Live events from the second client, which is channel founder and therefore op: join, part,
  quit, nick, voice, `+m`, topic set and clear, a kick of a third client, an invite, channel and DM
  notices, and a redaction (Ergo supports `draft/message-redaction`). `/ns info` produces service
  notices, and `max-channels-per-client = 8` produces the limit note.
- Row text is asserted live, then compared after a reload (history), in a second tab (reset) and
  after stranding the socket during the events (catch-up), within the parity set.
- Gap: strand the socket with `socket-forwarder.mjs`, send more than a catch-up page and resume, and
  a dashed line appears. With fewer messages, none appears.
- Netsplits, server notices, WALLOPS, MOTD and `FAIL` need a forwarder `/inject` endpoint. It
  writes a raw IRC line to the client as an unmasked WebSocket text frame. Ergo cannot produce
  netsplits.
- Geometry checks the spacing table's gaps, wrapping of a long run, expand and collapse without
  moving an away anchor, and a run growing at the live edge without a jump.

## 8. Build plan (codex batches)

Each item is a few commits under ~100 lines, and tests ship in the same commit. Start after
`irc-notice` and `spacing-audit` are on main. `spacing-audit` delivers the anchor-preserving
remeasure for non-suffix changes and delivery state in the estimate; this plan consumes both and
reimplements neither. Every UI batch runs its touched Playwright specs, including `notices.spec.ts`
and `spacing-audit.spec.ts`.

**1a. Pure timeline module** (no wiring): `OrderKey`, `LocalDay`, `TimelineItem`, the fold (each
membership record is a standalone line, with no collapse yet), the diff, and the Rust mirror of the
reducer. Adds the shared fixtures and properties 2–3.

**1b. Engine record vector.** One `Vec<TimelineRecord>` with the two budgets of §3.5. Emit
`TimelineChanged` once per turn alongside the old events. A parity test shows the old and new
streams produce the same ordered rows. Update design 02's timeline patches.

**1c. App reads ordered items.** `timeline-store.ts` and `MessageList` consume `TimelineChanged`,
with no sort or merge. The geometry class picks the append path or the anchored remeasure, and the
jump counter follows §2.3. The old events still flow. Playwright covers:

- out-of-order server times and an optimistic confirmation that moves, with DOM order equal to
  engine order;
- while away from the live edge, an older page, an own send and a catch-up each change the jump
  count only by their new peer rows.

**1d. Delete the old events.** Regenerate TypeScript and migrate the tests:

- the `BufferSnapshot` matchers and helpers in `runtime.rs` (about lines 5706, 6874, 6966, 8651
  and 12284–12312);
- `crates/engine/tests/ergo.rs`;
- `App.test.tsx`, `EngineClient.test.ts`, `worker-runtime.test.ts` and `native-feel-audit.ts`.

**2. Day and dedup** (engine).

1. `LocalCalendar` and `day` on items. Runs break at day changes, and `timeline-rows.ts` takes days
   from `item.day`, replacing `MessageList`'s `Date`-derived dividers.
2. System dedup by `(BufferId, msgid)`; history `Kicked` and reasons are kept. Test: live plus
   catch-up overlap gives one run, and one QUIT gives two channels a row each.

**3. System-line family with nick and mode.**

1. The real fold and `RunClause` (§3.3), with `system-line-words.ts`, `SystemLine.tsx`,
   `EventIcon`, the density tokens, `row-spacing.ts`, the estimate, the expander, and the
   own-kick warning plus Rejoin.
2. Nick changes routed per §4.
3. Channel modes with `ModeMeaning`, and the desktop raw suffix.

Test: `system-lines.spec.ts`.

**4. Notice family.** `NoticeSource`, `ServerNotice` and WALLOPS, `NoticeRow`, and the forwarder
`/inject`. Test: extend `notices.spec.ts`.

**5. Channel events.** Kicks of others, topic changes, and topic cards on join and `/topic`. Test:
`system-lines.spec.ts`, including no card on reconnect.

**6. Invites, rename, notes.** `InvitedYou` (server buffer, stub, Join), invites of others, the
rename line, and engine notes as `LineEvent::Note` (version, channel limit, rejoin failed).
Removes `MessageKind::Notice(NoticeKind)`.

**7. Gap and dividers.** `record_gap` per §5, and `Divider.tsx` with the gap, history caption,
loading and empty rows. Test: `transcript-gaps.spec.ts`.

**8. Message family.** `MessageContent` with tombstones and the preview, notification and push-log
scrub; the shield plus "Unverified"; "Not sent · Retry". Test: `tombstones.spec.ts`.

**9. Server buffer and identity notes.** `Connected`, the MOTD card, `Reply`, `Raw` (bounded as
design 01's diagnostics window), the DM identity notes and the local-line anchors of §5. Test:
`server-buffer.spec.ts` with `/inject`.

**10. Netsplit** (papo's flags only). The `Netsplit` and `NetsplitOver` variants with their fold
and Show list. Test: fold scenario 9 and an `/inject` `netsplit` and `netjoin` BATCH journey.

**11. Cut-off multiline**, after the planned papo bump that adds `Event::Incomplete`. A message
flag reading "The rest of this message never arrived", never a mention.

**12. Send-path correctness** (the audit's Batch 4, items 2–3).

1. Gate the own read advance on a real server time, and model papo `Unconfirmed` apart from
   `Confirmed`.
2. Reconcile identical failed own sends FIFO.

Playwright: on a server without echo/labels, the mark never moves to a receipt time, and two
identical failed sends retried reach the intended rows.

**Order and parallelism:**

- 1a → 1b → 1c → 1d → 2 → 3 must run in sequence, then everything else.
- After 3, batches 4, 7 and 8 can run in parallel. They touch different functions and components.
  Their shared edits are added variants in `projection.rs` and `protocol.rs`: keep both sides on
  rebase, then regenerate the TypeScript.
- 5 → 6 → 9 run in sequence, since each adds `LineEvent` variants, dispatch arms and words.
- 10 runs in parallel with 7 and 8. 12 depends only on 1d and runs in parallel with everything
  after it.

## 9. Open questions

None.

## Decisions

- Luiz, 2026-11-09: netsplits use only papo's `Quit::netsplit` / `Joined::netjoin`. There is no
  reason parsing anywhere. History may then show an ordinary quit run where live showed a netsplit
  line, and the parity property exempts it.
- One engine-ordered item list and one `TimelineChanged` patch per buffer. The UI never sorts, and
  it derives geometry and the unseen count from the diff.
- Collapse is a pure engine fold, run once per turn. A run's id is its smallest record id.
  Eviction cuts whole leading items, silently, after the patch is computed, with separate chat and
  system budgets.
- A day change breaks a run; there is no time window. Engine-local lines are anchored to server
  time.
- Your own JOIN and PART make no line. The topic card is shown for a real join only.
- Your own nick change appears in the server buffer and every shared channel.
- The invite to you is the one system item with an unread stub.
- Redaction removes the deleted text everywhere and leaves read facts unchanged.
- The canvas's line-row spacing (12/4) remains, except after dividers where the row adds no top
  padding. Divider spacing is asymmetric (20/8 on phone, 14/6 on desktop), with the same
  token-padding ownership.
