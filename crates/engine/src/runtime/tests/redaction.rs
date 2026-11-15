use super::{
    EngineToUi, HISTORY_CAPS, changed_messages, collect, fetch_history, harness, next_matching,
    process_event, process_history, register_with_caps, request_label, send_history_page, wire,
};
use crate::{MessageKind, MessageProjection, Redaction};

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

    let messages = changed_messages(&collect(&mut receiver))
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
