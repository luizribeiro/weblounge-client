# 17 — Capability model

Status: proposed for milestone 1 review.

## Problem

IRC networks differ substantially. Controls must exist only when their operation is supported, and
support can change after connection through `CAP NEW/DEL`, ISUPPORT, tag-denial policy, or a new
connection generation. Scattered capability strings and UI `if` statements would drift from
papo's negotiation and allow broken actions.

The engine therefore converts papo's typed feature model into product-level availability and
concrete action witnesses. The UI renders available actions, not guesses from capability names.
Capability state is per network and per connection generation.

## Source of truth: papo

The engine reads only public papo APIs:

- `State::supports(Feature)` and `State::features()` for current optional behavior;
- `State::caps()` for diagnostics and capability values that have no product feature;
- `State::isupport()` for server tokens such as `draft/ICON` and bot mode;
- `Event::Connected`, `CapsChanged`, `FeaturesChanged`, `CasemappingChanged`, and `Disconnected`;
- typed `Unsupported { feature, reason }` errors as final command validation.

Papo owns aliases (`draft/*` versus final names), dependencies, `CLIENTTAGDENY`, capability
negotiation, and the distinction among `NotOffered`, `DisabledByClient`, `TagDenied`, and
`LimitZero`. Weblounge never parses `CAP LS` or re-derives those rules.

Papo `Feature` values used by the product include `MessageTags`, `ServerTime`, `Batches`,
`EventPlayback`, `EchoMessages`, `Replies`, `Reactions`, `Typing`, `Redaction`, `Multiline`,
`History`, `ReadMarkers`, `Metadata`, `Monitor`, `BotMode`, `AccountCreation`, `ChannelRename`,
`LabeledResponse`, `Sasl`, presence/account tracking features, and—behind papo's unstable
feature—`Bouncer`, `Persistence`, `WebPush`, and `Relay`.

## Product feature types

```rust
pub struct CapabilitySnapshot {
    pub network_id: NetworkId,
    pub generation: ConnectionGeneration,
    pub negotiation: NegotiationState,
    pub features: BTreeMap<ProductFeature, FeatureAvailability>,
    pub diagnostics: CapabilityDiagnostics,
}

pub enum NegotiationState {
    Unknown,
    Negotiating,
    Current,
    Stale { disconnected_at: Timestamp },
}

pub enum ProductFeature {
    Backfill,
    ReadSync,
    Replies,
    Reactions,
    Typing,
    Multiline,
    Redaction,
    MetadataAvatars,
    NetworkIcon,
    Push,
    BouncerImport,
    AccountCreation,
    ChannelRename,
    Presence,
    BotIdentity,
}

pub enum FeatureAvailability {
    Available { evidence: FeatureEvidence },
    Unavailable { reason: UnavailableReason },
}

pub enum UnavailableReason {
    NotNegotiated,
    Disconnected,
    ServerDidNotOffer,
    DisabledByClient,
    TagDenied,
    ServerLimitZero,
    MissingObjectData(ObjectRequirement),
    PlatformUnavailable(PlatformRequirement),
}

pub enum FeatureEvidence {
    PapoFeature { feature: PapoFeatureName },
    All(Vec<FeatureEvidence>),
    Any(Vec<FeatureEvidence>),
    Isupport { token: IsupportToken },
    MessageField { field: MessageField },
    Platform { service: PlatformService },
}
```

`PapoFeatureName` is weblounge's exhaustive serializable mirror of the subset it consumes, not a
second capability implementation. The conversion takes `papo::Feature` and has an explicit
wildcard because `Feature` is non-exhaustive; unknown future values are included only in
diagnostics until deliberately mapped.

Availability from a prior generation becomes `Disconnected`, not `Available`. Rendered historical
content remains rich—stored replies and reactions still display—but no online-only action witness
is issued while disconnected. This prevents stale support from enabling a command.

## Derivation table

| Product feature | Required current evidence | Additional object/platform constraint |
|---|---|---|
| Backfill | `Feature::History` | Buffer has a history conversation target |
| Read sync | `Feature::ReadMarkers` | Entry has valid server time |
| Replies | `Feature::Replies` | Target message has `msgid` |
| Reactions | `Feature::Reactions` | Target has `msgid`; reaction is valid tag data |
| Typing | `Feature::Typing` | Chat buffer has send target |
| Multiline | `Feature::Multiline` | Outgoing text actually needs multiline semantics |
| Redaction | `Feature::Redaction` | Target has `msgid`; policy permits requesting it |
| Metadata avatars | `Feature::Metadata` | Advertised avatar key has a valid HTTPS value |
| Network icon | `draft/ICON` ISUPPORT value | Valid HTTPS image URL |
| Push | `Feature::WebPush` | Platform has registrar; user entitlement permits it |
| Bouncer import | `Feature::Bouncer` | Connection is an unbound control connection |
| Account creation | `Feature::AccountCreation` | Onboarding mode allows server registration |
| Channel rename | `Feature::ChannelRename` | Subject is a joined channel |
| Presence | any supported typed presence source | DM has a tracked peer identity |
| Bot identity | typed `UserSource::is_bot` / bot tag / bot mode | Actor fact is known |

Rendering received metadata is not gated by current capability state: if a stored event has a
reply parent or bot fact, the UI renders it even after disconnect or CAP removal. Capability gates
control discovery and actions, not whether true historical data is visible.

`EchoMessages`, `ServerTime`, `MessageTags`, `Batches`, and `LabeledResponse` are diagnostics and
engine-behavior inputs. They are not exposed as independent settings merely because the server
advertises them.

## Capability witnesses

Within Rust, action constructors require unforgeable current-generation witnesses:

```rust
pub struct CapabilityWitness<F> {
    network_id: NetworkId,
    generation: ConnectionGeneration,
    marker: PhantomData<F>,
}

pub struct ReplyFeature;
pub struct ReactionFeature;
pub struct ReadMarkerFeature;

pub struct ReplyTarget {
    pub buffer_id: ChatBufferId,
    pub message: MessageKeyWithId,
    capability: CapabilityWitness<ReplyFeature>,
}

pub fn reply_target(
    state: &EngineState,
    buffer: ChatBufferId,
    message: EventId,
) -> Result<ReplyTarget, CapabilityError>;

pub async fn send_reply(
    target: ReplyTarget,
    text: NonEmptyString,
) -> Result<SendReceipt, CommandError>;
```

Witness fields are private and cannot survive serialization or connection replacement. Command
handling recreates a witness from current state immediately before calling papo, so a UI command
queued across `CAP DEL` is rejected safely. Papo remains the final validator and can return typed
`Unsupported` if state changes between check and action.

The UI receives concrete action descriptors:

```ts
export type MessageActions = {
  readonly reply?: ReplyAction;
  readonly react?: ReactionAction;
  readonly redact?: RedactAction;
};

export interface ReplyAction {
  readonly kind: "reply";
  readonly command: ReplyCommandTemplate;
}

export interface ReactionAction {
  readonly kind: "react";
  readonly command: ReactionCommandTemplate;
}

export interface MessageRowProps {
  readonly message: MessageProjection;
  readonly actions: MessageActions;
}
```

Feature components do not import `CapabilitySnapshot`. `MessageRow` maps only supplied actions;
there is no “disabled reaction” control. Settings receives `NetworkSettingsActions`; onboarding
receives `ConnectionFeatureSummary`. The projection layer is the only UI module allowed to turn
capabilities into actions.

TypeScript command templates contain typed IDs and a capability epoch but are not permissions.
They improve component APIs; the engine always revalidates them.

## Capability epochs and updates

```rust
pub struct CapabilityEpoch {
    pub network: NetworkId,
    pub generation: ConnectionGeneration,
    pub revision: u64,
}

pub enum CapabilityChange {
    Replaced(CapabilitySnapshot),
    Invalidated { network_id: NetworkId, old: CapabilityEpoch },
}
```

`Connected` begins a new generation and publishes one complete snapshot after reading
`Client::state()`. `FeaturesChanged` or relevant ISUPPORT changes increment its revision and
replace the product projection atomically. `CapsChanged` alone updates diagnostics, then the engine
re-reads typed features rather than interpreting cap names. `Disconnected` invalidates every
witness at once and retains a stale diagnostic snapshot.

The UI patch replaces one network's capability projection and all affected action projections in
the same atomic batch. A control cannot remain visible for a frame after its prerequisite vanished.

## Onboarding and diagnostics

```rust
pub struct ConnectionFeatureSummary {
    pub supported: Vec<FeatureSummaryItem>,
    pub unavailable: Vec<FeatureSummaryItem>,
}

pub struct CapabilityDiagnostics {
    pub enabled_caps: Vec<CapabilityDiagnostic>,
    pub product_features: Vec<ProductFeatureDiagnostic>,
    pub isupport_icon: Option<String>,
}
```

The onboarding “This network supports” list is generated from stable product labels (history, read
sync, replies, reactions, push, and so on), not raw cap tokens. Diagnostics may show sanitized raw
cap names/values in the server buffer, because that is useful for debugging; capability values
known to contain secrets are redacted before storage or IPC.

Unavailable reasons are useful in onboarding/network settings when the user needs an explanation,
such as “Push requires a server or bouncer with webpush.” In normal chat chrome, unavailable
features are absent rather than disabled with a tooltip.

## Platform and entitlement composition

Some product features require both IRC support and a platform service. Product availability uses
an `All` evidence node; it does not pretend APNs/FCM registration is an IRC capability. For
example, native push requires current `Feature::WebPush`, a native push registrar, relay
configuration, and entitlement. Web PWA push requires browser Push API/service-worker readiness
instead of the relay entitlement.

Platform state is supplied through typed service availability. The capability reducer remains
pure and has no access to `window`, Tauri plugins, StoreKit, or Play Billing.

## Boundaries

This subsystem owns mapping typed papo features plus object/platform facts into product
availability, capability epochs, Rust witnesses, UI action projections, and human-readable feature
summaries. It must not negotiate CAP, inspect raw IRC lines, implement platform services, render
components, decide entitlements, or persist server capability state as permanently true.

## Testing

- Table-driven tests cover every derivation row and every papo `UnsupportedReason`.
- Compile-fail tests prove action APIs cannot be called without the correct witness or with a
  witness for another feature/network.
- Reducer tests cover connect, disconnect, reconnect generation, `CAP NEW/DEL`, ISUPPORT change,
  tag denial, and atomic action removal.
- Component contract tests verify unavailable action properties are absent, not disabled controls.
- Live tests run the feature matrix against all papo conformance server profiles and compare the
  onboarding summary with callable typed APIs.
- Race tests remove a capability between UI projection and command handling; the command is safely
  rejected and no raw request is sent.
- Snapshot golden tests prevent accidental renaming of protocol-facing product features and error
  reasons.

## Out of scope

Feature implementation, push registration, metadata/avatar fetching, payments, user overrides of
server capabilities, and UI layout are separate subsystems.

## Questions for Luiz / papo gaps

1. `draft/ICON` is available through generic ISUPPORT access but has no typed papo feature/value
   API. Should papo expose a validated network-icon URL, or should the engine continue treating it
   as a documented raw ISUPPORT exception?
2. Bouncer and Web Push product features require papo's unstable feature. Confirm whether the
   milestone may ship against those APIs or must wait for stabilization.
3. Which metadata key/value convention should define avatars across Ergo/soju? Papo exposes typed
   metadata but the product convention is not specified.
4. What exact server-side rule does weblounge use for mention matching in push payloads? The engine
   Activity/highlight capability must use the same rule; no independent approximation should ship.
5. Should a stale last-known feature list remain visible in network diagnostics while offline
   (proposed), clearly labelled as from the previous connection?
