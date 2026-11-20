use super::{collect, harness, lock, next_matching, process_event, wire};
use crate::{BufferKind, BufferProjection, EngineToUi};

struct Session {
    client: papo::Client,
    events: papo::Events,
    wire: papo_testing::Wire,
    state: std::sync::Arc<std::sync::Mutex<super::RuntimeState>>,
    outbound: tokio::sync::mpsc::UnboundedSender<EngineToUi>,
    receiver: tokio::sync::mpsc::UnboundedReceiver<EngineToUi>,
}

impl Session {
    async fn connected() -> Self {
        let (client, mut events, mut wire) =
            wire(papo::Client::builder("irc://offline.test", "luiz"));
        wire.register(&["echo-message", "message-tags", "server-time"])
            .await;
        _ = next_matching(&mut events, |event| {
            matches!(event, papo::Event::Connected(_))
        })
        .await;
        let (state, outbound, receiver) = harness(client.clone());
        Self {
            client,
            events,
            wire,
            state,
            outbound,
            receiver,
        }
    }

    async fn deliver(&mut self, line: &str, wanted: impl Fn(&papo::Event) -> bool) {
        self.wire.server(line).await;
        let event = next_matching(&mut self.events, wanted).await;
        process_event(&self.state, &self.outbound, &self.client, 1, event);
        _ = collect(&mut self.receiver);
    }

    fn buffers(&self) -> Vec<BufferProjection> {
        let state = lock(&self.state);
        let model = &state
            .network
            .as_ref()
            .expect("network remains active")
            .model;
        match model.buffers_event() {
            EngineToUi::BuffersChanged { buffers, .. } => buffers,
            other => panic!("expected the buffer list, got {other:?}"),
        }
    }

    fn assert_only_direct_with(&self, peer: &str) {
        let conversations: Vec<_> = self
            .buffers()
            .into_iter()
            .filter(|buffer| buffer.kind != BufferKind::Server)
            .map(|buffer| (buffer.kind, buffer.title))
            .collect();
        assert_eq!(conversations, [(BufferKind::Direct, peer.to_owned())]);
    }
}

fn message(event: &papo::Event) -> bool {
    matches!(event, papo::Event::Message(_) | papo::Event::Notice(_))
}

#[tokio::test]
async fn peer_lines_to_our_nick_open_the_peer_direct() {
    for line in [
        "@msgid=a;time=2026-11-19T12:00:00.000Z :iris!i@host PRIVMSG luiz :hi",
        "@bot;msgid=i;time=2026-11-19T12:00:00.000Z :iris!i@host PRIVMSG luiz :beep",
        "@msgid=b;time=2026-11-19T12:00:00.000Z :iris!i@host PRIVMSG Luiz :hi",
        "@msgid=c;time=2026-11-19T12:00:00.000Z :iris!i@host NOTICE luiz :hi",
        "@msgid=d;time=2026-11-19T12:00:00.000Z :iris!i@host PRIVMSG luiz :\u{1}ACTION waves\u{1}",
    ] {
        let mut session = Session::connected().await;
        session.deliver(line, message).await;
        session.assert_only_direct_with("iris");
    }
}

#[tokio::test]
async fn our_echo_to_a_peer_opens_the_peer_direct() {
    let mut session = Session::connected().await;
    session
        .deliver(
            "@msgid=e;time=2026-11-19T12:00:00.000Z :luiz!l@host PRIVMSG iris :hi from my phone",
            message,
        )
        .await;
    session.assert_only_direct_with("iris");
}

#[tokio::test]
async fn a_message_to_ourselves_is_a_direct_not_a_channel() {
    let mut session = Session::connected().await;
    session
        .deliver(
            "@msgid=f;time=2026-11-19T12:00:00.000Z :luiz!l@host PRIVMSG luiz :note to self",
            message,
        )
        .await;
    session.assert_only_direct_with("luiz");
}

#[tokio::test]
async fn peer_tags_to_our_nick_open_no_channel() {
    let mut session = Session::connected().await;
    session
        .deliver(
            "@msgid=g;time=2026-11-19T12:00:00.000Z :iris!i@host PRIVMSG luiz :hi",
            message,
        )
        .await;
    session
        .deliver(
            "@+draft/react=👍;+draft/reply=g :iris!i@host TAGMSG luiz",
            |event| matches!(event, papo::Event::Reacted(_)),
        )
        .await;
    session
        .deliver("@+typing=active :iris!i@host TAGMSG luiz", |event| {
            matches!(event, papo::Event::TypingChanged(_))
        })
        .await;
    session.assert_only_direct_with("iris");
}

#[tokio::test]
async fn a_peer_line_after_our_nick_changes_opens_the_peer_direct() {
    let mut session = Session::connected().await;
    session
        .deliver(":luiz!l@host NICK luiz_away", |event| {
            matches!(event, papo::Event::NickChanged(_))
        })
        .await;
    session
        .deliver(
            "@msgid=h;time=2026-11-19T12:00:00.000Z :iris!i@host PRIVMSG luiz_away :hi",
            message,
        )
        .await;
    session.assert_only_direct_with("iris");
}
