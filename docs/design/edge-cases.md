# Engine edge cases (from papo's maintainer)

A checklist of situations a papo-based engine must handle, gathered from building papo and running its conformance suite against six servers (papo main 7d5e4bf). Items marked *soon* depend on papo changes in flight.

Every engine task that touches one of these areas adds a test for the relevant items, normally with `papo-testing`'s `wire()` scripted server.

## Messages

1. **Optimistic sends are confirmed by `Sent`, not by an echo.** papo does not emit this connection's own echo. `client.privmsg(..).await` resolves to `Sent { msgids, server_time }`; confirm the pending row from that.
2. **One send can become several lines.** Without `draft/multiline`, long text is split and `Sent::msgids` has one id per line (other clients see several rows). `redact(&sent)` removes all of them, stopping at the first error.
3. **Your own lines from other devices** (weblounge is always-on and multi-device) arrive as normal events with `authorship == Authorship::Own`. They are not duplicates of a local `Sent`.
4. **Dedup key is msgid, but msgid can be missing** (no message-tags, some server notices). Fallback key: (conversation, server_time, actor nick, text). Never key on received time.
5. **Ordering:** sort by `server_time`, falling back to received time only for lines without it. History `items` come in server delivery order, which isn't guaranteed to be chronological. Never mix the device's "now" into server ordering.
6. **Untrusted text:** `text`, topics and reasons are sanitized for display (C0/C1/ESC removed). To render IRC formatting, subsystem 11 parses `raw_text` with papo's own parser (`papo_proto::formatting`: `Formatted`, `Span`, `Style`, `Color`) instead of writing one, and maps the spans to a safe AST.

## Reconnect and lag

7. **Reconnect** is `Connected { reconnected: true }` on the same `Client`. State survives, and channels re-sync (`ChannelSynced` again). With `Builder::history_on_reconnect(true)`, papo fetches each channel's gap as `HistoryPage { reason: HistoryReason::Catchup }` and dedups against live lines. Bouncer playback is `HistoryReason::Replay`. The engine still dedups, because pages can overlap stored scrollback.
8. **Lagged:** if `Events` isn't drained, papo drops the oldest events and emits `Event::Lagged { dropped }`. On Lagged, resync membership, topic and modes from `client.state()`, and refetch history for open buffers. Drain `Events` from the moment `build()` returns; until papo removes it (*soon*), falling behind while connecting ends the attempt with `DisconnectCause::SlowConsumer`.
9. **Don't reconnect yourself.** Close reasons surface as `DisconnectCause::{ConnectionLost, Server, PingTimeout}` (browsers hide TLS failures behind WebSocket code 1006). papo's reconnect policy retries; the engine surfaces state.
10. **Timeouts:** `Error::Timeout` means "no answer in time", not "didn't happen". Solanum and soju sometimes don't complete labelled responses (LIST, PART, TOPIC, multi-channel NAMES). Never auto-retry KICK, MODE or redact.

## Names and identity

11. **Compare names with papo's types**, which fold with the server's casemapping. Build stored names with `state.name_rules()` (`nick()`, `channel()`, `account()`); `check_nick()` returns `NameCheck::{Valid, Invalid, Unknown}`, and it stays Unknown until the server's rules arrive.
12. **Names remember their casemapping.** Names built before ISUPPORT (005) don't equal post-005 names, so rebuild app-side maps on `Connected` and `CasemappingChanged`.
13. **PRECIS:** Ergo (weblounge) advertises UTF8MAPPING. It needs papo's `precis` feature; without it papo warns once and folds ASCII only. Enable `precis`.
14. **DM identity:** `Conversation::Private(nick)` is keyed by nick. Follow `NickChanged` (actor = old nick, `new`). **Merge DMs by account only when both sides are `Account::LoggedIn`**; LoggedOut or Unknown proves nothing.
15. **Nicks get reused.** Always answer via `reply()` / `return_address()`, which refuse with `TargetGone` if the nick changed hands. `Conversation` is not a send target.
16. **Ops-only lines** (`status: Some(prefix)`, e.g. `@#ops`): show a badge, and answer only via `reply(&m)` / `m.return_address()`, so the audience can't widen by accident.

## History and read markers

17. **Read markers are timestamp-based.** `mark_read` returns the server's marker. Servers keep the newest, so a device can't move it backwards. Other devices' moves arrive as `ReadMarkerChanged`. `State::read_marker` distinguishes never-fetched (`None`) from unset.
18. **weblounge DMs vanish on server restart** (DM history isn't persisted). An empty page does not mean the conversation is gone. soju returns an empty page for an unknown target, not an error.
19. **event-playback** puts JOIN, PART and similar events in history items; render or filter them deliberately.
20. Use **`CHATHISTORY TARGETS`** to rebuild the DM list.

## Membership

21. Member lists are capped (100k per channel) with a warning. Netsplits arrive as QUITs, grouped when the server batches them.
22. **`ChannelRenamed { old, new }`:** papo moves its own state; the engine must move its buffer keys. `Event::conversation()` (*soon*) routes any event to its buffer.

## Browser and wasm

23. **Keep `Client` and `Events` alive in the SharedWorker.** papo sends QUIT only when every `Client` and `Events` is dropped, so a closing tab must not drop them.
24. **Size:** the browser build is ~1 MB (core) / ~1.5 MB (full client) after `wasm-opt -Oz`. A size-optimized release profile (LTO, `opt-level = "z"`, one codegen unit, `panic = "abort"`) saves about 30%.
