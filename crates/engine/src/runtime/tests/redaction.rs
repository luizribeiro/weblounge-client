use std::{sync::Arc, time::Duration};

use super::{
    EngineRequest, EngineRequestEnvelope, EngineToUi, HISTORY_CAPS, REACTION_CAPS, ReplayHarness,
    Runtime, changed_messages, collect, event_timeline_messages, fetch_history, harness,
    known_channel, line_label, lock, next_matching, next_sent_containing, process_event,
    process_history, register_with_caps, request_label, send_history_page, wire,
};
use crate::{
    BufferId, EngineMessageKey, MessageId, MessageKind, MessageProjection, OwnChangeDelivery,
    Redaction,
};

const REDACTION_CAPS: [&str; 3] = ["message-tags", "server-time", "draft/message-redaction"];

async fn deliver(
    wire: &mut papo_testing::Wire,
    events: &mut papo::Events,
    process: impl Fn(papo::Event),
    line: &str,
) {
    wire.server(line).await;
    let event = next_matching(events, |event| {
        matches!(
            event,
            papo::Event::Message(_) | papo::Event::Redacted(_) | papo::Event::Reacted(_)
        )
    })
    .await;
    process(event);
}

fn latest<'a>(messages: &'a [MessageProjection], msgid: &str) -> &'a MessageProjection {
    messages
        .iter()
        .rev()
        .find(|message| message.server_ids.iter().any(|id| id == msgid))
        .expect("the row is projected")
}

fn redacted(by: Option<&str>) -> MessageKind {
    MessageKind::Redacted(Redaction {
        by: by.map(str::to_owned),
    })
}

#[tokio::test]
async fn live_redactions_tombstone_channel_and_direct_rows() {
    let (client, mut events, mut wire) =
        wire(papo::Client::builder("irc://offline.test", "weblounge").autojoin(["#room"]));
    wire.register(&REDACTION_CAPS).await;
    _ = next_matching(&mut events, |event| {
        matches!(event, papo::Event::Connected(_))
    })
    .await;
    assert!(wire.next_sent().await.ends_with("JOIN #room"));
    wire.server(":weblounge!u@host JOIN #room").await;
    let joined = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
    let (state, outbound, mut receiver) = harness(client.clone());
    process_event(&state, &outbound, &client, 1, joined);
    _ = collect(&mut receiver);
    let process = |event| {
        process_event(&state, &outbound, &client, 1, event);
    };

    for line in [
        "@msgid=c1;time=2026-11-14T12:00:00.000Z :alice!a@host PRIVMSG #room :weblounge: secret",
        "@msgid=c2;time=2026-11-14T12:00:01.000Z :bob!b@host PRIVMSG #room :spam",
        "@msgid=d1;time=2026-11-14T12:00:02.000Z :alice!a@host PRIVMSG weblounge :private",
        "@msgid=r1;time=2026-11-14T12:00:03.000Z :Alice!a@host REDACT #room c1",
        "@msgid=r2;time=2026-11-14T12:00:04.000Z :op!o@host REDACT #room c2 :spam",
        "@msgid=r3;time=2026-11-14T12:00:05.000Z :alice!a@host REDACT weblounge d1",
    ] {
        deliver(&mut wire, &mut events, process, line).await;
    }

    let output = collect(&mut receiver);
    for msgid in ["c1", "c2", "d1"] {
        assert!(output.iter().any(|event| matches!(
            event,
            EngineToUi::MessageRedacted { msgids } if msgids == &[msgid.to_owned()]
        )));
    }
    let messages = changed_messages(&output)
        .into_iter()
        .map(|(_, message)| message)
        .collect::<Vec<_>>();
    let own_redaction = latest(&messages, "c1");
    assert_eq!(own_redaction.kind, redacted(None));
    assert_eq!(own_redaction.text, "");
    assert!(!own_redaction.highlighted);
    assert_eq!(latest(&messages, "c2").kind, redacted(Some("op")));
    assert_eq!(latest(&messages, "d1").kind, redacted(None));

    for line in [
        "@msgid=r4;time=2026-11-14T12:00:06.000Z :alice!a@host REDACT #room c1",
        "@+draft/react=👍;+draft/reply=c1 :bob!b@host TAGMSG #room",
    ] {
        deliver(&mut wire, &mut events, process, line).await;
    }
    assert!(changed_messages(&collect(&mut receiver)).is_empty());

    for line in [
        "@msgid=r5;time=2026-11-14T12:00:07.000Z :bob!b@host REDACT weblounge d2",
        "@msgid=d2;time=2026-11-14T12:00:08.000Z :bob!b@host PRIVMSG weblounge :early",
    ] {
        deliver(&mut wire, &mut events, process, line).await;
    }
    let output = collect(&mut receiver);
    let messages = changed_messages(&output)
        .into_iter()
        .map(|(_, message)| message)
        .collect::<Vec<_>>();
    assert_eq!(latest(&messages, "d2").kind, redacted(None));
    assert!(
        !output
            .iter()
            .any(|event| matches!(event, EngineToUi::NotifiableMessageReceived { .. }))
    );
    let bob = output
        .iter()
        .rev()
        .find_map(|event| match event {
            EngineToUi::BufferUpdated { buffer } if buffer.title == "bob" => Some(buffer),
            _ => None,
        })
        .expect("bob's conversation is projected");
    assert_eq!((bob.unread, bob.mentions), (0, 0));
}

#[tokio::test]
async fn history_redactions_tombstone_earlier_and_later_rows() {
    let (client, mut events, mut wire) =
        wire(papo::Client::builder("irc://offline.test", "weblounge").autojoin(["#room"]));
    register_with_caps(
        &mut wire,
        &format!("{HISTORY_CAPS} draft/message-redaction"),
    )
    .await;
    _ = next_matching(&mut events, |event| {
        matches!(event, papo::Event::Connected(_))
    })
    .await;
    assert!(wire.next_sent().await.ends_with("JOIN #room"));
    wire.server(":weblounge!u@host JOIN #room").await;
    let joined = next_matching(&mut events, |event| matches!(event, papo::Event::Joined(_))).await;
    let (state, outbound, mut receiver) = harness(client.clone());
    let fetch_request = process_event(&state, &outbound, &client, 1, joined)
        .pop()
        .expect("joined channel requests history");
    let fetch_client = client.clone();
    let fetch = tokio::spawn(async move { fetch_history(&fetch_client, fetch_request).await });
    let request = wire.next_sent().await;
    send_history_page(
        &mut wire,
        request_label(&request),
        &[
            "time=2026-11-14T12:00:00.000Z;msgid=h1 :alice!a@host PRIVMSG #room :before",
            "time=2026-11-14T12:00:01.000Z;msgid=r1 :alice!a@host REDACT #room h1",
            "time=2026-11-14T12:00:02.000Z;msgid=r2 :op!o@host REDACT #room h2",
            "time=2026-11-14T12:00:03.000Z;msgid=h2 :alice!a@host PRIVMSG #room :after",
            "time=2026-11-14T12:00:04.000Z;msgid=h3 :alice!a@host PRIVMSG #room :kept",
        ],
    )
    .await;
    let page = fetch
        .await
        .expect("history task completes")
        .expect("history request succeeds");
    process_history(&state, &outbound, &client, 1, page);

    let messages = changed_messages(&collect(&mut receiver))
        .into_iter()
        .map(|(_, message)| message)
        .collect::<Vec<_>>();
    assert_eq!(latest(&messages, "h1").kind, redacted(None));
    assert_eq!(latest(&messages, "h2").kind, redacted(Some("op")));
    assert_eq!(latest(&messages, "h3").text, "kept");
}

const OWN_REDACTION_CAPS: &str =
    "message-tags echo-message server-time labeled-response batch draft/message-redaction";

impl ReplayHarness {
    async fn own_room_message(&mut self, msgid: &str, text: &str) -> (BufferId, MessageId) {
        self.wire
            .server(format!(
                "@time=2026-10-27T13:01:00.000Z;msgid={msgid} :weblounge!u@host PRIVMSG #room :{text}"
            ))
            .await;
        _ = self.timeline_output(&[text]).await;
        let state = lock(&self.state);
        let model = &state
            .network
            .as_ref()
            .expect("network remains active")
            .model;
        let buffer_id = model
            .buffer_id_for_channel(&known_channel(&self.client, "#room"))
            .expect("channel buffer");
        let message_id = model
            .projected_messages(buffer_id)
            .into_iter()
            .find(|message| message.text == text)
            .expect("own message")
            .id;
        (buffer_id, message_id)
    }

    fn redact(&self, buffer_id: BufferId, message_id: MessageId) -> Vec<EngineToUi> {
        Runtime {
            state: Arc::clone(&self.state),
            outbound: self.outbound.clone(),
        }
        .request(EngineRequestEnvelope {
            id: "redact".into(),
            request: EngineRequest::RedactMessage {
                buffer_id,
                message_id,
            },
        })
    }

    async fn message_until(
        &mut self,
        message_id: MessageId,
        accept: impl Fn(&MessageProjection) -> bool,
    ) -> (MessageProjection, Vec<EngineToUi>) {
        let mut output = Vec::new();
        let message = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let event = self.receiver.recv().await.expect("runtime remains active");
                let found = event_timeline_messages(&event)
                    .into_iter()
                    .find(|message| message.id == message_id && accept(message))
                    .cloned();
                output.push(event);
                if let Some(message) = found {
                    return message;
                }
            }
        })
        .await
        .expect("the message projection arrives");
        (message, output)
    }
}

fn own_redaction(events: &[EngineToUi], message_id: MessageId) -> Option<OwnChangeDelivery> {
    events
        .iter()
        .flat_map(event_timeline_messages)
        .find(|message| message.id == message_id)
        .and_then(|message| message.own_redaction)
}

// TODO(papo-0.1 reaction-confirm): papo resolves `redact` from its labeled ACK today, so this
// proves confirmation from that resolution; once papo returns the confirming REDACT, assert it.
#[tokio::test]
async fn own_redaction_tombstones_once_papo_resolves_it() {
    let mut harness = ReplayHarness::joined(OWN_REDACTION_CAPS).await;
    let (buffer_id, message_id) = harness.own_room_message("mine", "take this back").await;

    let output = harness.redact(buffer_id, message_id);

    assert_eq!(
        own_redaction(&output, message_id),
        Some(OwnChangeDelivery::Sending)
    );
    assert!(matches!(
        harness.redact(buffer_id, message_id).as_slice(),
        [EngineToUi::CommandRejected { .. }]
    ));
    let sent = next_sent_containing(&mut harness.wire, "REDACT").await;
    assert!(sent.ends_with("REDACT #room mine"), "{sent}");
    harness
        .wire
        .server(format!("@label={} :offline.test ACK", line_label(&sent)))
        .await;
    harness
        .wire
        .server("@time=2026-10-27T13:02:00.000Z;msgid=r1 :weblounge!u@host REDACT #room mine")
        .await;
    let (redacted, _) = harness
        .message_until(message_id, |message| {
            matches!(message.kind, MessageKind::Redacted(_))
        })
        .await;
    assert_eq!(redacted.kind, MessageKind::Redacted(Redaction { by: None }));
    assert_eq!((redacted.text.as_str(), redacted.own_redaction), ("", None));

    harness
        .wire
        .server(":louro!l@host PRIVMSG #room :after")
        .await;
    let after = harness.timeline_output(&["after"]).await;
    assert!(
        event_timeline_messages_for(&after, message_id).is_empty(),
        "the echo changes nothing"
    );
    assert!(matches!(
        harness.redact(buffer_id, message_id).as_slice(),
        [EngineToUi::CommandRejected { .. }]
    ));
    harness.drain.abort();
}

fn event_timeline_messages_for(
    events: &[EngineToUi],
    message_id: MessageId,
) -> Vec<MessageProjection> {
    events
        .iter()
        .flat_map(event_timeline_messages)
        .filter(|message| message.id == message_id)
        .cloned()
        .collect()
}

#[tokio::test]
async fn refused_own_redaction_keeps_the_message_and_retries() {
    let mut harness = ReplayHarness::joined(OWN_REDACTION_CAPS).await;
    let (buffer_id, message_id) = harness.own_room_message("mine", "keep this").await;

    _ = harness.redact(buffer_id, message_id);
    let sent = next_sent_containing(&mut harness.wire, "REDACT").await;
    harness
        .wire
        .server(format!(
            "@label={} :offline.test FAIL REDACT REDACT_FORBIDDEN #room mine :nope",
            line_label(&sent)
        ))
        .await;

    let (failed, output) = harness
        .message_until(message_id, |message| {
            message.own_redaction == Some(OwnChangeDelivery::Failed)
        })
        .await;
    assert_eq!(
        (failed.kind, failed.text.as_str()),
        (MessageKind::Text, "keep this")
    );
    let mut later = output;
    later.extend(collect(&mut harness.receiver));
    assert!(later.iter().any(|event| matches!(
        event,
        EngineToUi::Notice { key, .. } if key == EngineMessageKey::RedactFailed.as_str()
    )));
    let retried = harness.redact(buffer_id, message_id);
    assert_eq!(
        own_redaction(&retried, message_id),
        Some(OwnChangeDelivery::Sending)
    );
    harness.drain.abort();
}

#[tokio::test]
async fn another_users_message_cannot_be_redacted() {
    let mut harness = ReplayHarness::joined(OWN_REDACTION_CAPS).await;
    let (buffer_id, theirs) = harness.live_room_message("theirs", "not mine").await;

    let output = harness.redact(buffer_id, theirs);

    harness.drain.abort();
    assert!(matches!(
        output.as_slice(),
        [EngineToUi::CommandRejected { .. }]
    ));
}

#[tokio::test]
async fn own_message_cannot_be_redacted_without_the_capability() {
    let mut harness = ReplayHarness::joined(REACTION_CAPS).await;
    let (buffer_id, mine) = harness.own_room_message("mine", "no cap").await;

    let output = harness.redact(buffer_id, mine);

    harness.drain.abort();
    assert!(matches!(
        output.as_slice(),
        [EngineToUi::CommandRejected { .. }]
    ));
}

#[tokio::test]
async fn network_offers_redaction_only_with_labeled_responses() {
    for (caps, expected) in [
        (OWN_REDACTION_CAPS, true),
        ("message-tags server-time draft/message-redaction", false),
    ] {
        let mut harness = ReplayHarness::joined(caps).await;
        let network = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let EngineToUi::NetworkStateChanged { network } = harness
                    .receiver
                    .recv()
                    .await
                    .expect("runtime remains active")
                    && network.state == crate::NetworkConnectionState::Online
                {
                    return network;
                }
            }
        })
        .await
        .expect("the network projection arrives");
        assert_eq!(network.can_redact, expected, "{caps}");
        harness.drain.abort();
    }
}

fn latest_buffer<'a>(events: &'a [EngineToUi], title: &str) -> &'a crate::BufferProjection {
    events
        .iter()
        .rev()
        .find_map(|event| match event {
            EngineToUi::BufferUpdated { buffer } if buffer.title == title => Some(buffer),
            _ => None,
        })
        .expect("the conversation is projected")
}

#[tokio::test]
async fn deleting_unread_messages_rewrites_the_preview_counts_and_snapshot() {
    let (client, mut events, mut wire) =
        wire(papo::Client::builder("irc://offline.test", "weblounge"));
    wire.register(&REDACTION_CAPS).await;
    _ = next_matching(&mut events, |event| {
        matches!(event, papo::Event::Connected(_))
    })
    .await;
    let (state, outbound, mut receiver) = harness(client.clone());
    let process = |event| {
        process_event(&state, &outbound, &client, 1, event);
    };
    for line in [
        "@msgid=p1;time=2026-11-14T12:00:00.000Z :carol!c@host PRIVMSG weblounge :older",
        "@msgid=p2;time=2026-11-14T12:00:01.000Z :carol!c@host PRIVMSG weblounge :newer",
    ] {
        deliver(&mut wire, &mut events, process, line).await;
    }
    let before_deletion = lock(&state)
        .network
        .as_ref()
        .expect("network remains active")
        .model
        .chat_list_snapshot("fingerprint".into());
    assert_eq!(latest_buffer(&collect(&mut receiver), "carol").unread, 2);

    deliver(
        &mut wire,
        &mut events,
        process,
        "@msgid=r1;time=2026-11-14T12:00:02.000Z :carol!c@host REDACT weblounge p2",
    )
    .await;
    let after_one = collect(&mut receiver);
    let carol = latest_buffer(&after_one, "carol");
    assert_eq!(
        (carol.unread, carol.mentions, carol.preview.as_deref()),
        (1, 1, Some("older"))
    );
    assert_eq!(carol.last_activity_ms, Some(1_794_657_601_000));

    deliver(
        &mut wire,
        &mut events,
        process,
        "@msgid=r2;time=2026-11-14T12:00:03.000Z :carol!c@host REDACT weblounge p1",
    )
    .await;
    let carol = latest_buffer(&collect(&mut receiver), "carol").clone();
    assert_eq!(
        (carol.unread, carol.preview.as_deref()),
        (0, Some("Message deleted"))
    );

    let state = lock(&state);
    let model = &state
        .network
        .as_ref()
        .expect("network remains active")
        .model;
    let merged = model.merge_chat_list_snapshot("fingerprint".into(), &before_deletion);
    let row = merged
        .rows
        .iter()
        .find(|row| row.title == "carol")
        .expect("carol's row");
    assert!(row.stubs.is_empty(), "{:?}", row.stubs);
    assert_eq!(row.redacted_stubs.len(), 2);
    assert_eq!(row.preview.as_deref(), Some("Message deleted"));
}
