//! Real-server smoke coverage for the local Nix Ergo fixture.

use std::{env, time::Duration};

use weblounge_engine::{
    BufferKind, Engine, EngineRequest, EngineRequestEnvelope, EngineToUi, SaslCredentials,
    UiToEngine,
};

#[tokio::test]
async fn connects_joins_and_confirms_a_message_against_ergo() {
    let Ok(endpoint) = env::var("WEBLOUNGE_ERGO_URL") else {
        return;
    };
    let (reader, mut reader_events) = connect_reader(&endpoint).await;
    let (engine, mut events) = Engine::with_events("integration", "engine-ergo");
    let connected = engine.handle(UiToEngine::Request(EngineRequestEnvelope {
        id: "connect".into(),
        request: EngineRequest::Connect {
            label: "Local Ergo".into(),
            endpoint,
            nickname: "weblounge".into(),
            sasl: SaslCredentials {
                account: "weblounge".into(),
                password: "weblounge-test".into(),
            },
            autojoin: vec!["#weblounge-test".into()],
            allow_insecure: true,
        },
    }));
    assert!(connected.iter().any(|event| matches!(
        event,
        EngineToUi::NetworkStateChanged { network }
            if network.state == weblounge_engine::NetworkConnectionState::Connecting
    )));

    let buffer_id = tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match events.recv().await {
                Some(EngineToUi::BufferAdded { buffer })
                    if buffer.kind == BufferKind::Channel && buffer.title == "#weblounge-test" =>
                {
                    break buffer.id;
                }
                Some(_) => {}
                None => panic!("engine event stream closed before autojoin"),
            }
        }
    })
    .await
    .expect("Ergo autojoin completes");

    let text = concat!(
        "During the overnight deployment, operators watched every regional queue and ",
        "confirmed that each notification reached its intended recipient before continuing. "
    )
    .repeat(5);
    assert!(text.len() > 512);
    let optimistic = engine.handle(UiToEngine::Request(EngineRequestEnvelope {
        id: "send".into(),
        request: EngineRequest::SendMessage {
            buffer_id,
            text: text.clone(),
        },
    }));
    assert!(optimistic.iter().any(|event| matches!(
        event,
        EngineToUi::MessagesAppended { messages, .. }
            if messages.iter().any(|message| {
                message.text == text
                    && message.delivery == weblounge_engine::MessageDelivery::Optimistic
            })
    )));

    let received = receive_weblounge_message(&mut reader_events).await;
    assert_eq!(received.text, text);
    assert!(!received.text.contains('\n'));

    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match events.recv().await {
                Some(EngineToUi::MessageConfirmed { message, .. }) => {
                    assert_eq!(message.text, text);
                    assert_eq!(
                        message.delivery,
                        weblounge_engine::MessageDelivery::Confirmed
                    );
                    assert!(!message.server_ids.is_empty());
                    assert!(!message.text.contains('\n'));
                    break;
                }
                Some(_) => {}
                None => panic!("engine event stream closed before send confirmation"),
            }
        }
    })
    .await
    .expect("Ergo confirms the sent message");
    reader
        .quit("multiline regression complete")
        .await
        .expect("second client quits cleanly");
}

#[tokio::test]
async fn production_profile_pages_always_on_history_paths() {
    let Ok(endpoint) = env::var("WEBLOUNGE_ERGO_PRODUCTION_URL") else {
        return;
    };
    let (first, mut first_events) = connect_account(
        &endpoint,
        "weblounge",
        "weblounge",
        "weblounge-test",
        "#lounge",
    )
    .await;
    wait_for_own_join(&mut first_events, "weblounge", "#lounge").await;
    first
        .quit("always-on history setup")
        .await
        .expect("first device quits cleanly");

    let (bot, mut bot_events) = connect_account(
        &endpoint,
        "history-bot",
        "weblounge-bot",
        "weblounge-bot-test",
        "#lounge",
    )
    .await;
    wait_for_own_join(&mut bot_events, "history-bot", "#lounge").await;
    verify_mixed_history(&bot).await;
    verify_history_paging(&bot).await;
    bot.quit("history seeded").await.expect("bot quits cleanly");

    let (fresh, mut fresh_events) = connect_account(
        &endpoint,
        "weblounge",
        "weblounge",
        "weblounge-test",
        "#lounge",
    )
    .await;
    wait_for_own_join(&mut fresh_events, "weblounge", "#lounge").await;
    fresh
        .quit("fresh profile verified")
        .await
        .expect("fresh device quits cleanly");
}

async fn verify_mixed_history(bot: &papo::Client) {
    let suffix = time_suffix();
    let first_text = format!("missed first {suffix}");
    let second_text = format!("missed second {suffix}");
    let multiline = format!("missed multiline {suffix} {}", "x".repeat(600));
    let notice_text = format!("missed notice {suffix}");
    for text in [&first_text, &second_text, &multiline] {
        bot.privmsg("#lounge", text)
            .await
            .expect("bot message is confirmed");
    }
    bot.notice("#lounge", &notice_text)
        .await
        .expect("bot notice is confirmed");
    tokio::time::sleep(Duration::from_secs(1)).await;

    let latest = bot
        .history("#lounge")
        .latest()
        .limit(3)
        .await
        .expect("latest history is available");
    let oldest = latest
        .oldest_reference()
        .expect("latest history has a paging cursor");
    let before = bot
        .history("#lounge")
        .before(oldest)
        .limit(100)
        .await
        .expect("older history is available");
    let messages = before
        .chat_messages()
        .chain(latest.chat_messages())
        .filter(|message| message.text.contains(&suffix))
        .collect::<Vec<_>>();
    assert_eq!(messages.len(), 3);
    assert_eq!(messages[0].text, first_text);
    assert_eq!(messages[1].text, second_text);
    assert_eq!(messages[2].text, multiline);
    assert!(messages.iter().all(|message| message.server_time.is_some()));
    assert!(latest.items.iter().any(|item| matches!(
        item,
        papo::Event::Notice(notice)
            if notice.text == notice_text && notice.server_time.is_some()
    )));
}

async fn verify_history_paging(bot: &papo::Client) {
    let paging_suffix = time_suffix();
    let expected = (0..1_025)
        .map(|index| format!("paging {paging_suffix} {index:04}"))
        .collect::<Vec<_>>();
    for text in &expected {
        bot.privmsg("#lounge", text)
            .await
            .expect("paging message is confirmed");
    }
    let mut page = bot
        .history("#lounge")
        .latest()
        .limit(100)
        .await
        .expect("latest paging history is available");
    let mut received = page
        .chat_messages()
        .filter(|message| message.text.contains(&paging_suffix))
        .map(|message| (message.text.clone(), message.msgid.clone()))
        .collect::<Vec<_>>();
    loop {
        let oldest = page
            .oldest_reference()
            .expect("a non-empty history page has a cursor");
        page = bot
            .history("#lounge")
            .before(oldest)
            .limit(100)
            .await
            .expect("older paging history is available");
        if page.items.is_empty() {
            break;
        }
        let older = page
            .chat_messages()
            .filter(|message| message.text.contains(&paging_suffix))
            .map(|message| (message.text.clone(), message.msgid.clone()))
            .collect::<Vec<_>>();
        received.splice(0..0, older);
    }
    assert_eq!(
        received.iter().map(|(text, _)| text).collect::<Vec<_>>(),
        expected.iter().collect::<Vec<_>>()
    );
    assert_eq!(
        received
            .iter()
            .filter_map(|(_, msgid)| msgid.as_ref())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        expected.len()
    );
}

fn time_suffix() -> String {
    papo::time::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock is after Unix epoch")
        .as_nanos()
        .to_string()
}

async fn connect_account(
    endpoint: &str,
    nickname: &str,
    account: &str,
    password: &str,
    channel: &str,
) -> (papo::Client, papo::Events) {
    papo::Client::builder(endpoint, nickname)
        .allow_insecure_auth(true)
        .sasl(papo::Sasl::plain(account, password))
        .autojoin([channel])
        .connect()
        .await
        .expect("papo client connects")
}

async fn wait_for_own_join(events: &mut papo::Events, nickname: &str, channel: &str) {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match events.next().await {
                Some(papo::Event::Joined(joined))
                    if joined.actor.nick() == nickname && joined.channel == channel =>
                {
                    break;
                }
                Some(papo::Event::ChannelSynced(synced)) if synced.channel == channel => break,
                Some(papo::Event::Disconnected(disconnected)) => {
                    panic!("client disconnected before join: {disconnected}");
                }
                Some(_) => {}
                None => panic!("client stopped before join"),
            }
        }
    })
    .await
    .expect("client joins the channel");
}

async fn connect_reader(endpoint: &str) -> (papo::Client, papo::Events) {
    let (reader, mut events) = papo::Client::builder(endpoint, "multiline-reader")
        .allow_insecure_auth(true)
        .sasl(papo::Sasl::plain("weblounge-bot", "weblounge-bot-test"))
        .autojoin(["#weblounge-test"])
        .connect()
        .await
        .expect("second client connects to Ergo");
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match events.next().await {
                Some(papo::Event::Joined(joined))
                    if joined.actor.nick() == "multiline-reader"
                        && joined.channel == "#weblounge-test" =>
                {
                    break;
                }
                Some(papo::Event::Disconnected(disconnected)) => {
                    panic!("second client disconnected: {disconnected}");
                }
                Some(_) => {}
                None => panic!("second client stopped before autojoin"),
            }
        }
    })
    .await
    .expect("second client joins the test channel");
    (reader, events)
}

async fn receive_weblounge_message(events: &mut papo::Events) -> papo::Message {
    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match events.next().await {
                Some(papo::Event::Message(message)) if message.actor.nick() == "weblounge" => {
                    break message;
                }
                Some(papo::Event::Disconnected(disconnected)) => {
                    panic!("second client disconnected: {disconnected}");
                }
                Some(_) => {}
                None => panic!("second client stopped before receiving the message"),
            }
        }
    })
    .await
    .expect("second client receives the long message")
}
