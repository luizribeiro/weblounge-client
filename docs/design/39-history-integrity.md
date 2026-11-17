# 39 — History integrity

Status: test-suite design (2026-11-17), asked for by Luiz after B20, B27 and B28.

## Problem

B20 (a "Messages may be missing" gap that never backfills), B27 (a DM opened after a push shows
only the pushed line) and B28 (launch catch-up starting at another device's read mark) fail the
same way: the client believes its transcript is complete when it is not, and nothing on screen
says otherwise. Each fix shipped with a test for its own path. This suite checks the one invariant
that all of them broke, on every path that can break it.

## The invariant

For every buffer the user opens and scrolls back through to the start of server history:

1. **Transcript.** The transcript's message rows, read top to bottom, carry exactly the msgids the
   server's `CHATHISTORY` returns for that target, each once, in server-time order. (Not in the
   server's own sequence: Ergo can store a line a millisecond before an earlier-stamped one, and
   lines that share a millisecond may show in either order.) The only
   exception is an explicit gap row ("Messages may be missing"), and only while it is
   backfilling: the check waits for the transcript to match, so a gap that never fills fails it.
   Two row kinds are handled explicitly. A deleted message's tombstone row is the one allowed
   extra: Ergo drops a redacted message from history, so a tombstone passes only when its msgid is
   absent from `CHATHISTORY`. A pending own line (no msgid yet) fails the check.
2. **Chat list.** Before the buffer is opened, its row's unread count equals the number of other
   people's `PRIVMSG` and `NOTICE` lines in server history newer than the server's read marker for
   the target (all of them when there is no marker; reactions never count), shown as 99+ past 99
   and as no badge at zero. On the phone, where rows show a preview, the preview
   is the newest server message's text.

Rows other than message rows (days, joins, the new-messages divider, topic cards, local notices)
are not part of the comparison.

## Ground truth

- **Server history** comes from a raw IRC connection to the same local Ergo, logged in as the
  app's own account, so it sees exactly what the app's `CHATHISTORY` sees (channel history and
  the account's DM history). It is opened only for the check, never sends `MARKREAD` with a
  timestamp or joins anything, and closes afterwards. It sends `CHATHISTORY LATEST <target> * 100`, then `BEFORE` the
  oldest msgid until a page comes back short, and keeps `PRIVMSG` and `NOTICE` lines (msgid,
  time, author, text). `IrcClient.chathistory` in `app/e2e/irc-client.ts`.
- **Read marker** comes from `MARKREAD <target>` on that connection.
- **Transcript** comes from the page: each message row carries `data-msgids` (its papo server ids,
  space-separated), a new attribute on `MessageRow` in `MessageList.tsx`; rows already carry the
  virtualizer's `data-index`. The reader scrolls the transcript to the top through the normal load-older
  behaviour until the start-of-history row shows, waiting on the oldest row changing (never on
  time), then sweeps the virtualized list top to bottom and collects rows by `data-index`.
- One shared assertion, `expectTranscriptMatchesServer(page, truth, target)` in
  `app/e2e/history-integrity.ts`, polls until the two lists are equal and otherwise fails with
  the missing, extra, duplicate and out-of-order msgids and any gap rows.

## Scenarios

All run against the local Ergo with always-on accounts, as production does, on desktop Chromium
and the iPhone WebKit profile (`app/e2e/history-integrity.spec.ts`). Each asserts the chat-list
row before opening and the transcript after, for every buffer involved.

| Scenario | Path it covers | Bug |
| --- | --- | --- |
| Two devices share one read marker; one reads ahead while the other is closed, then the closed one relaunches. | launch catch-up cursor | B28 (fixed) |
| Lines arrive while the app is closed; relaunch from the cached chat list, with and without pushed lines drained into the cache. | snapshot restore, push merge | B27 |
| Closed, or open but offline, for longer than one catch-up page (more than 100 lines). | bounded catch-up gap | B20 (open app) |
| The connection drops before the launch catch-up request goes out, or as its reply arrives. | restarted and failed catch-up | B27 follow-up |
| Many lines across several channels and DMs while the page is hidden. | busy launch, per-buffer pages | |
| A DM opened from the ⌘K switcher after a live line created it. | live-seeded DM window | B27 |
| Own lines queued while offline, then sent on reconnect. | send ordering | B26 |
| Deletions and reactions mixed into the history. | redaction tombstones, TAGMSG pages | |

Server-side control: more than 100 lines are sent by test peers before the relaunch; a dropped
connection and a failed or stalled catch-up use the existing socket forwarder and the
history-wire test hooks (`app/e2e/forwarder.ts`, `app/e2e/history-wire-fixture.ts`).

A scenario that still fails because its bug is open is marked `test.fail()` with the bug's ID, so
CI stays green and the test starts failing (and the annotation comes off) once the fix lands.

## Engine property test

`crates/engine/src/runtime/tests/history_integrity.rs` drives the engine runtime over papo's test
wire against a scripted server that answers `CHATHISTORY` from an oracle message list. Proptest
generates interleavings of history before the join, live lines arriving while the latest or an
older page is in flight, other devices' read markers, older-page loads and server page caps
smaller than the engine's request; after each run the test pages back to the start and checks
that the buffer's message rows are exactly the oracle, once each and in order, with no gap row
(on one connection nothing can be missed). Proptest's regression file keeps failing seeds
reproducible. The test wire is one connection, so reconnects, relaunches and pushed lines, the
paths where a gap row is legitimate, are left to the browser scenarios.

## Out of scope

- Fixing B20 (another branch); B28 is fixed on the base branch. New bugs this suite finds go
  into the plan's backlog.
- Multiline batches, whose msgid belongs to the batch rather than its lines.
- Ergo's persistent history and history expiry.
