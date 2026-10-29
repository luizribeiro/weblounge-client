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
