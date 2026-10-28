# 13 — Composer

Status: proposed for milestone 2 implementation.

## Problem

The composer must feel local while keeping IRC parsing, target validation, completion ordering, and
send semantics in the engine. It must preserve text across navigation, remain safe during IME
composition, and expose failures without teaching the UI about IRC numerics or capabilities.

## Types

`SubmitInput { buffer_id, input }` parses ordinary text or a slash command into a closed
`ParsedInput` union. Milestone 2 supports `Message`, `Me`, `Join`, `Part`, `Msg`, `Nick`, `Topic`,
and `Quit`; each command has validated, nonempty fields. Parse failures are typed
`InputError { kind, command_id?, message_key }` results, including `UnknownCommand`, rather than
strings or attempted raw IRC.

Slash descriptors use command-registry IDs from 14 where semantics match: `/join` is
`buffer.open`, `/part` is `channel.part`, and `/quit` is `network.disconnect`. The other four use
engine descriptor IDs until registry actions exist. Parsing is ASCII case-insensitive, preserves
message/reason text after required arguments, and never exposes a raw-command escape hatch.

`CompleteInput { buffer_id, input, cursor }` returns a replace range and ordered
`CompletionCandidate { kind, value, suffix }` values. Candidates are commands at a leading slash,
channels for channel-shaped tokens, and channel nicks otherwise. Nicks are ordered by most recent
message activity, then papo casemapping; channels and commands use the same name rules and stable
lexical order. The UI requests candidates only when a completion session starts or its token
changes, caches that result for Tab cycling, and applies selection locally, avoiding a worker
round trip for every cycle or paint.

## Boundaries

The engine owns parsing, papo name validation, completion candidates and ordering, optimistic
sends, and execution through papo's typed APIs. `/msg` creates or reuses a DM buffer and sends
through its guarded `DirectTarget`; a conversation name is never treated as a send target. papo
owns splitting and `draft/multiline`, and `Sent` confirms every optimistic row.

The UI owns textarea geometry, the active completion session, focus, and per-buffer drafts. Drafts
are keyed by stable buffer ID in `sessionStorage`, so buffer switches and tab reloads survive while
devices and unrelated tabs do not share unsent text. The UI removes a draft only after submission
is accepted and keeps it on typed rejection.

Enter submits, Shift+Enter inserts a newline, and the send button submits the same path. All
composer shortcuts ignore `isComposing`, key code 229, `Dead`, and `Process`; composition events
close completion. Mobile textarea text is at least 16px. Up in an empty composer invokes
`message.select-last` from 14 and never copies a prior message into the draft.

Server refusals, standard replies, and relevant numerics become typed notice projections in the
affected buffer (or server buffer when no chat buffer exists). UI code does not classify protocol
lines.

## Testing

Parser tables cover every command, missing arguments, unknown commands, whitespace, and multiline
text. Scripted papo wire tests cover command lines, `Sent` confirmation, splitting, and correlated
standard-reply/numeric refusals. Completion tests cover activity order, casemapping, and replace
ranges. Component tests cover Enter/Shift+Enter, Tab cycling, drafts, empty-Up, and IME. Playwright
uses local Ergo for plain send, `/me`, `/join`, `/msg`, nick completion, reload/switch drafts, and
the native-feel idle/hidden audits; light and dark completion screenshots are inspected.

## Decisions

- Keep drafts UI-owned in `sessionStorage`; they are ephemeral input state, not IRC/domain state.
- Submit all input through the engine parser so ordinary text and slash commands share validation
  and acknowledgement behavior.
- Fetch completion candidates per token and cycle the returned list locally.
- Surface server command failures as buffer notice rows with typed stable fields.
- Let papo own multiline framing and confirm optimistic output from `Sent`, never echo matching.
- Defer typing notifications; correct throttling and stop/idle transitions are not trivial.

## Later

Typing notifications, uploads, reply/edit affordances, command history, persisted/cross-device
drafts, and slash commands beyond this milestone. The registry may replace temporary engine-only
descriptor IDs when corresponding product actions are designed.

## Questions

- Should future durable drafts roam through an account service, or remain device-local storage?
- Should `/topic` with no text query the current topic once a topic-query projection is designed?
