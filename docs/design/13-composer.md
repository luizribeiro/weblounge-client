# 13 — Composer

Status: proposed for milestone 2 implementation.

## Problem

The composer must feel local while keeping IRC parsing, target validation, completion ordering, and
send semantics in the engine. It must preserve text across navigation, remain safe during IME
composition, and expose failures without teaching the UI about IRC numerics or capabilities.

## Types

`SubmitInput { buffer_id, input }` parses ordinary text or a slash command into the typed
`Command` enum generated from the built-in declarations described in the catalog. Milestone 2
implements the catalog's M2 rows plus `close`, `cycle`, `query`, `notice`, and `help`; each variant
has validated typed fields. Parse failures are typed
`InputError { kind, command_name?, message_key }` results, including `UnknownCommand`, rather than
strings or attempted raw IRC.

The derive produces runtime `CommandSpec`s (name, aliases, typed arguments, usage, description,
requirements, surfaces, confirmation policy, and secret-argument policy) beside the parser and
typed AST. Parsing is ASCII case-insensitive, preserves rest-of-line text, applies the catalog's
current-target and comma-list conventions, treats `//text` and `/say text` as literal messages,
and never exposes a raw-command escape hatch. The runtime registry is open to later user-defined
specs even though only built-ins are executable now.

`CompleteInput { buffer_id, input, cursor, explicit }` returns a correlated `CompletionResult` with
a trigger, replace range, optional argument hint, and ordered typed candidates. `explicit` marks a
Tab request that may complete a nick outside the normal trigger positions. The engine recognizes
`/` only at message start and `@` or `#` only at word start. Command candidates come directly from
the runtime `CommandSpec` registry and carry name, usage, and description keys. Selecting a command
keeps its argument hint visible and uses the spec's argument kinds to offer people or channels.
People carry nick colour, away, and bot presentation; recent speakers precede a bounded member
window. Channels already joined precede a bounded set seen during this connection. Requirements
are projected before candidates leave the engine, so an unavailable command cannot be rendered.

IRC names match and deduplicate with papo's active server name rules, never UI locale casing.
Candidate collections stay bounded even in a 2,000-member channel. The UI applies the engine's
replace range locally: a picked mention loses `@`, becoming `nick: ` at message start and `nick`
inside a sentence, while an unpicked `@` remains literal. A picked channel retains `#`. Tab may
request nick completion at any token for the IRC convention; after a popup opens, Tab cycles its
current result without a worker round trip.

## Boundaries

The engine owns parsing, papo name validation, completion candidates and ordering, optimistic
sends, and execution through papo's typed APIs. `/msg` creates or reuses a DM buffer and sends
through its guarded `DirectTarget`; a conversation name is never treated as a send target. papo
owns splitting and `draft/multiline`, and `Sent` confirms every optimistic row.

The UI owns textarea geometry, the active completion session, focus, and per-buffer drafts. The
engine projects each draft key from the configured network identity and buffer name folded with
the server's active name rules; process-local buffer IDs never enter storage. Guarded
`sessionStorage` access caps each draft and the total draft collection, so buffer switches and tab
reloads survive while devices and unrelated tabs do not share unsent text. The UI removes a draft
only after submission is accepted and keeps it on typed rejection.

Enter submits, Shift+Enter inserts a newline, and the send button submits the same path. All
composer shortcuts ignore `isComposing`, key code 229, `Dead`, and `Process`; composition events
close suggestions. Up/Down, plus Ctrl+P/N on macOS, move the active suggestion; Tab or Enter
accepts; Escape closes without changing input. Enter sends only while the popup is closed. Mobile
textarea text is at least 16px. Up in an empty composer invokes
`message.select-last` from 14 and never copies a prior message into the draft.
Before projecting or sending a message, the engine collapses consecutive blank lines to at most
one empty line; papo receives that normalized text and owns its exact multiline framing.

The suggestion list is an unmounted overlay anchored immediately above the composer, so opening it
does not reflow messages. It is at most 420px wide and six density-sized rows on desktop; on mobile
it uses the composer width and at most 4.5 rows with 44pt minimum targets, visual-viewport keyboard
offsets, and safe areas. Rows use `Line`, theme/density/motion tokens, and single-line truncation.
The textarea is a combobox controlling a listbox with an active descendant and polite status; hover,
click, and touch share the keyboard selection model. The list owns overscroll and touch gestures so
scrolling candidates neither scrolls the page nor dismisses the software keyboard.

Server refusals, standard replies, and relevant numerics become typed command rejections rendered
as a notice beside the affected buffer's composer. UI code does not classify protocol lines.

## Testing

Parser tables cover every command, missing arguments, unknown commands, whitespace, and multiline
text. Scripted papo wire tests cover command lines, `Sent` confirmation, splitting, and correlated
standard-reply/numeric refusals. Completion tests cover command parsing, capability filtering,
activity order, casemapping, joined and seen channels, and bounded results with 2,000 members.
Component tests cover all three trigger boundaries, literal email addresses, mention insertion,
navigation and acceptance keys, replace ranges, storage failures and caps, stable-key reload drafts,
empty-Up, and IME. Playwright uses local Ergo in both shells for command, mention, and channel
suggestions; asserts overlay geometry and no message-list shift; captures light/dark desktop/mobile
screenshots; and keeps the native-feel idle/hidden audits green.

## Decisions

- Keep drafts UI-owned in `sessionStorage`; they are ephemeral input state, not IRC/domain state.
- Submit all input through the engine parser so ordinary text and slash commands share validation
  and acknowledgement behavior.
- Declare built-ins once and derive their parser, typed AST, specs, and completion metadata.
- Keep the runtime spec registry extensible for later user-defined commands and redact every input
  whose spec contains a secret argument.
- Open suggestions as a valid trigger is typed; keep Tab completion available anywhere.
- Return typed, bounded, capability-filtered candidates with engine-owned trigger and replace range.
- Rank recent speakers before bounded members and joined channels before session-seen channels.
- Insert IRC mentions without `@`, adding `: ` only when the mention begins the message.
- Render one token-driven listbox overlay shared by both shells without reflowing conversation rows.
- Surface server command failures as buffer notice rows with typed stable fields.
- Let papo own multiline framing and confirm optimistic output from `Sent`, never echo matching.
- Defer typing notifications; correct throttling and stop/idle transitions are not trivial.

## Later

Typing notifications, uploads, reply/edit affordances, command history, persisted/cross-device
drafts, user-defined commands, and slash commands beyond this milestone.

## Questions

- Should future durable drafts roam through an account service, or remain device-local storage?
- Should `/topic` with no text query the current topic once a topic-query projection is designed?
