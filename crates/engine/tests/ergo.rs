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

    let optimistic = engine.handle(UiToEngine::Request(EngineRequestEnvelope {
        id: "send".into(),
        request: EngineRequest::SendMessage {
            buffer_id,
            text: "integration hello".into(),
        },
    }));
    assert!(optimistic.iter().any(|event| matches!(
        event,
        EngineToUi::MessagesAppended { messages, .. }
            if messages.iter().any(|message| {
                message.text == "integration hello"
                    && message.delivery == weblounge_engine::MessageDelivery::Optimistic
            })
    )));

    tokio::time::timeout(Duration::from_secs(15), async {
        loop {
            match events.recv().await {
                Some(EngineToUi::MessageConfirmed { message, .. })
                    if message.text == "integration hello" =>
                {
                    assert_eq!(
                        message.delivery,
                        weblounge_engine::MessageDelivery::Confirmed
                    );
                    assert!(!message.server_ids.is_empty());
                    break;
                }
                Some(_) => {}
                None => panic!("engine event stream closed before send confirmation"),
            }
        }
    })
    .await
    .expect("Ergo confirms the sent message");
}
