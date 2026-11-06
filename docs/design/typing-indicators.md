# Typing indicators

Status: approved for the typing-indicator slice requested by Luiz.

## Problem

Typing is transient IRC state, not timeline content. WebLounge must show papo's current typers in
channels and direct conversations and publish the local composer's state without duplicating
IRCv3 capability, expiry, casemapping, or recipient-safety logic. Repeated refreshes must neither
reflow the conversation nor make a polite live region chatter.

## Types

`TypingProjection { nick, nick_color_index, paused }` is the bounded UI form of a papo `Typer`.
`EngineToUi::TypingChanged { buffer_id, typers }` replaces the complete current projection for one
buffer. Empty `typers` clears it. The engine derives this list from `State::typing`; it does not
keep a second incoming typing table.

The existing `EngineRequest::CompleteInput` reports each user edit for completion and typing, so
the UI does not create a second input-observation path. The engine immediately discards the text
after classifying it as empty, slash-command, or message text. Its per-buffer outgoing state
machine retains only phase, generation, and pause deadline. A clock boundary makes the
three-second idle transition deterministic in tests.

## Boundaries and behaviour

Papo owns negotiation of `message-tags`, `CLIENTTAGDENY`, guarded direct targets, casemapping,
self-notification suppression, start order, bounds, message/departure clearing, six-second active
expiry, thirty-second paused expiry, and outgoing active throttling. On every
`TypingChanged` event, the engine looks up the conversation's buffer and projects papo's current
snapshot. Attaching another UI to the shared engine also receives current non-empty projections.

Active and paused users both remain visible because IRCv3 defines both as still composing until
their respective terminal condition. One user reads “ana is typing…”, two read “ana and bob are
typing…”, and three or more read “several people are typing…”. Each displayed nick uses the same
engine-projected palette index as messages and members. Own typing is never projected.

The engine treats a nonempty non-command edit as active, asks papo to publish `Active`, and replaces
that buffer's idle deadline. Papo silently drops active refreshes inside three seconds. Three
seconds without another edit publishes `Paused`. Emptying the field publishes `Done`; an accepted
message send publishes `Done` before it is queued. Inputs beginning with a single `/` do not
publish typing, while `//` remains literal message text. Unsupported, disconnected, unavailable,
or tag-denied targets produce no user-facing error and typing is never queued for reconnect.
Outgoing typing is on whenever the target supports it and has no user-facing off switch.

The UI owns only draft text, rendering, and edit observation. Both shells render one permanently
reserved line immediately above the composer, matching the prototype's 24px slot, so appearing or
clearing cannot move the transcript or composer. The line has `aria-live="polite"` and
`aria-atomic="true"`; equal text is not replaced on active refreshes. There is no typing animation,
so hidden pages have no decorative timer or animation to pause. Engine expiry and connection state
continue while hidden as required by the brief.

## Out of scope

Typing is not persisted, added to history, used for unread state, shown in server buffers, or
treated as delivery-critical. WebLounge does not provide a typing-privacy setting.

## Testing

Pure engine tests use a fake clock to cover independent per-buffer active, refresh, paused, done,
send, command, and expiry transitions. Papo wire tests at the engine boundary cover incoming
active/paused/done, message clearing, self suppression, multiple typers, and expiry projection.
Component tests cover wording, nick colours, the stable reserved slot, polite live semantics, and
unchanged text on refresh.

Playwright drives the built app against local Ergo with a second IRC client. It covers direct and
channel indicators; done, message, and clock-driven expiry clearing; outgoing throttled active and
done-on-send. The touched desktop/mobile specs and `nativeFeelAudit`, including idle and hidden
checks, remain green.
