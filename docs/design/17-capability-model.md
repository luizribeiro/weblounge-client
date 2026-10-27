# 17 — Capability model

Status: revised for milestone 1 review.

## Problem

IRC support varies by network and can change after registration. Controls and commands must be
available only when their operation is currently valid, without scattering CAP strings or feature
checks through UI components.

Papo is the capability source of truth. The engine reads its typed state and projects concrete
network, buffer, and message actions. The UI renders supplied actions and never infers support.

## Papo inputs

The projector reads public APIs only:

- `State::supports(Feature)` and `State::features()` for optional behavior;
- `State::caps()` and `State::isupport()` for diagnostics and documented tokens without typed
  product APIs;
- `Connected`, `CapsChanged`, `FeaturesChanged`, `CasemappingChanged`, and `Disconnected` events;
- papo's typed `Unsupported { feature, reason }` as final command validation.

Papo owns aliases, dependencies, tag denial, CAP changes, and unsupported reasons. Weblounge never
parses CAP negotiation. At revision `7d5e4bf`, read markers and metadata are stable; `unstable`
gates bouncer, persistence, Web Push, and relay APIs.

## Product actions

```rust
pub struct NetworkActions {
    pub epoch: ConnectionEpoch,
    pub open_server_buffer: OpenServerBufferAction,
    pub import_bouncer: Option<ImportBouncerAction>,
    pub configure_push: Option<ConfigurePushAction>,
}

pub struct BufferActions {
    pub send: Option<SendAction>,
    pub mark_read: MarkReadAction,
    pub load_older: Option<LoadHistoryAction>,
    pub members: Option<OpenMembersAction>,
    pub complete_input: Option<CompleteInputAction>,
}

pub enum MarkReadAction {
    ServerSynced(MarkServerReadAction),
    LocalOnly(MarkLocalReadAction),
}

pub struct MessageActions {
    pub reply: Option<ReplyAction>,
    pub react: Option<ReactionAction>,
    pub redact: Option<RedactAction>,
}
```

Action values contain the typed IDs and command template required to invoke the operation. They are
not permissions: the engine re-reads current papo state immediately before every call, and papo is
the final validator if support changes concurrently.

Feature components accept these actions as props. A reaction button cannot be constructed without
a `ReactionAction`; it is absent rather than disabled. The command registry receives the focused
buffer's `BufferActions`, so switcher/menu/shortcut availability matches visible controls.

## Projection rules

| Product action/summary | Current papo support | Object/platform condition |
|---|---|---|
| Load history | `Feature::History` | Buffer has a history conversation target |
| Server-synced mark read | `Feature::ReadMarkers` | Target event has server time |
| Reply | `Feature::Replies` | Target has a selected server msgid |
| React/unreact | `Feature::Reactions` | Target has a server msgid and valid tag data |
| Typing | `Feature::Typing` | Chat buffer has a send target |
| Multiline send | `Feature::Multiline` | Outgoing input needs multiline semantics |
| Redact | `Feature::Redaction` | Target has a server msgid; product policy allows request |
| Metadata avatar | `Feature::Metadata` | `avatar` value is valid HTTPS content |
| Network icon | `draft/ICON` ISUPPORT | Value is valid HTTPS content |
| Push settings | `Feature::WebPush` | Registrar/configuration/entitlement are ready |
| Bouncer import | `Feature::Bouncer` | Connection is an unbound control connection |
| Presence | Typed presence source | DM peer identity is tracked |
| Bot presentation | Typed bot fact | Actor fact is known |

If read markers are unavailable, `mark_read` is explicitly `LocalOnly`; the engine-state model
therefore needs no duplicate `Unsupported` marker state. Platform and entitlement readiness are
ordinary inputs to action projection, not claimed as IRC capabilities.

Received facts remain renderable after disconnect or feature removal. Stored replies, reactions,
and bot identities do not disappear merely because the corresponding action is no longer
available.

## Updates and connection epochs

Subsystem 03 increments `ConnectionEpoch` on every `Connected`, including an internal papo
reconnect. The projector reads the fresh `Client::state()` and replaces all network/buffer/message
actions atomically. `FeaturesChanged` or relevant ISUPPORT changes trigger the same replacement;
`CapsChanged` updates diagnostics and then typed features are re-read.

On disconnect, online-only actions are removed in one patch. The last supported-feature summary
may remain in diagnostics labelled as stale, but it cannot enable a command. Actions belong to the
current epoch and are never persisted as durable truth.

No parallel capability state machine is kept outside the connection's `Online` projection.

## Onboarding and diagnostics

Onboarding receives stable product labels such as history, read sync, replies, reactions, and
push. It does not display raw CAP names as product features.

Diagnostics may include sanitized CAP names/values and the documented raw `draft/ICON` ISUPPORT
exception. Values that may contain secrets are redacted before storage or IPC. Offline diagnostics
clearly label the last-known list with its connection epoch.

## Boundaries

This subsystem owns the pure projection from current typed papo state plus object/platform facts
to concrete actions and summaries. It does not negotiate CAP, parse raw IRC lines, implement
platform services, render UI, choose shortcut chords, or persist capability support as true.

## Testing

- Table tests cover every projection row and relevant papo unsupported reason.
- Reducer/projection tests cover connect, internal reconnect epochs, disconnect, feature/ISUPPORT
  changes, tag denial, and atomic action removal.
- Component contracts verify unavailable controls and registry commands are absent.
- Race tests change support between projection and command handling and assert safe papo-backed
  rejection.
- Native transcript tests use a real papo client over `papo_testing::wire()`'s scripted in-memory
  pipe; unpublished `papo` and `papo-testing` are pinned to the same git revision. Live tests use
  subsystem 21's small local nixpkgs Ergo fixture, not a packaged papo test server.
- Snapshot fixtures protect public product-action and diagnostic names.

## Out of scope

Push registration, metadata fetching, payments, feature implementation, and capability override UI
belong to other subsystems.

## Later

- Consider private capability witness types, evidence trees, and compile-fail tests only if simple
  action projections prove insufficient.
- Add bouncer and Web Push actions after the design-index `unstable` decision.

## Decisions

- Keep `draft/ICON` as a documented raw ISUPPORT exception until papo exposes a typed value.
- Use the metadata key `avatar` for user avatars.
- Retain a clearly labelled stale last-known feature list in offline diagnostics.
- Luiz, 2026-10-27: use native `papo_testing::wire()` for scripted capability transcripts and the
  repository's local Ergo only for small real-server coverage.

## Questions for Luiz

1. What exact mention-matching rule does the weblounge server use for push payloads? Activity and
   local highlighting must use the same rule.
